/**
 * Local storage: one SQLite file, nothing leaves the machine.
 *
 * Lives in %APPDATA%\Mudd.io (or ~/.mudd on other systems) rather than beside the checkout, so
 * a `git clean` or a fresh clone never takes a user's campaigns with it. `MUDD_DATA_DIR`
 * overrides it — the tests point it at a temp directory.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Bucket, Campaign, CampaignSchema, CampaignSummary, CellEdit, CellValue, Meeting, Row, SheetMeta, Template,
} from "../shared/types";
import { DEAD, MEETING_STAGE, stagesOf } from "../shared/types";

export function dataDir(): string {
  if (process.env.MUDD_DATA_DIR) return process.env.MUDD_DATA_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "Mudd.io");
  return path.join(os.homedir(), ".mudd");
}

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, "mudd.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_name TEXT,
      source_path TEXT,
      source_mtime INTEGER,
      original BLOB,
      schema_json TEXT NOT NULL,
      sheets_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rows (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL,
      position REAL NOT NULL,
      source_sheet TEXT,
      source_row INTEGER,
      cells_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rows_campaign ON rows(campaign_id);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      position REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS templates_campaign ON templates(campaign_id);
  `);
  return db;
}

/** For tests: close and forget the handle so the next call reopens under a new MUDD_DATA_DIR. */
export function closeDb(): void {
  db?.close();
  db = null;
}

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// ---------- campaigns ----------

interface CampaignRecord {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  source_name: string | null;
  source_path: string | null;
  source_mtime: number | null;
  has_original: number;
  schema_json: string;
  sheets_json: string;
}

const CAMPAIGN_COLS =
  "id, name, created_at, updated_at, source_name, source_path, source_mtime, original IS NOT NULL AS has_original, schema_json, sheets_json";

function toCampaign(r: CampaignRecord): Campaign {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceName: r.source_name,
    sourcePath: r.source_path,
    hasOriginal: !!r.has_original,
    schema: JSON.parse(r.schema_json),
    sheets: JSON.parse(r.sheets_json),
  };
}

export function getCampaign(id: string): Campaign | null {
  const r = getDb().query(`SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE id = ?`).get(id) as CampaignRecord | null;
  return r ? toCampaign(r) : null;
}

export function getSourceMtime(id: string): number | null {
  const r = getDb().query("SELECT source_mtime FROM campaigns WHERE id = ?").get(id) as { source_mtime: number | null } | null;
  return r?.source_mtime ?? null;
}

export function getOriginal(id: string): Uint8Array | null {
  const r = getDb().query("SELECT original FROM campaigns WHERE id = ?").get(id) as { original: Uint8Array | null } | null;
  return r?.original ? new Uint8Array(r.original) : null;
}

