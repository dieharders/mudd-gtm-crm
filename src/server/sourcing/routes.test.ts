/** Discovery through the REST API: making a Discovery campaign, what is refused where, and accepting. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candidate } from "../../shared/sourcing";
import type { Campaign, CampaignBundle, InspectResult, Row, Thesis } from "../../shared/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-discovery-routes-"));
const saved = { data: process.env.MUDD_DATA_DIR, home: process.env.HOME, profile: process.env.USERPROFILE };
let handler: (req: Request) => Promise<Response>;
let db: typeof import("../db");
let store: typeof import("./store");
let settings: typeof import("../ai/settings");

beforeAll(async () => {
  process.env.MUDD_DATA_DIR = path.join(tmp, "data");
  // Save file writes to Downloads under the home directory.
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  db = await import("../db");
  db.closeDb();
  store = await import("./store");
  settings = await import("../ai/settings");
  handler = (await import("../index")).createFetchHandler();
  settings.updateAiSettings({ provider: "claude", consented: false });
});
afterAll(() => {
  db.closeDb();
  process.env.MUDD_DATA_DIR = saved.data;
  process.env.HOME = saved.home;
  process.env.USERPROFILE = saved.profile;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async <T,>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handler(new Request(`http://127.0.0.1${url}`, init));
  return { status: res.status, json: (await res.json()) as T };
};

const newDiscovery = async (name = "Disco") =>
  (await call<Campaign>("POST", "/api/campaigns", { name, layout: "discovery", thesis: { offer: "SOC monitoring", avatar: "Manufacturers" } })).json;

describe("Discovery campaigns", () => {
  test("New campaign → Discover prospects makes the layout and the thesis, which the bundle returns", async () => {
    const c = await newDiscovery();
    const headers = c.schema.columns.map((x) => x.header);
    expect(headers).toEqual(expect.arrayContaining(["Company", "Website", "Fit", "Why they fit", "Why now", "Budget source", "Buying clock", "Status", "Source"]));
    expect(headers).not.toContain("Rank");
    expect(c.schema.columns.find((x) => x.header === "Fit")).toMatchObject({ type: "select", options: ["High", "Medium", "Low"], origin: "discovery" });
    expect(c.schema.contacts!.columns.map((x) => x.header)).toEqual(expect.arrayContaining(["Role in deal", "What they gain", "Angle"]));
    const bundle = (await call<CampaignBundle>("GET", `/api/campaigns/${c.id}`)).json;
    expect(bundle.thesis).toMatchObject({ campaignId: c.id, answers: { offer: "SOC monitoring", avatar: "Manufacturers" }, drafted: [] });
    // The two answers are required.
    expect((await call("POST", "/api/campaigns", { name: "x", layout: "discovery", thesis: { offer: "only this" } })).status).toBe(400);
  });

  test("a generic campaign and an imported one have no thesis, and Discovery is refused on them", async () => {
    const generic = (await call<Campaign>("POST", "/api/campaigns", { name: "Plain", layout: "generic" })).json;
    expect((await call<CampaignBundle>("GET", `/api/campaigns/${generic.id}`)).json.thesis).toBeNull();
    expect((await call("PUT", `/api/campaigns/${generic.id}/thesis`, { answers: { pains: "x" } })).status).toBe(404);
    expect((await call("POST", `/api/campaigns/${generic.id}/discovery/runs`, { kind: "find" })).status).toBe(404);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prospects");
    ws.addRow(["Company", "Status"]);
    ws.addRow(["Acme", "Contacted"]);
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(await wb.xlsx.writeBuffer())], "mine.xlsx"));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", fd);
    expect(inspected.json.thesis).toBe(0);
    const imported = (await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Mine" })).json;
    expect((await call<CampaignBundle>("GET", `/api/campaigns/${imported.id}`)).json.thesis).toBeNull();
    expect((await call("POST", `/api/campaigns/${imported.id}/discovery/runs`, { kind: "find" })).status).toBe(404);
    expect((await call("POST", `/api/campaigns/${imported.id}/candidates/accept`, { picks: [{ id: "x", contactIds: [] }] })).status).toBe(404);
  });

  test("a run needs consent first", async () => {
    const c = await newDiscovery();
    settings.updateAiSettings({ consented: false });
    const r = await call<{ error: string }>("POST", `/api/campaigns/${c.id}/discovery/runs`, { kind: "find", target: 5 });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/thesis/);
  });

  test("a partial thesis PUT changes only the questions sent; keep makes a draft the user's", async () => {
    const c = await newDiscovery();
    const first = await call<Thesis>("PUT", `/api/campaigns/${c.id}/thesis`, { answers: { pains: " Ransomware ", bogus: "ignored" } });
    expect(first.status).toBe(200);
    expect(first.json.answers).toEqual({ offer: "SOC monitoring", avatar: "Manufacturers", pains: "Ransomware" });
    // A draft, as the engine files one, then kept.
    db.patchThesis(c.id, { jobs: "Pass the audit" }, ["jobs"]);
    expect(db.getThesis(c.id)!.drafted).toEqual(["jobs"]);
    const kept = await call<Thesis>("PUT", `/api/campaigns/${c.id}/thesis`, { keep: ["jobs"] });
    expect(kept.json.answers.jobs).toBe("Pass the audit");
    expect(kept.json.drafted).toEqual([]);
    const cleared = await call<Thesis>("PUT", `/api/campaigns/${c.id}/thesis`, { answers: { pains: "" } });
    expect(cleared.json.answers.pains).toBeUndefined();
    expect(cleared.json.answers.offer).toBe("SOC monitoring");
  });

  test("Save file writes the ICP thesis tab, and importing that file brings the campaign back as a Discovery campaign", async () => {
    const c = await newDiscovery("Saved");
    await call("PUT", `/api/campaigns/${c.id}/thesis`, { answers: { pains: "Audits" } });
    await call("POST", `/api/campaigns/${c.id}/rows`, { rows: [{ id: "r1", cells: { [c.schema.companyKey!]: "Acme Metal", [c.schema.columns.find((x) => x.header === "Fit")!.key]: "High" } }] });
    const savedFile = await call<{ path: string }>("POST", `/api/campaigns/${c.id}/save`, {});
    expect(savedFile.status).toBe(200);
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: savedFile.json.path });
    expect(inspected.json.thesis).toBe(3);
    expect(inspected.json.sheets.map((s) => [s.name, s.guess])).toEqual([["Prospects", "prospects"], ["Contacts", "contacts"], ["ICP thesis", "thesis"]]);
    const imported = (await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Back" })).json;
    const bundle = (await call<CampaignBundle>("GET", `/api/campaigns/${imported.id}`)).json;
    expect(bundle.thesis).toMatchObject({ answers: { offer: "SOC monitoring", avatar: "Manufacturers", pains: "Audits" } });
    expect(bundle.rows[0]!.cells[bundle.campaign.schema.columns.find((x) => x.header === "Fit")!.key]).toBe("High");
    // And Discovery is open for it again.
    settings.updateAiSettings({ consented: false });
    expect((await call("POST", `/api/campaigns/${imported.id}/discovery/runs`, { kind: "find" })).status).toBe(403);
  });

  test("accept returns the campaign and the rows added; the inbox lists what is left", async () => {
    const c = await newDiscovery();
    const now = Date.now();
    const cand: Candidate = {
      id: "cand1", campaignId: c.id, runId: "none", status: "ready", company: "Acme Metal", website: "https://acmemetal.com", location: "Austin", employees: 400, fit: "High",
      whyFit: "Fits", whyNow: null, budget: null, clock: null, sources: [{ url: "https://lists.example/acme" }],
      contacts: [{ id: "p1", name: "Ann Lee", title: "CIO", type: "Champion", dealRole: "r", gain: "g", angle: "a", linkedin: null, source: "https://acmemetal.com/team", confidence: "high" }],
      firstContact: "p1", angle: "A", error: null, dismissReason: null, rowId: null, createdAt: now, updatedAt: now,
    };
    store.saveCandidates([cand, { ...cand, id: "cand2", company: "Beta" }]);
    const res = await call<{ campaign: Campaign; rows: Row[]; candidates: Candidate[] }>("POST", `/api/campaigns/${c.id}/candidates/accept`, { picks: [{ id: "cand1", contactIds: ["p1"] }] });
    expect(res.status).toBe(200);
    expect(res.json.campaign.id).toBe(c.id);
    expect(res.json.rows).toHaveLength(2);
    expect(res.json.rows[0]!.cells[c.schema.companyKey!]).toBe("Acme Metal");
    expect(res.json.rows[1]!.parentId).toBe(res.json.rows[0]!.id);
    expect(res.json.candidates).toMatchObject([{ id: "cand1", status: "accepted" }]);
    const listed = (await call<{ candidates: Candidate[] }>("GET", `/api/campaigns/${c.id}/discovery`)).json;
    expect(listed.candidates.map((x) => [x.id, x.status])).toEqual([["cand1", "accepted"], ["cand2", "ready"]]);
    const dismissed = await call<Candidate[]>("POST", `/api/campaigns/${c.id}/candidates/dismiss`, { ids: ["cand2"], reason: "Too small" });
    expect(dismissed.json).toMatchObject([{ id: "cand2", status: "dismissed", dismissReason: "Too small" }]);
    expect((await call("POST", `/api/campaigns/${c.id}/candidates/accept`, { picks: [] })).status).toBe(400);
  });
});
