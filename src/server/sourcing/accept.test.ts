/** Accepting and dismissing candidates, against a real SQLite file; the enrichment it queues is faked. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allColumns, discoverySchema } from "../../shared/schema";
import type { Candidate, CandidateContact, DiscoveryRun } from "../../shared/sourcing";
import { CHECKED, type CampaignSchema } from "../../shared/types";
import * as ai from "../ai";
import { updateAiSettings } from "../ai/settings";
import * as db from "../db";
import * as enrichStore from "../enrich/store";
import { acceptCandidates, dismissCandidates, ensureDiscoveryColumns, restoreCandidates } from "./accept";
import { enqueueEnrichment, enrichQueueIdle } from "./enrichQueue";
import * as store from "./store";

const realAi = { ...ai };
let fakeTurn: ((req: ai.StructuredRequest<unknown>) => Promise<{ data: unknown; costUsd: number | null }>) | null = null;
void mock.module("../ai", () => ({
  ...realAi,
  generateStructured: (req: ai.StructuredRequest<unknown>) => (fakeTurn ? fakeTurn(req) : realAi.generateStructured(req)),
}));

let dir = "";
const prevDir = process.env.MUDD_DATA_DIR;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-accept-"));
  db.closeDb();
  process.env.MUDD_DATA_DIR = dir;
  updateAiSettings({ provider: "claude" });
});
afterAll(() => {
  fakeTurn = null;
  db.closeDb();
  if (prevDir === undefined) delete process.env.MUDD_DATA_DIR;
  else process.env.MUDD_DATA_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const key = (schema: CampaignSchema, header: string) => allColumns(schema).find((c) => c.header === header)!.key;

function campaign(schema = discoverySchema(), enrich = { presets: [] as string[], recipeIds: [] as string[], autoFill: false }): string {
  const c = db.createCampaign({ name: "Disco", schema, sheets: [], thesis: { answers: { offer: "SOC", avatar: "Manufacturers" }, drafted: [] } });
  const now = Date.now();
  const run: DiscoveryRun = {
    id: `run-${c.id}`, campaignId: c.id, kind: "find", status: "done", stage: "done", provider: "claude", model: "sonnet", concurrency: 2, target: 5, perCompany: 3, focus: null,
    enrich, drafted: [], angles: [], candidateIds: [], jobs: {}, found: 0, ready: 0, disqualified: 0, failed: 0, costUsd: null, startedAt: now, finishedAt: now, error: null,
  };
  store.saveDiscoveryRun(run);
  return c.id;
}

let n = 0;
const person = (name: string, type: string | null, extra: Partial<CandidateContact> = {}): CandidateContact => ({
  id: `p${++n}`, name, title: "IT Director", type, dealRole: `${name} starts it`, gain: "Sleep", angle: "Assess", linkedin: `https://linkedin.com/in/${n}`, source: `https://example.com/team/${n}`, confidence: "high", ...extra,
});
function candidate(campaignId: string, company: string, contacts: CandidateContact[], extra: Partial<Candidate> = {}): Candidate {
  const now = Date.now();
  const c: Candidate = {
    id: `c${++n}`, campaignId, runId: `run-${campaignId}`, status: "ready", company, website: `https://${company.toLowerCase().replace(/[^a-z]/g, "")}.com`, location: "Austin, TX", employees: 400,
    fit: "High", whyFit: "Fits well", whyNow: "Hiring", budget: "IT budget", clock: "FY June", sources: [{ url: "https://lists.example/a", title: "Angle" }], contacts, firstContact: null, angle: "Angle",
    error: null, dismissReason: null, rowId: null, createdAt: now, updatedAt: now, ...extra,
  };
  store.saveCandidates([c]);
  return c;
}

describe("accept", () => {
  test("IDs skip the reserved ones; intel, sources and the people land in their columns; the right person is Primary", async () => {
    const schema = discoverySchema();
    schema.reservedIds = ["P-002"];
    const id = campaign(schema);
    db.insertRows(id, [{ id: "p1", cells: { [schema.idKey!]: "P-001", [schema.companyKey!]: "Existing" } }]);
    const ann = person("Ann Lee", "End User");
    const bob = person("Bob Ray", "Champion");
    const cy = person("Cy Dee", "Economic Buyer");
    const c = candidate(id, "Acme Metal", [ann, bob, cy]);
    const res = acceptCandidates(id, [{ id: c.id, contactIds: [ann.id, bob.id, cy.id] }]);
    await enrichQueueIdle(id);
    const s = res.campaign.schema;
    const [org, ...people] = res.rows;
    expect(org!.cells[s.idKey!]).toBe("P-003");
    expect(org!.cells).toMatchObject({
      [s.companyKey!]: "Acme Metal", [key(s, "Website")]: "https://acmemetal.com", [key(s, "Location")]: "Austin, TX", [key(s, "# Employees")]: 400,
      [key(s, "Fit")]: "High", [key(s, "Why they fit")]: "Fits well", [key(s, "Why now")]: "Hiring", [key(s, "Budget source")]: "IT budget", [key(s, "Buying clock")]: "FY June",
      [key(s, "Source")]: "Discovery", [s.statusKey!]: "Not contacted",
    });
    expect(org!.cells[key(s, "Enrichment sources")]).toBe(`Company: https://lists.example/a\nAnn Lee: ${ann.source}\nBob Ray: ${bob.source}\nCy Dee: ${cy.source}`);
    expect(people.map((p) => [p.cells[s.contacts!.nameKey!], p.cells[s.contacts!.typeKey!], p.cells[s.contacts!.primaryKey!] ?? null, p.parentId])).toEqual([
      ["Ann Lee", "End User", null, org!.id], ["Bob Ray", "Champion", CHECKED, org!.id], ["Cy Dee", "Economic Buyer", null, org!.id],
    ]);
    expect(people[0]!.cells).toMatchObject({ [key(s, "Role")]: "IT Director", [key(s, "LinkedIn")]: ann.linkedin, [key(s, "Role in deal")]: "Ann Lee starts it", [key(s, "What they gain")]: "Sleep", [key(s, "Angle")]: "Assess" });
    expect(res.candidates).toMatchObject([{ id: c.id, status: "accepted", rowId: org!.id }]);
    expect(db.listRows(id)).toHaveLength(2);
    expect(db.contactsOf(id, org!.id)).toHaveLength(3);
  });

  test("only the ticked contacts come along; the one to approach first is Primary", () => {
    const id = campaign();
    const ann = person("Ann Lee", "Champion");
    const bob = person("Bob Ray", "Economic Buyer");
    const c = candidate(id, "Beta Forge", [ann, bob], { firstContact: bob.id });
    const res = acceptCandidates(id, [{ id: c.id, contactIds: [bob.id] }]);
    const s = res.campaign.schema;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[1]!.cells[s.contacts!.nameKey!]).toBe("Bob Ray");
    expect(res.rows[1]!.cells[s.contacts!.primaryKey!]).toBe(CHECKED);
  });

  test("a deleted intel column is added back once, and a removed Champion option restored", () => {
    const id = campaign();
    const c = db.getCampaign(id)!;
    const cs = c.schema.contacts!;
    const typeCol = cs.columns.find((x) => x.key === cs.typeKey)!;
    db.updateCampaign(id, {
      schema: {
        ...c.schema,
        columns: c.schema.columns.filter((x) => x.header !== "Why now"),
        contacts: { ...cs, columns: cs.columns.filter((x) => x.header !== "Angle").map((x) => (x === typeCol ? { ...x, options: x.options!.filter((o) => o !== "Champion") } : x)) },
      },
    });
    // The deleted column's values are still on a row: the new column must not inherit them.
    db.insertRows(id, [{ id: "old", cells: { why_now: "stale" } }]);
    const first = acceptCandidates(id, [{ id: candidate(id, "One", [person("Ann", "Champion")]).id, contactIds: [] }]);
    const second = acceptCandidates(id, [{ id: candidate(id, "Two", []).id, contactIds: [] }]);
    const s = second.campaign.schema;
    expect(s.columns.filter((x) => x.header === "Why now")).toHaveLength(1);
    // Appended after the user's columns, on a key the deleted column's values are not under.
    const whyNow = s.columns.find((x) => x.header === "Why now")!;
    expect(whyNow).toMatchObject({ key: "why_now_2", origin: "discovery" });
    expect(s.columns.indexOf(whyNow)).toBeGreaterThan(s.columns.findIndex((x) => x.header === "Screened reason"));
    expect(s.contacts!.columns.filter((x) => x.header === "Angle")).toHaveLength(1);
    expect(s.contacts!.columns.find((x) => x.key === s.contacts!.typeKey)!.options).toContain("Champion");
    expect(first.rows[0]!.cells.why_now_2).toBe("Hiring");
    expect(second.rows[0]!.cells.why_now_2).toBe("Hiring");
    expect(ensureDiscoveryColumns(id).schema.columns).toHaveLength(s.columns.length);
  });

  test("a duplicate found at accept time is dismissed, naming the prospect it repeats", () => {
    const id = campaign();
    const s = db.getCampaign(id)!.schema;
    db.insertRows(id, [{ id: "p1", cells: { [s.idKey!]: "P-012", [s.companyKey!]: "Acme, Inc.", [key(s, "Website")]: "acme.com" } }]);
    const byName = candidate(id, "ACME", [], { website: null });
    const byDomain = candidate(id, "Something Else", [], { website: "https://www.acme.com/about" });
    const res = acceptCandidates(id, [{ id: byName.id, contactIds: [] }, { id: byDomain.id, contactIds: [] }]);
    expect(res.rows).toEqual([]);
    expect(res.candidates.map((c) => [c.status, c.dismissReason])).toEqual([["dismissed", "Already in the list as P-012"], ["dismissed", "Already in the list as P-012"]]);
  });

  test("the enrichment queue runs each chosen preset's recipe on the new rows, one run after another", async () => {
    const id = campaign(discoverySchema(), { presets: ["snapshot", "email"], recipeIds: [], autoFill: true });
    const prompts: { rows: string; keys: string[] }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    fakeTurn = async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(5);
      inFlight--;
      const keys = [...req.prompt.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]!);
      prompts.push({ rows: /"Company":"([^"]+)"/.exec(req.prompt)?.[1] ?? "", keys });
      return { data: { fields: Object.fromEntries(keys.map((k) => [k, { value: null, source: null, confidence: "low" }])), notes: null }, costUsd: null };
    };
    const a = candidate(id, "Alpha", [person("Ann", "Champion")]);
    const b = candidate(id, "Bravo", [person("Bob", "Champion")]);
    acceptCandidates(id, [{ id: a.id, contactIds: a.contacts.map((p) => p.id) }]);
    acceptCandidates(id, [{ id: b.id, contactIds: b.contacts.map((p) => p.id) }]);
    await enrichQueueIdle(id);
    fakeTurn = null;
    const recipes = enrichStore.listRecipes(id);
    expect(recipes.map((r) => r.presetId).sort()).toEqual(["email", "snapshot"]);
    const runs = enrichStore.listRuns(id);
    expect(runs.every((r) => r.status === "done")).toBe(true);
    // Alpha's accept started a run per preset; Bravo's, accepted while they ran, got its own after.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.length).toBeLessThanOrEqual(4);
    expect(new Set(runs.flatMap((r) => r.rowIds)).size).toBe(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(prompts.map((p) => p.rows).sort()).toEqual(["Alpha", "Alpha", "Bravo", "Bravo"]);
  });

  test("a recipe deleted before its turn in the queue is skipped; the batch's other recipes still run", async () => {
    const id = campaign();
    const s = db.getCampaign(id)!.schema;
    const [row] = db.insertRows(id, [{ cells: { [s.companyKey!]: "Alpha" } }]);
    const recipe = enrichStore.saveRecipe({ campaignId: id, name: "Kept", instructions: "Find it.", inputKeys: [], webSearch: false, outputs: [{ key: key(s, "Location"), header: "Location" }] });
    fakeTurn = async (req) => {
      const keys = [...req.prompt.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]!);
      return { data: { fields: Object.fromEntries(keys.map((k) => [k, { value: null, source: null, confidence: "low" }])), notes: null }, costUsd: null };
    };
    enqueueEnrichment(id, [row!.id], ["gone", recipe.id], false);
    await enrichQueueIdle(id);
    fakeTurn = null;
    expect(enrichStore.listRuns(id).map((r) => [r.recipeId, r.status])).toEqual([[recipe.id, "done"]]);
  });

  test("dismiss keeps the reason; restore brings it back", () => {
    const id = campaign();
    const c = candidate(id, "Gamma", [person("Ann", "Champion")]);
    expect(dismissCandidates(id, [c.id], "  Too big  ")).toMatchObject([{ status: "dismissed", dismissReason: "Too big" }]);
    expect(restoreCandidates(id, [c.id])).toMatchObject([{ status: "ready", dismissReason: null }]);
    const unmapped = candidate(id, "Delta", []);
    dismissCandidates(id, [unmapped.id], null);
    expect(restoreCandidates(id, [unmapped.id])).toMatchObject([{ status: "error" }]);
  });
});
