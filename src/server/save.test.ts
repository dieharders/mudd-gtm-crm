/**
 * Save file end to end through the REST API: in place with backups, the "changed outside Mudd"
 * check, copies, the Downloads fallback, refused macro workbooks, and the version-2 migration
 * that turned the old Screened-out list into a ticked column.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Campaign, InspectResult, Row } from "../shared/types";
import { isScreened } from "../shared/types";

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
