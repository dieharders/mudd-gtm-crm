/**
 * The Discovery engine against a real SQLite file in a temp directory, with every agent turn
 * faked: thesis drafts, search plans, companies found along an angle, and buying committees.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverySchema } from "../../shared/schema";
import type { Candidate, DiscoveryRun } from "../../shared/sourcing";
import type { ThesisId } from "../../shared/types";
import * as ai from "../ai";
import { updateAiSettings } from "../ai/settings";
import * as db from "../db";
import { dismissCandidates } from "./accept";
import { liveDiscovery, pauseDiscovery, resumeDiscovery, startDiscovery, stopDiscovery } from "./runner";
import * as store from "./store";

const realAi = { ...ai };
type Turn = (req: ai.StructuredRequest<unknown>) => Promise<{ data: unknown; costUsd: number | null }>;
let fakeTurn: Turn | null = null;
void mock.module("../ai", () => ({
  ...realAi,
  generateStructured: (req: ai.StructuredRequest<unknown>) => (fakeTurn ? fakeTurn(req) : realAi.generateStructured(req)),
}));

let dir = "";
const prevDir = process.env.MUDD_DATA_DIR;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-discovery-"));
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

const ANSWERS: Partial<Record<ThesisId, string>> = { offer: "24/7 security monitoring for mid-size manufacturers", avatar: "US manufacturers with 200–2,000 staff" };

function campaign(answers = ANSWERS): string {
  return db.createCampaign({ name: "Disco", schema: discoverySchema(), sheets: [], thesis: { answers, drafted: [] } }).id;
}

type Kind = "thesis" | "plan" | "find" | "map";
const kindOf = (req: ai.StructuredRequest<unknown>): Kind =>
  req.prompt.startsWith("Task: the user is describing") ? "thesis" : req.prompt.startsWith("Task: plan") ? "plan" : req.prompt.startsWith("Task: search") ? "find" : "map";
const angleOf = (req: ai.StructuredRequest<unknown>) => /^Angle: (.+)$/m.exec(req.prompt)?.[1] ?? "";
const companyOf = (req: ai.StructuredRequest<unknown>) => /"company":"([^"]+)"/.exec(req.prompt)?.[1] ?? "";

/** A fake agent: one handler per kind of turn. */
function agent(handlers: Partial<Record<Kind, (req: ai.StructuredRequest<unknown>) => unknown>>): { calls: Record<Kind, number> } {
  const calls: Record<Kind, number> = { thesis: 0, plan: 0, find: 0, map: 0 };
  fakeTurn = async (req) => {
    const kind = kindOf(req);
    calls[kind]++;
    // Drafting nothing is the default: most tests are about what comes after.
    const h = handlers[kind] ?? (kind === "thesis" ? () => ({ answers: {} }) : undefined);
    if (!h) throw new Error(`unexpected ${kind} turn`);
    await Bun.sleep(0);
    return { data: h(req), costUsd: 0.01 };
  };
  return { calls };
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const found = (name: string, extra: Record<string, unknown> = {}) => ({
  company: name, website: `https://${slug(name)}.com`, location: "Austin, TX", employees: 400, fit: "High", whyFit: `${name} fits`, whyNow: "Hiring a security lead",
  budget: "IT budget", clock: "FY ends June", source: `https://lists.example/${slug(name)}`, ...extra,
});
const person = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name, title: "IT Director", type, dealRole: "Starts the search", gain: "Sleeps at night", angle: "Offer an assessment",
  linkedin: `https://linkedin.com/in/${slug(name)}`, source: `https://example.com/team/${slug(name)}`, confidence: "high", ...extra,
});
const mapped = (contacts: unknown[], firstContact: number | null = 0, extra: Record<string, unknown> = {}) => ({
  disqualify: null, contacts, firstContact, company: { fit: null, whyNow: null, budget: null, clock: null, employees: null, sources: [] }, ...extra,
});
const angles = (n: number) => ({ angles: Array.from({ length: n }, (_, i) => ({ label: `Angle ${i + 1}`, query: `Search ${i + 1}` })) });

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(2);
  }
}
const finished = (run: DiscoveryRun) => run.status === "done" || run.status === "failed" || run.status === "stopped";

