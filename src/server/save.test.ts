/**
 * Save file end to end through the REST API: in place with backups, the "changed outside Mudd"
 * check, copies, the Downloads fallback, refused macro workbooks, and prospects and their contacts.
 * Also that the API refuses requests from other sites.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Campaign, CampaignBundle, CampaignSummary, InspectResult, Row } from "../shared/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-save-"));
const saved = Object.fromEntries(["MUDD_DATA_DIR", "HOME", "USERPROFILE"].map((k) => [k, process.env[k]]));
let handler: (req: Request) => Promise<Response>;
let db: typeof import("./db");

beforeAll(async () => {
  process.env.MUDD_DATA_DIR = path.join(tmp, "data");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  db = await import("./db");
  db.closeDb();
  handler = (await import("./index")).createFetchHandler();
});

afterAll(() => {
  db.closeDb();
  // One that was unset is unset again: assigned undefined, it would read "undefined", and a later
  // test's database would land in ./undefined.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

async function trackerFile(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["Company", "Name", "Status"]);
  ws.addRow(["Acme", "Ann", "Contacted"]);
  ws.addRow(["Beta", "Bo", "Replied"]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));
}

async function importPath(file: string): Promise<{ campaign: Campaign; rows: Row[] }> {
  const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
  expect(inspected.status).toBe(200);
  const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Test" });
  expect(imp.status).toBe(200);
  const bundle = await call<{ campaign: Campaign; rows: Row[] }>("GET", `/api/campaigns/${imp.json.id}`);
  return bundle.json;
}

async function statusOf(file: string, row: number): Promise<unknown> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(fs.readFileSync(file)) as unknown as ArrayBuffer);
  return wb.getWorksheet("Prospects")!.getCell(`C${row}`).value;
}

describe("Save file", () => {
  test("writes over the imported file, keeping a .bak and a dated backup", async () => {
    const file = path.join(tmp, "docs", "tracker.xlsx");
    await trackerFile(file);
    const { campaign, rows } = await importPath(file);
    expect(campaign.sourcePath).toBe(file);
    const status = campaign.schema.statusKey!;
    await call("PATCH", `/api/campaigns/${campaign.id}/rows`, { edits: [{ rowId: rows[0]!.id, key: status, value: "Replied" }] });
    const r = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${campaign.id}/save`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: file, linked: true });
    expect(await statusOf(file, 2)).toBe("Replied");
    expect(fs.existsSync(path.join(tmp, "docs", "tracker.bak.xlsx"))).toBe(true);
    expect(fs.readdirSync(path.join(tmp, "data", "backups", campaign.id))).toHaveLength(1);

    // Changed in Excel since: Mudd asks first; forcing replaces it.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const conflict = await call<{ code: string }>("POST", `/api/campaigns/${campaign.id}/save`, {});
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("changed");
    expect((await call("POST", `/api/campaigns/${campaign.id}/save`, { force: true })).status).toBe(200);

    // A copy goes to Downloads and changes no link.
    const copy = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${campaign.id}/save`, { copy: true });
    expect(copy.json.linked).toBe(false);
    expect(path.dirname(copy.json.path)).toBe(path.join(tmp, "Downloads"));
    expect((await call<{ campaign: Campaign }>("GET", `/api/campaigns/${campaign.id}`)).json.campaign.sourcePath).toBe(file);
  });

  test("a dropped-in file saves to Downloads, then keeps saving there", async () => {
    const file = path.join(tmp, "elsewhere", "dropped.xlsx");
    await trackerFile(file);
    const fd = new FormData();
    fd.append("file", new File([fs.readFileSync(file)], "dropped.xlsx"));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", fd);
    const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Dropped" });
    const first = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${imp.json.id}/save`, {});
    expect(first.json.linked).toBe(true);
    expect(first.json.path).toBe(path.join(tmp, "Downloads", "dropped.xlsx"));
    const second = await call<{ path: string }>("POST", `/api/campaigns/${imp.json.id}/save`, {});
    expect(second.json.path).toBe(first.json.path);
  });

  test("removing a campaign takes it out of Mudd and leaves its file and backups alone", async () => {
    const file = path.join(tmp, "docs", "keep-me.xlsx");
    await trackerFile(file);
    const { campaign } = await importPath(file);
    expect((await call("POST", `/api/campaigns/${campaign.id}/save`, {})).status).toBe(200);
    const bytes = fs.readFileSync(file);
    const backups = path.join(tmp, "data", "backups", campaign.id);
    const kept = fs.readdirSync(backups);
    expect((await call("DELETE", `/api/campaigns/${campaign.id}`)).status).toBe(200);
    expect((await call("GET", `/api/campaigns/${campaign.id}`)).status).toBe(404);
    expect((await call<CampaignSummary[]>("GET", "/api/campaigns")).json.some((c) => c.id === campaign.id)).toBe(false);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "docs", "keep-me.bak.xlsx"))).toBe(true);
    expect(fs.readdirSync(backups)).toEqual(kept);
    // Imported again, it's all there as it was saved.
    const again = await importPath(file);
    expect(again.rows).toHaveLength(2);
  });

  test("a macro workbook is refused at import", async () => {
    const file = path.join(tmp, "docs", "macros.xlsm");
    await trackerFile(file);
    const r = await call<{ error: string }>("POST", "/api/import/inspect", { path: file });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/macros/);
  });
});

describe("prospects and their contacts", () => {
  test("import links them, the API keeps them apart, and deleting a prospect takes its contacts", async () => {
    const file = path.join(tmp, "docs", "people.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prospects");
    ws.addRow(["ID", "Company", "Status"]);
    ws.addRow(["P-001", "Acme", "Contacted"]);
    ws.addRow(["P-002", "Beta", "Replied"]);
    const people = wb.addWorksheet("Contacts");
    people.addRow(["Prospect ID", "Company", "Name", "Contact type", "Primary"]);
    people.addRow(["P-001", "Acme", "Ann Lee", "Economic Buyer", true]);
    people.addRow(["P-001", "Acme", "Al Ng", "End User", null]);
    people.addRow(["P-002", "Beta", "Bo Chen", "Gatekeeper", true]);
    fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));

    const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
    expect(inspected.json.sheets.map((x) => x.guess)).toEqual(["prospects", "contacts"]);
    const imp = await call<Campaign & { skippedContacts: number }>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "People" });
    expect(imp.json.skippedContacts).toBe(0);
    const id = imp.json.id;
    const bundle = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    expect(bundle.rows).toHaveLength(2);
    const acme = bundle.rows.find((r) => r.cells[bundle.campaign.schema.companyKey!] === "Acme")!;
    const nameKey = bundle.campaign.schema.contacts!.nameKey!;
    expect(bundle.contacts.filter((c) => c.parentId === acme.id).map((c) => c.cells[nameKey])).toEqual(["Ann Lee", "Al Ng"]);
    // The home page counts prospects, not people.
    const summary = (await call<CampaignSummary[]>("GET", "/api/campaigns")).json.find((c) => c.id === id)!;
    expect(summary.prospects).toBe(2);

    // A new contact, and an edit to one, saved into the Contacts tab in place.
    await call("POST", `/api/campaigns/${id}/rows`, { rows: [{ id: "newperson", parentId: acme.id, cells: { [nameKey]: "Amy Poe" } }] });
    const bo = bundle.contacts.find((c) => c.cells[nameKey] === "Bo Chen")!;
    await call("PATCH", `/api/campaigns/${id}/rows`, { edits: [{ rowId: bo.id, key: nameKey, value: "Bo Chen-Li" }] });
    expect((await call("POST", `/api/campaigns/${id}/save`, {})).status).toBe(200);
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.load(new Uint8Array(fs.readFileSync(file)) as unknown as ArrayBuffer);
    const tab = saved.getWorksheet("Contacts")!;
    expect([2, 3, 4, 5].map((r) => tab.getCell(`C${r}`).value)).toEqual(["Ann Lee", "Al Ng", "Bo Chen-Li", "Amy Poe"]);
    expect(tab.getCell("A5").value).toBe("P-001");

    // Deleting Acme deletes its three people with it.
    await call("DELETE", `/api/campaigns/${id}/rows`, { ids: [acme.id] });
    const after = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    expect(after.rows).toHaveLength(1);
    expect(after.contacts.map((c) => c.cells[nameKey])).toEqual(["Bo Chen-Li"]);
  });
});

describe("Export CSV", () => {
  test("writes each tab to Downloads, guards formulas, and imports back as it was", async () => {
    const file = path.join(tmp, "docs", "csv.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prospects");
    ws.addRow(["ID", "Company", "Status", "Notes"]);
    ws.addRow(["P-001", "Acme, Inc.", "Contacted", 'Said "maybe"\nCall back']);
    ws.addRow(["P-002", "Beta", "Replied", "=HYPERLINK(\"x\")"]);
    const people = wb.addWorksheet("Contacts");
    people.addRow(["Prospect ID", "Company", "Name", "Contact type", "Primary"]);
    people.addRow(["P-001", "Acme, Inc.", "Ann Lee", "Economic Buyer", true]);
    people.addRow(["P-002", "Beta", "Bo Chen", "Gatekeeper", true]);
    fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
    const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Leads" });
    const id = imp.json.id;

    const prospects = await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "prospects" });
    expect(prospects.json.path).toBe(path.join(tmp, "Downloads", "Leads prospects.csv"));
    const text = fs.readFileSync(prospects.json.path, "utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain('"Acme, Inc."');
    expect(text).toContain('"Said ""maybe""\nCall back"');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    // Exporting again never replaces the first file.
    expect((await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "prospects" })).json.path).toBe(path.join(tmp, "Downloads", "Leads prospects (2).csv"));
    // Save file still has no link to change: the campaign is linked to its workbook as before.
    expect((await call<{ campaign: Campaign }>("GET", `/api/campaigns/${id}`)).json.campaign.sourcePath).toBe(file);

    const contacts = await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "contacts" });
    const lines = fs.readFileSync(contacts.json.path, "utf8").replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]!.startsWith("Prospect ID,Company,Name,")).toBe(true);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["P-001", "P-002"]);

    // The prospects CSV imported again gives the same cells, the guard taken off.
    const before = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    const fd = new FormData();
    fd.append("file", new File([fs.readFileSync(prospects.json.path)], "Leads prospects.csv"));
    const again = await call<InspectResult>("POST", "/api/import/inspect", fd);
    const back = await call<Campaign>("POST", "/api/import", { token: again.json.token, prospects: again.json.sheets[0]!.name, name: "Back" });
    const after = (await call<CampaignBundle>("GET", `/api/campaigns/${back.json.id}`)).json;
    const byHeader = (b: CampaignBundle) => b.rows.map((r) => Object.fromEntries(b.campaign.schema.columns.map((c) => [c.header, r.cells[c.key] ?? null])));
    expect(byHeader(after)).toEqual(byHeader(before));
  });

  test("refuses anything but prospects or contacts", async () => {
    const { campaign } = await importPath(path.join(tmp, "docs", "csv.xlsx"));
    expect((await call("POST", `/api/campaigns/${campaign.id}/csv`, { kind: "templates" })).status).toBe(400);
  });
});

describe("requests from other sites", () => {
  const send = (url: string, init: RequestInit = {}) => handler(new Request(url, init));

  test("are refused, and change nothing", async () => {
    const before = (await call<CampaignSummary[]>("GET", "/api/campaigns")).json.length;
    // A page on another site posting to the API: text/plain, so the browser sends it without asking.
    const forged = await send("http://127.0.0.1:24871/api/campaigns", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: JSON.stringify({ name: "Forged" }) });
    expect(forged.status).toBe(403);
    // A sandboxed frame or a file:// page sends Origin "null".
    expect((await send("http://127.0.0.1:24871/api/campaigns", { method: "POST", headers: { Origin: "null" }, body: "{}" })).status).toBe(403);
    // DNS rebinding: evil.example resolves to 127.0.0.1, so the page is "same-origin" with the API.
    expect((await send("http://evil.example:24871/api/campaigns")).status).toBe(403);
    expect((await send("http://evil.example:24871/api/campaigns", { method: "POST", headers: { Origin: "http://evil.example:24871" }, body: "{}" })).status).toBe(403);
    // An <img> or <script> on another site: a GET without an Origin.
    for (const site of ["cross-site", "same-site"]) {
      expect((await send("http://127.0.0.1:24871/api/update", { headers: { "Sec-Fetch-Site": site } })).status).toBe(403);
    }
    expect((await call<CampaignSummary[]>("GET", "/api/campaigns")).json).toHaveLength(before);
  });

  test("Mudd's own page still gets through, on 127.0.0.1 or localhost", async () => {
    for (const origin of ["http://127.0.0.1:24871", "http://localhost:24871"]) {
      const res = await send(`${origin}/api/campaigns`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Mine" }) });
      expect(res.status).toBe(200);
    }
    // The URL typed into the address bar.
    expect((await send("http://127.0.0.1:24871/api/campaigns", { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(200);
    // The same host on another port is another site.
    expect((await send("http://127.0.0.1:24871/api/campaigns", { headers: { Origin: "http://127.0.0.1:3000" } })).status).toBe(403);
  });
});
