/**
 * Local storage: one SQLite file, nothing leaves the machine.
 *
 * Lives in %APPDATA%\Mudd.io (or ~/.mudd on other systems) rather than beside the checkout, so
 * a `git clean` or a fresh clone never takes a user's campaigns with it. `MUDD_DATA_DIR`
 * overrides it — the tests point it at a temp directory.
 *
 * Each row imported from a sheet also keeps its cells as they were imported (`orig_json`).
 * Export compares against that to find what the user changed, and writes only those cells back
 * into the workbook, so everything else in the file (rich text, links, formats) stays as it was.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAppColumns, isReservedKey } from "../shared/schema";
import type {
  Campaign, CampaignSchema, CampaignSummary, CellEdit, CellValue, Meeting, Row, SheetMeta, Template,
} from "../shared/types";
import { CHECKED, DEAD, isScreened, stagesOf } from "../shared/types";
import { applyCellEdits, rowTitle } from "../shared/values";

export function dataDir(): string {
  if (process.env.MUDD_DATA_DIR) return process.env.MUDD_DATA_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "Mudd.io");
  return path.join(os.homedir(), ".mudd");
}

let db: Database | null = null;

const SCHEMA_VERSION = 2;

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
      bucket TEXT NOT NULL DEFAULT 'prospects',
      position REAL NOT NULL,
      source_sheet TEXT,
      source_row INTEGER,
      cells_json TEXT NOT NULL,
      orig_json TEXT
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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      json TEXT NOT NULL,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS suggestions_campaign ON suggestions(campaign_id, status);
    CREATE INDEX IF NOT EXISTS suggestions_row ON suggestions(campaign_id, row_id, status);
  `);
  migrate(db);
  return db;
}

/**
 * Version 2 dropped the separate Screened-out list: a screened prospect is now a row with its
 * "Screened out" box ticked. Rows that lived on the old list are ticked and, because their sheet
 * row belonged to the Screened-out tab, written to the prospects tab as new rows on the next save.
 */