describe("a Find run", () => {
  test("thesis → plan → find → map produces ready candidates, and drafts only the blank answers", async () => {
    const id = campaign({ ...ANSWERS, pains: "Ransomware scares" });
    const { calls } = agent({
      thesis: () => ({ answers: { pains: "OVERWRITTEN", fit: "We are the SOC", jobs: null, channels: "Association lists", exclude: "Fortune 500" } }),
      plan: () => angles(3),
      find: (req) => ({ companies: angleOf(req) === "Angle 1" ? [found("Acme Metal"), found("Beta Forge")] : angleOf(req) === "Angle 2" ? [found("Gamma Tool")] : [] }),
      map: (req) => mapped([person("Ann Lee", "Champion"), person("Bob Ray", "Economic Buyer")], 1, { company: { fit: "Medium", whyNow: `${companyOf(req)} is hiring`, budget: null, clock: null, employees: 450, sources: ["https://example.com/about"] } }),
    });
    const run = startDiscovery({ campaignId: id, kind: "find", target: 5, perCompany: 3, concurrency: 2 });
    expect(liveDiscovery(id)).toHaveLength(1);
    await until(() => finished(run));
    expect(run.status).toBe("done");
    expect(run.stage).toBe("done");
    expect(calls).toEqual({ thesis: 1, plan: 1, find: 3, map: 3 });
    expect(run.found).toBe(3);
    expect(run.ready).toBe(3);
    expect(run.angles.map((a) => [a.label, a.state, a.found])).toEqual([["Angle 1", "done", 2], ["Angle 2", "done", 1], ["Angle 3", "done", 0]]);
    expect(run.costUsd).toBeCloseTo(0.08);

    // The thesis: the user's answer stands, the blanks are filled and tagged as drafts.
    const thesis = db.getThesis(id)!;
    expect(thesis.answers.pains).toBe("Ransomware scares");
    expect(thesis.answers.fit).toBe("We are the SOC");
    expect(thesis.answers.jobs).toBeUndefined();
    expect(thesis.drafted).toEqual(["fit", "exclude", "channels"]);
    expect(run.drafted).toEqual(thesis.drafted);

    const ready = store.listCandidates(id, "ready");
    expect(ready.map((c) => c.company).sort()).toEqual(["Acme Metal", "Beta Forge", "Gamma Tool"]);
    const acme = ready.find((c) => c.company === "Acme Metal")!;
    expect(acme).toMatchObject({ fit: "Medium", whyNow: "Acme Metal is hiring", employees: 450, angle: "Angle 1", website: "https://acmemetal.com" });
    expect(acme.contacts.map((p) => [p.name, p.type])).toEqual([["Ann Lee", "Champion"], ["Bob Ray", "Economic Buyer"]]);
    expect(acme.firstContact).toBe(acme.contacts[1]!.id);
    expect(acme.sources.map((s) => s.url)).toEqual(["https://lists.example/acmemetal", "https://example.com/about", "https://example.com/team/annlee", "https://example.com/team/bobray"]);
    expect(store.getDiscoveryRun(run.id)).toEqual(run);
  });

  test("an answer typed while the draft turn runs is not overwritten", async () => {
    const id = campaign();
    agent({
      thesis: () => {
        db.patchThesis(id, { jobs: "Typed meanwhile" });
        return { answers: { jobs: "Drafted", pains: "Drafted pains" } };
      },
    });
    const run = startDiscovery({ campaignId: id, kind: "thesis" });
    await until(() => finished(run));
    const t = db.getThesis(id)!;
    expect(t.answers.jobs).toBe("Typed meanwhile");
    expect(t.answers.pains).toBe("Drafted pains");
    expect(t.drafted).toEqual(["pains"]);
    expect(run.drafted).toEqual(["pains"]);
  });

  test("duplicates are dropped: a prospect by another name, a dismissed candidate, a repeat across angles, a company with no source", async () => {
    const id = campaign();
    const c = db.getCampaign(id)!;
    const website = c.schema.columns.find((x) => x.header === "Website")!.key;
    db.insertRows(id, [{ id: "p1", cells: { [c.schema.companyKey!]: "Acme, Inc.", [website]: "acme.com" } }]);
    const now = Date.now();
    const dismissed: Candidate = {
      id: "old", campaignId: id, runId: "earlier", status: "dismissed", company: "Beta Forge", website: null, location: null, employees: null, fit: null,
      whyFit: null, whyNow: null, budget: null, clock: null, sources: [], contacts: [], firstContact: null, angle: null, error: null, dismissReason: "Too big", rowId: null, createdAt: now, updatedAt: now,
    };
    store.saveCandidates([dismissed]);
    const prompts: string[] = [];
    agent({
      plan: (req) => {
        prompts.push(req.prompt);
        return angles(4);
      },
      find: (req) => {
        prompts.push(req.prompt);
        const a = angleOf(req);
        if (a === "Angle 1") return { companies: [found("ACME", { website: "https://www.acme.com/" }), found("Beta Forge Ltd"), found("Gamma", { source: null }), found("Delta Dynamics")] };
        if (a === "Angle 2") return { companies: [found("Delta Dynamics Inc", { website: null }), found("Epsilon")] };
        return { companies: [] };
      },
      map: () => mapped([person("Ann Lee", "Champion")]),
    });
    const run = startDiscovery({ campaignId: id, kind: "find", target: 10, perCompany: 3, concurrency: 1 });
    await until(() => finished(run));
    expect(run.status).toBe("done");
    expect(store.listCandidates(id, "ready").map((x) => x.company).sort()).toEqual(["Delta Dynamics", "Epsilon"]);
    expect(run.found).toBe(2);
    // The dismissed one's reason is a negative example; every known company is on the exclusion list.
    expect(prompts[0]).toContain('"company":"Beta Forge","reason":"Too big"');
    expect(prompts[1]).toContain("Acme, Inc.");
    expect(prompts[1]).toContain("Beta Forge");
  });

  test("the target caps the count and skips the angles left; a disqualified company is dismissed", async () => {
    const id = campaign();
    const { calls } = agent({
      plan: () => angles(3),
      find: () => ({ companies: ["A", "B", "C", "D", "E", "F"].map((n) => found(`${n} Co`)) }),
      map: (req) => (companyOf(req) === "B Co" ? mapped([], null, { disqualify: "Has an in-house SOC" }) : mapped([person("Ann Lee", "champion"), person("Bob Ray", "ECONOMIC BUYER"), person("Cy Dee", "Unknown role")], 2)),
    });
    // One worker: with two, both would start an angle before the first one's companies came back.
    const run = startDiscovery({ campaignId: id, kind: "find", target: 5, perCompany: 5, concurrency: 1 });
    await until(() => finished(run));
    expect(run.status).toBe("done");
    expect(calls.find).toBe(1);
    expect(run.found).toBe(5);
    expect(run.angles.map((a) => a.state)).toEqual(["done", "skipped", "skipped"]);
    expect(run.disqualified).toBe(1);
    expect(run.ready).toBe(4);
    const b = store.listCandidates(id, "dismissed").find((c) => c.company === "B Co")!;
    expect(b.dismissReason).toBe("Disqualified: Has an in-house SOC");
    // Contact types are read against the dropdown, in any case; an unknown one is none.
    const a = store.listCandidates(id, "ready").find((c) => c.company === "A Co")!;
    expect(a.contacts.map((p) => p.type)).toEqual(["Champion", "Economic Buyer", null]);
    expect(a.firstContact).toBe(a.contacts[2]!.id);
  });

  test("a candidate dismissed while its map turn runs stays dismissed, with its reason", async () => {
    const id = campaign();
    agent({
      plan: () => angles(1),
      find: () => ({ companies: [found("A Co"), found("B Co")] }),
      map: (req) => {
        const c = store.listCandidates(id, "mapping").find((x) => x.company === companyOf(req))!;
        if (c.company === "A Co") dismissCandidates(id, [c.id], "Not for us");
        return mapped([person("Ann Lee", "Champion")], 0, c.company === "B Co" ? { disqualify: "Too small" } : {});
      },
    });
    const run = startDiscovery({ campaignId: id, kind: "find", target: 5, perCompany: 3, concurrency: 1 });
    await until(() => finished(run));
    expect(run.status).toBe("done");
    const a = store.listCandidates(id, "dismissed").find((c) => c.company === "A Co")!;
    expect(a.dismissReason).toBe("Not for us");
    // The map's result is still kept on it.
    expect(a.contacts.map((p) => p.name)).toEqual(["Ann Lee"]);
    expect(store.listCandidates(id, "ready")).toHaveLength(0);
    expect(run.ready).toBe(0);
    expect(run.disqualified).toBe(1);
  });

  test("pause holds both workers and resume wakes both; pause then stop ends the run", async () => {
    const id = campaign();
    const release: (() => void)[] = [];
    let finds = 0;
    fakeTurn = (req) => {
      if (kindOf(req) === "thesis") return Promise.resolve({ data: { answers: {} }, costUsd: null });
      if (kindOf(req) === "plan") return Promise.resolve({ data: angles(4), costUsd: null });
      finds++;
      return new Promise((resolve, reject) => {
        release.push(() => resolve({ data: { companies: [] }, costUsd: null }));
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const run = startDiscovery({ campaignId: id, kind: "find", target: 10, concurrency: 2 });
    await until(() => finds === 2);
    pauseDiscovery(run.id);
    release.splice(0).forEach((r) => r());
    await until(() => run.angles.filter((a) => a.state === "done").length === 2);
    await Bun.sleep(20);
    expect(finds).toBe(2);
    expect(run.status).toBe("paused");
    resumeDiscovery(run.id);
    await until(() => finds === 4);
    release.splice(0).forEach((r) => r());
    await until(() => finished(run));
    expect(run.status).toBe("done");

    finds = 0;
    const second = startDiscovery({ campaignId: id, kind: "find", target: 10, concurrency: 2 });
    await until(() => finds === 2);
    pauseDiscovery(second.id);
    release.splice(0).forEach((r) => r());
    await until(() => second.angles.filter((a) => a.state === "done").length === 2);
    stopDiscovery(second.id);
    await until(() => finished(second));
    expect(second.status).toBe("stopped");
    expect(second.angles.map((a) => a.state)).toEqual(["done", "done", "skipped", "skipped"]);
    expect(liveDiscovery(id)).toEqual([]);
    fakeTurn = null;
  });

  test("a missing CLI fails the run", async () => {
    const id = campaign();
    fakeTurn = () => Promise.reject(new realAi.AiError("cli_missing", "Claude Code isn't installed."));
    const run = startDiscovery({ campaignId: id, kind: "find", target: 5 });
    await until(() => finished(run));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Claude Code isn't installed.");
    fakeTurn = null;
  });

  test("refuses a campaign without a thesis, and a Find before the two required answers", () => {
    const plain = db.createCampaign({ name: "Plain", schema: discoverySchema(), sheets: [] });
    expect(() => startDiscovery({ campaignId: plain.id, kind: "find" })).toThrow(/campaigns created with it/);
    const thin = campaign({ offer: "Something" });
    expect(() => startDiscovery({ campaignId: thin, kind: "find" })).toThrow(/Who qualifies/);
    // Drafting the thesis is fine with just one answer.
    agent({ thesis: () => ({ answers: {} }) });
    expect(startDiscovery({ campaignId: thin, kind: "thesis" }).kind).toBe("thesis");
  });

  test("a map run maps candidates again, and a stopped run marks the companies it left", async () => {
    const id = campaign();
    const now = Date.now();
    const base: Candidate = {
      id: "c1", campaignId: id, runId: "r0", status: "error", company: "Zeta", website: "https://zeta.com", location: null, employees: null, fit: "High",
      whyFit: null, whyNow: null, budget: null, clock: null, sources: [{ url: "https://lists.example/zeta" }], contacts: [], firstContact: null, angle: null,
      error: "failed earlier", dismissReason: null, rowId: null, createdAt: now, updatedAt: now,
    };
    store.saveCandidates([base, { ...base, id: "c2", company: "Eta" }]);
    agent({ map: (req) => (companyOf(req) === "Zeta" ? mapped([person("Ann Lee", "Champion")]) : mapped([])) });
    const run = startDiscovery({ campaignId: id, kind: "map", candidateIds: ["c1", "c2", "missing"], perCompany: 3 });
    await until(() => finished(run));
    expect(run.status).toBe("done");
    expect(store.getCandidate(id, "c1")).toMatchObject({ status: "ready", error: null });
    expect(store.getCandidate(id, "c1")!.contacts).toHaveLength(1);
    expect(store.getCandidate(id, "c2")).toMatchObject({ status: "ready", contacts: [] });
    expect(run.jobs.missing).toMatchObject({ state: "skipped" });
  });

  test("runs and candidates left live when Mudd closed are marked", () => {
    const id = campaign();
    const now = Date.now();
    const run: DiscoveryRun = {
      id: "live", campaignId: id, kind: "find", status: "running", stage: "map", provider: "claude", model: "sonnet", concurrency: 2, target: 5, perCompany: 3, focus: null,
      enrich: { presets: [], recipeIds: [], autoFill: false }, drafted: [], angles: [{ id: "a", label: "A", query: "q", state: "running", found: 0 }], candidateIds: ["m"],
      jobs: { m: { state: "running" } }, found: 1, ready: 0, disqualified: 0, failed: 0, costUsd: null, startedAt: now, finishedAt: null, error: null,
    };
    store.saveDiscoveryRun(run);
    store.saveCandidates([{
      id: "m", campaignId: id, runId: "live", status: "mapping", company: "Mu", website: null, location: null, employees: null, fit: null, whyFit: null, whyNow: null,
      budget: null, clock: null, sources: [], contacts: [], firstContact: null, angle: null, error: null, dismissReason: null, rowId: null, createdAt: now, updatedAt: now,
    }]);
    store.markInterruptedDiscovery();
    const after = store.getDiscoveryRun("live")!;
    expect(after.status).toBe("stopped");
    expect(after.angles[0]!.state).toBe("skipped");
    expect(after.jobs.m!.state).toBe("skipped");
    expect(store.getCandidate(id, "m")).toMatchObject({ status: "error" });
  });
});
