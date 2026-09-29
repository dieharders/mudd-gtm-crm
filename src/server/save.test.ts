/**
 * Save file end to end through the REST API: in place with backups, the "changed outside Mudd"
 * check, copies, the Downloads fallback, refused macro workbooks, prospects and their contacts,
 * and the migrations: version 2 turned the old Screened-out list into a ticked column, version 3
 * gave prospects contacts and IDs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Campaign, CampaignBundle, CampaignSchema, CampaignSummary, InspectResult, Row } from "../shared/types";
import { CHECKED, isScreened } from "../shared/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-save-"));
const saved = { data: process.env.MUDD_DATA_DIR, home: process.env.HOME, profile: process.env.USERPROFILE };
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

describe("migration to version 2", () => {
  test("the old Screened-out list becomes ticked rows", async () => {
    const dir = path.join(tmp, "legacy");
    fs.mkdirSync(dir, { recursive: true });
    const legacy = new Database(path.join(dir, "mudd.sqlite"), { create: true });
    legacy.exec(`
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        source_name TEXT, source_path TEXT, source_mtime INTEGER, original BLOB, schema_json TEXT NOT NULL, sheets_json TEXT NOT NULL);
      CREATE TABLE rows (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, bucket TEXT NOT NULL, position REAL NOT NULL,
        source_sheet TEXT, source_row INTEGER, cells_json TEXT NOT NULL);
    `);
    const schema = {
      columns: [
        { key: "company", header: "Company", type: "text" },
        { key: "constructor", header: "Constructor", type: "text" },
        { key: "why", header: "Why it fails the filter", type: "longtext" },
      ],
      companyKey: "company",
      reasonKey: "why",
    };
    const sheets: { name: string; role: string; colMap: Record<string, number>; lastDataRow: number; lastCol: number }[] = [
      { name: "Prospects", role: "prospects", colMap: { company: 1, constructor: 2 }, lastDataRow: 3, lastCol: 2 },
      { name: "Screened out", role: "screened", colMap: { company: 1, why: 2 }, lastDataRow: 2, lastCol: 2 },
    ];
    legacy.query("INSERT INTO campaigns VALUES ('c1', 'Old', 0, 0, NULL, NULL, NULL, NULL, ?, ?)").run(JSON.stringify(schema), JSON.stringify(sheets));
    legacy.query("INSERT INTO rows VALUES ('a', 'c1', 'prospects', 0, 'Prospects', 2, ?)").run(JSON.stringify({ company: "Acme", constructor: "x" }));
    legacy.query("INSERT INTO rows VALUES ('b', 'c1', 'screened', 1, 'Screened out', 2, ?)").run(JSON.stringify({ company: "Palantir", why: "Too big" }));
    legacy.close();

    db.closeDb();
    process.env.MUDD_DATA_DIR = dir;
    try {
      const c = db.getCampaign("c1")!;
      expect(c.sheets.map((s) => s.role)).toEqual(["prospects", "passthrough"]);
      expect(c.schema.columns.some((col) => col.key === "constructor")).toBe(false);
      const rows = db.listRows("c1");
      const acme = rows.find((r) => r.id === "a")!;
      const palantir = rows.find((r) => r.id === "b")!;
      expect(acme.cells.constructor_col).toBe("x");
      expect(isScreened(palantir, c.schema)).toBe(true);
      expect(isScreened(acme, c.schema)).toBe(false);
      expect(palantir.sourceRow).toBeNull();
      expect(palantir.cells.why).toBe("Too big");
      // New rows still go into a table created by version 1 (bucket NOT NULL there).
      expect(db.insertRows("c1", [{ cells: { company: "New" } }])).toHaveLength(1);
    } finally {
      db.closeDb();
      process.env.MUDD_DATA_DIR = path.join(tmp, "data");
    }
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

describe("migration to version 3", () => {
  test("every campaign gets contact columns and an ID column, every prospect an ID; nothing else changes", async () => {
    const dir = path.join(tmp, "v2");
    fs.mkdirSync(dir, { recursive: true });
    const legacy = new Database(path.join(dir, "mudd.sqlite"), { create: true });
    legacy.exec(`
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        source_name TEXT, source_path TEXT, source_mtime INTEGER, original BLOB, schema_json TEXT NOT NULL, sheets_json TEXT NOT NULL);
      CREATE TABLE rows (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT 'prospects', position REAL NOT NULL,
        source_sheet TEXT, source_row INTEGER, cells_json TEXT NOT NULL, orig_json TEXT);
      PRAGMA user_version = 2;
    `);
    // A version-2 campaign: its contact on the row itself, and a deleted "Email" column's values left behind.
    const schema: CampaignSchema = {
      columns: [
        { key: "name", header: "Name", type: "text" },
        { key: "company", header: "Company", type: "text" },
        { key: "status", header: "Status", type: "select", options: ["Contacted"] },
      ],
      nameKey: "name",
      companyKey: "company",
      statusKey: "status",
    };
    legacy.query("INSERT INTO campaigns VALUES ('c1', 'Old', 0, 0, NULL, NULL, NULL, NULL, ?, '[]')").run(JSON.stringify(schema));
    legacy.query("INSERT INTO rows (id, campaign_id, position, cells_json) VALUES ('b', 'c1', 1, ?)").run(JSON.stringify({ name: "Bo", company: "Beta", email: "bo@beta.io" }));
    legacy.query("INSERT INTO rows (id, campaign_id, position, cells_json) VALUES ('a', 'c1', 0, ?)").run(JSON.stringify({ name: "Ann", company: "Acme", status: "Contacted" }));
    legacy.close();

    db.closeDb();
    process.env.MUDD_DATA_DIR = dir;
    try {
      const c = db.getCampaign("c1")!;
      const contacts = c.schema.contacts!;
      const keys = [...c.schema.columns, ...contacts.columns].map((col) => col.key);
      expect(new Set(keys).size).toBe(keys.length);
      // Not "name" (the prospect's column) nor "email" (the deleted one's values).
      expect(contacts.nameKey).toBe("name_2");
      expect(contacts.columns.find((col) => col.header === "Email")!.key).toBe("email_2");
      expect(c.schema.columns.find((col) => col.key === c.schema.idKey)).toMatchObject({ header: "ID", hidden: true });
      const rows = db.listRows("c1");
      expect(rows.map((r) => [r.id, r.cells[c.schema.idKey!]])).toEqual([["a", "P-001"], ["b", "P-002"]]);
      expect(rows[1]!.cells).toMatchObject({ name: "Bo", company: "Beta", email: "bo@beta.io" });
      expect(db.listRows("c1", "contacts")).toEqual([]);
      // Contacts can be added to it straight away.
      db.insertRows("c1", [{ id: "k", parentId: "a", cells: { name_2: "Ann Lee", [contacts.primaryKey!]: CHECKED } }]);
      expect(db.primaryContact("c1", "a", c.schema)?.id).toBe("k");
    } finally {
      db.closeDb();
      process.env.MUDD_DATA_DIR = path.join(tmp, "data");
    }
  });
});