function migrate(d: Database): void {
  const version = (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= SCHEMA_VERSION) return;
  const cols = d.query("PRAGMA table_info(rows)").all() as { name: string }[];
  d.transaction(() => {
    if (!cols.some((c) => c.name === "orig_json")) d.exec("ALTER TABLE rows ADD COLUMN orig_json TEXT");
    const campaigns = d.query("SELECT id, schema_json, sheets_json FROM campaigns").all() as { id: string; schema_json: string; sheets_json: string }[];
    for (const c of campaigns) {
      const schema = JSON.parse(c.schema_json) as CampaignSchema;
      const sheets = JSON.parse(c.sheets_json) as (Omit<SheetMeta, "role"> & { role: string })[];
      // Keys that shadow Object.prototype ("constructor") read back as functions: rename them.
      const renamed = new Map<string, string>();
      for (const col of schema.columns) {
        if (!isReservedKey(col.key)) continue;
        const next = `${col.key}_col`;
        renamed.set(col.key, next);
        col.key = next;
      }
      for (const role of ["statusKey", "reasonKey", "introKey", "meetingUrlKey", "meetingAtKey", "nameKey", "companyKey"] as const) {
        const k = schema[role];
        if (k && renamed.has(k)) schema[role] = renamed.get(k);
      }
      ensureAppColumns(schema);
      const prospectsSheet = sheets.find((s) => s.role === "prospects")?.name ?? null;
      const fixed = sheets.map((s) => {
        const colMap = Object.fromEntries(Object.entries(s.colMap).map(([k, v]) => [renamed.get(k) ?? k, v]));
        return s.role === "screened" ? { ...s, role: "passthrough", colMap: {} } : { ...s, colMap };
      });
      d.query("UPDATE campaigns SET schema_json = ?, sheets_json = ? WHERE id = ?").run(JSON.stringify(schema), JSON.stringify(fixed), c.id);

      const rows = d.query("SELECT id, bucket, source_sheet, cells_json FROM rows WHERE campaign_id = ?").all(c.id) as { id: string; bucket: string; source_sheet: string | null; cells_json: string }[];
      const upd = d.query("UPDATE rows SET bucket = 'prospects', cells_json = ?, source_sheet = ?, source_row = ? WHERE id = ?");
      const keep = d.query("UPDATE rows SET cells_json = ? WHERE id = ?");
      for (const r of rows) {
        const cells = JSON.parse(r.cells_json) as Record<string, CellValue>;
        for (const [from, to] of renamed) {
          if (Object.hasOwn(cells, from)) {
            cells[to] = cells[from]!;
            delete cells[from];
          }
        }
        if (r.bucket === "screened" && schema.screenedKey) cells[schema.screenedKey] = CHECKED;
        const fromOtherTab = r.bucket === "screened" || (r.source_sheet !== null && r.source_sheet !== prospectsSheet);
        if (fromOtherTab) upd.run(JSON.stringify(cells), null, null, r.id);
        else keep.run(JSON.stringify(cells), r.id);
      }
    }
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

/** For tests: close and forget the handle so the next call reopens under a new MUDD_DATA_DIR. */
export function closeDb(): void {
  db?.close();
  db = null;
  summaryCache.clear();
  meetingCache.clear();
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

/** A row as import produces it: `orig` is its cells as read from the sheet. */
export type NewRow = Omit<Row, "id"> & { orig?: Record<string, CellValue> | null };

export function createCampaign(input: {
  name: string;
  schema: CampaignSchema;
  sheets: SheetMeta[];
  sourceName?: string | null;
  sourcePath?: string | null;
  sourceMtime?: number | null;
  original?: Uint8Array | null;
  rows?: NewRow[];
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
    // `bucket` is a leftover of version 1 (NOT NULL in databases created then): always "prospects".
    const ins = d.query(
      "INSERT INTO rows (id, campaign_id, bucket, position, source_sheet, source_row, cells_json, orig_json) VALUES (?, ?, 'prospects', ?, ?, ?, ?, ?)",
    );
    (input.rows ?? []).forEach((r, i) =>
      ins.run(newId(), id, r.position ?? i, r.sourceSheet ?? null, r.sourceRow ?? null, JSON.stringify(r.cells), r.orig ? JSON.stringify(r.orig) : null),
    );
    const tpl = d.query("INSERT INTO templates (id, campaign_id, name, body, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    (input.templates ?? []).forEach((t, i) => tpl.run(newId(), id, t.name, t.body, i, now));
  })();
  return getCampaign(id)!;
}

/** Bump updated_at, always forward (the summary caches rely on every write changing it). */
export function touchCampaign(id: string): number {
  const d = getDb();
  d.query("UPDATE campaigns SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").run(Date.now(), id);
  return (d.query("SELECT updated_at FROM campaigns WHERE id = ?").get(id) as { updated_at: number } | null)?.updated_at ?? Date.now();
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
  summaryCache.delete(id);
  meetingCache.delete(id);
}

// The home page asks for every campaign's counts on each visit. A campaign's counts only change
// when it does, and every write bumps updated_at, so they are cached against it.
const summaryCache = new Map<string, { updatedAt: number; summary: CampaignSummary }>();

export function listCampaigns(): CampaignSummary[] {
  const d = getDb();
  const recs = d.query(`SELECT ${CAMPAIGN_COLS} FROM campaigns ORDER BY updated_at DESC`).all() as CampaignRecord[];
  return recs.map((r) => {
    const hit = summaryCache.get(r.id);
    if (hit && hit.updatedAt === r.updated_at) return { ...hit.summary, name: r.name };
    const c = toCampaign(r);
    const byStatus: Record<string, number> = {};
    let prospects = 0;
    let screened = 0;
    for (const row of listRows(c.id)) {
      if (isScreened(row, c.schema)) {
        screened++;
        continue;
      }
      prospects++;
      const s = c.schema.statusKey ? String(row.cells[c.schema.statusKey] ?? "") : "";
      const key = s || "Not set";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    const summary: CampaignSummary = {
      id: c.id,
      name: c.name,
      updatedAt: c.updatedAt,
      sourceName: c.sourceName,
      prospects,
      screened,
      byStatus,
      stages: stagesOf(c.schema),
    };
    summaryCache.set(c.id, { updatedAt: r.updated_at, summary });
    return summary;
  });
}

// ---------- rows ----------

interface RowRecord {
  id: string;
  position: number;
  source_sheet: string | null;
  source_row: number | null;
  cells_json: string;
  orig_json?: string | null;
}

const toRow = (r: RowRecord): Row => ({
  id: r.id,
  position: r.position,
  sourceSheet: r.source_sheet,
  sourceRow: r.source_row,
  cells: JSON.parse(r.cells_json),
});

const ROW_COLS = "id, position, source_sheet, source_row, cells_json";

export function listRows(campaignId: string): Row[] {
  return (
    getDb().query(`SELECT ${ROW_COLS} FROM rows WHERE campaign_id = ? ORDER BY position`).all(campaignId) as RowRecord[]
  ).map(toRow);
}

export function getRow(campaignId: string, rowId: string): Row | null {
  const r = getDb().query(`SELECT ${ROW_COLS} FROM rows WHERE id = ? AND campaign_id = ?`).get(rowId, campaignId) as RowRecord | null;
  return r ? toRow(r) : null;
}

/** A row for export: with its cells as imported (`null` for rows made in the app). */
export type ExportRow = Row & { orig: Record<string, CellValue> | null };

export function listRowsForExport(campaignId: string): ExportRow[] {
  return (
    getDb().query(`SELECT ${ROW_COLS}, orig_json FROM rows WHERE campaign_id = ? ORDER BY position`).all(campaignId) as RowRecord[]
  ).map((r) => ({ ...toRow(r), orig: r.orig_json ? JSON.parse(r.orig_json) : null }));
}

/** Every key any row has a value for, deleted columns included, so a new column never inherits one. */
export function allCellKeys(campaignId: string): Set<string> {
  const rows = getDb()
    .query("SELECT DISTINCT j.key AS key FROM rows, json_each(rows.cells_json) AS j WHERE rows.campaign_id = ?")
    .all(campaignId) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

// A deleted row's import-time cells, kept in memory so Undo can put it back exactly as it was
// (and so export still knows which of its cells were never changed).
const deletedOrig = new Map<string, string | null>();
const DELETED_LIMIT = 20_000;

export function insertRows(campaignId: string, rows: Partial<Row>[]): Row[] {
  const d = getDb();
  const max = (d.query("SELECT MAX(position) AS m FROM rows WHERE campaign_id = ?").get(campaignId) as { m: number | null }).m ?? -1;
  const out: Row[] = [];
  d.transaction(() => {
    const ins = d.query(
      "INSERT OR REPLACE INTO rows (id, campaign_id, bucket, position, source_sheet, source_row, cells_json, orig_json) VALUES (?, ?, 'prospects', ?, ?, ?, ?, ?)",
    );
    rows.forEach((r, i) => {
      const row: Row = {
        id: r.id ?? newId(),
        position: r.position ?? max + 1 + i,
        cells: r.cells ?? {},
        sourceSheet: r.sourceSheet ?? null,
        sourceRow: r.sourceRow ?? null,
      };
      const orig = row.sourceRow ? deletedOrig.get(row.id) ?? null : null;
      deletedOrig.delete(row.id);
      ins.run(row.id, campaignId, row.position, row.sourceSheet ?? null, row.sourceRow ?? null, JSON.stringify(row.cells), orig);
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
    for (const e of edits) {
      const list = byRow.get(e.rowId);
      if (list) list.push(e);
      else byRow.set(e.rowId, [e]);
    }
    for (const [rowId, list] of byRow) {
      const r = get.get(rowId, campaignId) as { cells_json: string } | null;
      if (!r) continue;
      set.run(JSON.stringify(applyCellEdits(JSON.parse(r.cells_json), list)), rowId);
    }
  })();
  return touchCampaign(campaignId);
}

export function deleteRows(campaignId: string, ids: string[]): void {
  const d = getDb();
  d.transaction(() => {
    const get = d.query("SELECT orig_json FROM rows WHERE id = ? AND campaign_id = ?");
    const del = d.query("DELETE FROM rows WHERE id = ? AND campaign_id = ?");
    for (const id of ids) {
      const r = get.get(id, campaignId) as { orig_json: string | null } | null;
      if (!r) continue;
      if (deletedOrig.size >= DELETED_LIMIT) deletedOrig.delete(deletedOrig.keys().next().value!);
      deletedOrig.set(id, r.orig_json);
      del.run(id, campaignId);
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

const meetingCache = new Map<string, { updatedAt: number; meetings: Meeting[] }>();

export function listMeetings(): Meeting[] {
  const d = getDb();
  const recs = d.query(`SELECT ${CAMPAIGN_COLS} FROM campaigns`).all() as CampaignRecord[];
  const out: Meeting[] = [];
  for (const rec of recs) {
    const hit = meetingCache.get(rec.id);
    if (hit && hit.updatedAt === rec.updated_at) {
      out.push(...hit.meetings.map((m) => ({ ...m, campaignName: rec.name })));
      continue;
    }
    const c = toCampaign(rec);
    const s = c.schema;
    const meetings: Meeting[] = [];
    if (s.meetingAtKey) {
      // Only rows with a meeting time are read in full.
      const rows = (
        d.query(`SELECT ${ROW_COLS} FROM rows WHERE campaign_id = ? AND json_extract(cells_json, ?) IS NOT NULL`)
          .all(c.id, `$."${s.meetingAtKey}"`) as RowRecord[]
      ).map(toRow);
      for (const row of rows) {
        if (isScreened(row, s)) continue;
        const at = row.cells[s.meetingAtKey];
        if (!at || typeof at !== "string") continue;
        const status = s.statusKey ? (row.cells[s.statusKey] as string | undefined) ?? null : null;
        if (status === DEAD) continue;
        const { title, subtitle } = rowTitle(row, s);
        meetings.push({
          campaignId: c.id,
          campaignName: c.name,
          rowId: row.id,
          title,
          subtitle,
          at,
          url: s.meetingUrlKey ? ((row.cells[s.meetingUrlKey] as string | undefined) ?? null) : null,
          status,
        });
      }
    }
    meetingCache.set(c.id, { updatedAt: rec.updated_at, meetings });
    out.push(...meetings);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------- settings ----------

export function getSetting<T>(key: string, fallback: T): T {
  const r = getDb().query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb().query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
}