export function createCampaign(input: {
  name: string;
  schema: CampaignSchema;
  sheets: SheetMeta[];
  sourceName?: string | null;
  sourcePath?: string | null;
  sourceMtime?: number | null;
  original?: Uint8Array | null;
  rows?: Omit<Row, "id">[];
  templates?: { name: string; body: string }[];
}): Campaign {
  const d = getDb();
  const id = newId();
  const now = Date.now();
  d.transaction(() => {
    d.query(
      `INSERT INTO campaigns (id, name, created_at, updated_at, source_name, source_path, source_mtime, original, schema_json, sheets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.name, now, now, input.sourceName ?? null, input.sourcePath ?? null, input.sourceMtime ?? null,
      input.original ?? null, JSON.stringify(input.schema), JSON.stringify(input.sheets),
    );
    const ins = d.query(
      "INSERT INTO rows (id, campaign_id, bucket, position, source_sheet, source_row, cells_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    (input.rows ?? []).forEach((r, i) =>
      ins.run(newId(), id, r.bucket, r.position ?? i, r.sourceSheet ?? null, r.sourceRow ?? null, JSON.stringify(r.cells)),
    );
    const tpl = d.query("INSERT INTO templates (id, campaign_id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    (input.templates ?? []).forEach((t, i) => tpl.run(newId(), id, t.name, t.body, i, now));
  })();
  return getCampaign(id)!;
}

export function touchCampaign(id: string): number {
  const now = Date.now();
  getDb().query("UPDATE campaigns SET updated_at = ? WHERE id = ?").run(now, id);
  return now;
}

export function updateCampaign(id: string, patch: { name?: string; schema?: CampaignSchema }): Campaign | null {
  const d = getDb();
  if (patch.name !== undefined) d.query("UPDATE campaigns SET name = ? WHERE id = ?").run(patch.name, id);
  if (patch.schema) d.query("UPDATE campaigns SET schema_json = ? WHERE id = ?").run(JSON.stringify(patch.schema), id);
  touchCampaign(id);
  return getCampaign(id);
}

export function setSource(id: string, sourcePath: string, mtime: number | null): void {
  getDb().query("UPDATE campaigns SET source_path = ?, source_mtime = ? WHERE id = ?").run(sourcePath, mtime, id);
}

export function deleteCampaign(id: string): void {
  getDb().query("DELETE FROM campaigns WHERE id = ?").run(id);
}

export function listCampaigns(): CampaignSummary[] {
  const d = getDb();
  const recs = d.query(`SELECT ${CAMPAIGN_COLS} FROM campaigns ORDER BY updated_at DESC`).all() as CampaignRecord[];
  return recs.map((r) => {
    const c = toCampaign(r);
    const rows = listRows(c.id);
    const byStatus: Record<string, number> = {};
    let prospects = 0;
    for (const row of rows) {
      if (row.bucket !== "prospects") continue;
      prospects++;
      const s = c.schema.statusKey ? String(row.cells[c.schema.statusKey] ?? "") : "";
      const key = s || "Not set";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    return {
      id: c.id,
      name: c.name,
      updatedAt: c.updatedAt,
      sourceName: c.sourceName,
      prospects,
      screened: rows.length - prospects,
      byStatus,
      stages: stagesOf(c.schema),
    };
  });
}

// ---------- rows ----------

interface RowRecord {
  id: string;
  bucket: Bucket;
  position: number;
  source_sheet: string | null;
  source_row: number | null;
  cells_json: string;
}

const toRow = (r: RowRecord): Row => ({
  id: r.id,
  bucket: r.bucket,
  position: r.position,
  sourceSheet: r.source_sheet,
  sourceRow: r.source_row,
  cells: JSON.parse(r.cells_json),
});

export function listRows(campaignId: string): Row[] {
  return (
    getDb()
      .query("SELECT id, bucket, position, source_sheet, source_row, cells_json FROM rows WHERE campaign_id = ? ORDER BY position")
      .all(campaignId) as RowRecord[]
  ).map(toRow);
}

export function insertRows(campaignId: string, rows: (Partial<Row> & { bucket: Bucket })[]): Row[] {
  const d = getDb();
  const max = (d.query("SELECT MAX(position) AS m FROM rows WHERE campaign_id = ?").get(campaignId) as { m: number | null }).m ?? -1;
  const out: Row[] = [];
  d.transaction(() => {
    const ins = d.query(
      "INSERT OR REPLACE INTO rows (id, campaign_id, bucket, position, source_sheet, source_row, cells_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    rows.forEach((r, i) => {
      const row: Row = {
        id: r.id ?? newId(),
        bucket: r.bucket,
        position: r.position ?? max + 1 + i,
        cells: r.cells ?? {},
        sourceSheet: r.sourceSheet ?? null,
        sourceRow: r.sourceRow ?? null,
      };
      ins.run(row.id, campaignId, row.bucket, row.position, row.sourceSheet ?? null, row.sourceRow ?? null, JSON.stringify(row.cells));
      out.push(row);
    });
  })();
  touchCampaign(campaignId);
  return out;
}

export function applyEdits(campaignId: string, edits: CellEdit[]): number {
  const d = getDb();
  d.transaction(() => {
    const get = d.query("SELECT cells_json FROM rows WHERE id = ? AND campaign_id = ?");
    const set = d.query("UPDATE rows SET cells_json = ? WHERE id = ?");
    const byRow = new Map<string, CellEdit[]>();
    for (const e of edits) byRow.set(e.rowId, [...(byRow.get(e.rowId) ?? []), e]);
    for (const [rowId, list] of byRow) {
      const r = get.get(rowId, campaignId) as { cells_json: string } | null;
      if (!r) continue;
      const cells = JSON.parse(r.cells_json) as Record<string, CellValue>;
      for (const e of list) {
        if (e.value === null || e.value === "") delete cells[e.key];
        else cells[e.key] = e.value;
      }
      set.run(JSON.stringify(cells), rowId);
    }
  })();
  return touchCampaign(campaignId);
}

export function deleteRows(campaignId: string, ids: string[]): void {
  const d = getDb();
  d.transaction(() => {
    const del = d.query("DELETE FROM rows WHERE id = ? AND campaign_id = ?");
    for (const id of ids) del.run(id, campaignId);
  })();
  touchCampaign(campaignId);
}

export function moveRows(campaignId: string, ids: string[], bucket: Bucket, positions?: Record<string, number>): void {
  const d = getDb();
  d.transaction(() => {
    const mv = d.query("UPDATE rows SET bucket = ? WHERE id = ? AND campaign_id = ?");
    const pos = d.query("UPDATE rows SET position = ? WHERE id = ? AND campaign_id = ?");
    for (const id of ids) {
      mv.run(bucket, id, campaignId);
      if (positions && typeof positions[id] === "number") pos.run(positions[id]!, id, campaignId);
    }
  })();
  touchCampaign(campaignId);
}

// ---------- templates ----------

interface TemplateRecord {
  id: string;
  campaign_id: string;
  name: string;
  body: string;
  position: number;
  updated_at: number;
}
const toTemplate = (t: TemplateRecord): Template => ({
  id: t.id, campaignId: t.campaign_id, name: t.name, body: t.body, position: t.position, updatedAt: t.updated_at,
});

export function listTemplates(campaignId: string): Template[] {
  return (
    getDb().query("SELECT * FROM templates WHERE campaign_id = ? ORDER BY position").all(campaignId) as TemplateRecord[]
  ).map(toTemplate);
}

export function createTemplate(campaignId: string, name: string, body: string): Template {
  const d = getDb();
  const id = newId();
  const max = (d.query("SELECT MAX(position) AS m FROM templates WHERE campaign_id = ?").get(campaignId) as { m: number | null }).m ?? -1;
  d.query("INSERT INTO templates (id, campaign_id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, campaignId, name, body, max + 1, Date.now(),
  );
  touchCampaign(campaignId);
  return toTemplate(d.query("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRecord);
}

export function updateTemplate(id: string, patch: { name?: string; body?: string }): Template | null {
  const d = getDb();
  const cur = d.query("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRecord | null;
  if (!cur) return null;
  d.query("UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?").run(
    patch.name ?? cur.name, patch.body ?? cur.body, Date.now(), id,
  );
  touchCampaign(cur.campaign_id);
  return toTemplate(d.query("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRecord);
}

export function deleteTemplate(id: string): void {
  const d = getDb();
  const cur = d.query("SELECT campaign_id FROM templates WHERE id = ?").get(id) as { campaign_id: string } | null;
  d.query("DELETE FROM templates WHERE id = ?").run(id);
  if (cur) touchCampaign(cur.campaign_id);
}

// ---------- meetings ----------

export function listMeetings(): Meeting[] {
  const d = getDb();
  const recs = d.query(`SELECT ${CAMPAIGN_COLS} FROM campaigns`).all() as CampaignRecord[];
  const out: Meeting[] = [];
  for (const rec of recs) {
    const c = toCampaign(rec);
    const s = c.schema;
    if (!s.meetingAtKey) continue;
    for (const row of listRows(c.id)) {
      if (row.bucket !== "prospects") continue;
      const at = row.cells[s.meetingAtKey];
      if (!at || typeof at !== "string") continue;
      const status = s.statusKey ? (row.cells[s.statusKey] as string | undefined) ?? null : null;
      if (status === DEAD) continue;
      const name = s.nameKey ? String(row.cells[s.nameKey] ?? "") : "";
      const company = s.companyKey ? String(row.cells[s.companyKey] ?? "") : "";
      out.push({
        campaignId: c.id,
        campaignName: c.name,
        rowId: row.id,
        title: name || company || "Untitled prospect",
        subtitle: name && company ? company : "",
        at,
        url: s.meetingUrlKey ? ((row.cells[s.meetingUrlKey] as string | undefined) ?? null) : null,
        status,
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export { MEETING_STAGE };
