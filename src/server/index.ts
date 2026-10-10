/**
 * The REST API the page talks to. Same-origin JSON over 127.0.0.1, refused to any other site
 * (see fromOwnPage); nothing here makes an outbound request.
 */
import fs from "node:fs";
import path from "node:path";
import { copySchema, genericSchema } from "../shared/schema";
import { IMPORT_EXTENSIONS, type CampaignSchema, type CellEdit, type InspectResult, type Row } from "../shared/types";
import { exportCampaign } from "../xlsx/export";
import { importWorkbook, inspectWorkbook, isCsvName, loadWorkbook, type LoadedBook } from "../xlsx/import";
import * as db from "./db";
import { registerAiRoutes } from "./ai-routes";
import { dialogsSupported, downloadsDir, openDialog, openExternal } from "./dialogs";
import { stopCampaignRuns } from "./enrich/runner";
import { markInterruptedRuns } from "./enrich/store";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

function mustCampaign(id: string) {
  const c = db.getCampaign(id);
  if (!c) throw new HttpError(404, "Campaign not found.");
  return c;
}

// ---------- import staging ----------
// A file is read once to list its tabs, then imported once the user has mapped them. Between
// the two it waits here, in memory, for at most ten minutes.

interface Staged {
  buf: Uint8Array;
  fileName: string;
  path: string | null;
  mtime: number | null;
  /** The workbook as parsed for inspect, so import does not parse it a second time. */
  book: LoadedBook;
  at: number;
}
const staged = new Map<string, Staged>();
const STAGE_TTL = 10 * 60_000;

function stage(s: Omit<Staged, "at">): string {
  const now = Date.now();
  for (const [k, v] of staged) if (now - v.at > STAGE_TTL) staged.delete(k);
  const token = db.newId();
  staged.set(token, { ...s, at: now });
  return token;
}

async function inspect(req: Request): Promise<InspectResult> {
  let buf: Uint8Array;
  let fileName: string;
  let filePath: string | null = null;
  let mtime: number | null = null;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "No file in the upload.");
    buf = new Uint8Array(await file.arrayBuffer());
    fileName = file.name;
  } else {
    const { path: p } = await body<{ path: string }>(req);
    if (!p || !fs.existsSync(p)) throw new HttpError(400, "That file could not be found.");
    buf = new Uint8Array(fs.readFileSync(p));
    fileName = path.basename(p);
    filePath = p;
    mtime = Math.round(fs.statSync(p).mtimeMs);
  }
  if (/\.xlsm$/i.test(fileName)) {
    throw new HttpError(400, `${fileName} has macros, and saving it would lose them. In Excel, use File › Save As › Excel Workbook (.xlsx) and import that copy.`);
  }
  if (!IMPORT_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))) {
    throw new HttpError(400, `${fileName} is not a spreadsheet Mudd can read. Use .xlsx or .csv.`);
  }
  let book: LoadedBook;
  try {
    book = await loadWorkbook(buf, fileName);
  } catch (err) {
    throw new HttpError(400, `Could not read ${fileName}: ${(err as Error).message}`);
  }
  const { sheets, templates } = inspectWorkbook(book);
  const token = stage({ buf, fileName, path: filePath, mtime, book });
  return { token, fileName, path: filePath, sheets, templates };
}

async function doImport(req: Request) {
  const b = await body<{ token: string; name?: string; prospects: string }>(req);
  const s = staged.get(b.token);
  if (!s) throw new HttpError(410, "That upload expired. Please import the file again.");
  let imp;
  try {
    imp = importWorkbook(s.book, { prospects: b.prospects });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const csv = isCsvName(s.fileName);
  const base = s.fileName.replace(/\.[^.]+$/, "");
  const campaign = db.createCampaign({
    name: b.name?.trim() || (s.book.wb.worksheets.length > 1 && !csv ? `${base} · ${b.prospects}` : base),
    schema: imp.schema,
    sheets: csv ? [] : imp.sheets,
    sourceName: s.fileName,
    // A CSV has nowhere to keep formatting, so its "original" is not something to write back to.
    sourcePath: csv ? null : s.path,
    sourceMtime: csv ? null : s.mtime,
    original: csv ? null : s.buf,
    rows: imp.rows,
    contacts: imp.contacts,
    templates: imp.templates,
  });
  staged.delete(b.token);
  return { ...campaign, skippedContacts: imp.skippedContacts, mismatchedContacts: imp.mismatchedContacts };
}

// ---------- Save file ----------

// eslint-disable-next-line no-control-regex -- control characters can't be in a file name
const safeFileName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "campaign";

/** The file name a save uses when there is no file to write over: always an .xlsx. */
function exportName(c: ReturnType<typeof mustCampaign>): string {
  if (c.sourceName && !isCsvName(c.sourceName)) return c.sourceName.replace(/\.xlsm$/i, ".xlsx");
  return `${safeFileName(c.name)}.xlsx`;
}

/** `dir/name`, or `dir/name (2)` and so on when that file exists. */
function freePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  return target;
}

const mtimeOf = (p: string) => Math.round(fs.statSync(p).mtimeMs);
const BACKUPS_KEPT = 10;

/**
 * Before a file is overwritten: a `.bak` copy next to it (the previous version, where the user
 * will look), and a dated copy in Mudd's data folder, of which the last ten are kept.
 */
function backUp(campaignId: string, target: string): void {
  if (!fs.existsSync(target)) return;
  fs.copyFileSync(target, target.replace(/(\.[^.\\/]+)?$/, ".bak$1"));
  const dir = path.join(db.dataDir(), "backups", campaignId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(target, path.join(dir, `${stamp} ${path.basename(target)}`));
  const old = fs.readdirSync(dir).sort().slice(0, -BACKUPS_KEPT);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
}

function writeFileSafely(target: string, bytes: Uint8Array): void {
  try {
    fs.writeFileSync(target, bytes);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new HttpError(423, `${path.basename(target)} is open in another program (probably Excel). Close it there and try again.`, { code: "locked" });
    }
    throw err;
  }
}

/**
 * Save file: write over the file the campaign was imported from, with no dialog. When Mudd does
 * not know where that is (dropped in, a CSV, created in Mudd, or its folder is gone), the file
 * goes to Downloads and the campaign is linked to it, so the next save writes there again.
 * `copy` always writes a new file in Downloads and changes no link.
 */
async function saveFile(id: string, req: Request) {
  const b = await body<{ force?: boolean; copy?: boolean }>(req);
  const c = mustCampaign(id);
  const inPlace = !b.copy && !!c.sourcePath && !/\.xlsm$/i.test(c.sourcePath) && fs.existsSync(path.dirname(c.sourcePath));

  // The cheap check first: a file edited outside Mudd is not replaced without asking.
  if (inPlace && fs.existsSync(c.sourcePath!) && !b.force) {
    const recorded = db.getSourceMtime(id);
    if (recorded && Math.abs(mtimeOf(c.sourcePath!) - recorded) > 2000) {
      throw new HttpError(409, `${path.basename(c.sourcePath!)} was changed outside Mudd since it was last saved here. Saving replaces those changes (the previous version is kept as a .bak copy).`, { code: "changed" });
    }
  }

  const bytes = await exportCampaign(c, db.getOriginal(id), db.listRowsForExport(id), db.listTemplates(id), db.listRowsForExport(id, "contacts"));
  if (inPlace) {
    backUp(id, c.sourcePath!);
    writeFileSafely(c.sourcePath!, bytes);
    db.setSource(id, c.sourcePath!, mtimeOf(c.sourcePath!));
    return json({ path: c.sourcePath, linked: true });
  }
  fs.mkdirSync(downloadsDir(), { recursive: true });
  const target = freePath(downloadsDir(), exportName(c));
  writeFileSafely(target, bytes);
  if (!b.copy) db.setSource(id, target, mtimeOf(target));
  return json({ path: target, linked: !b.copy });
}

// ---------- router ----------

type Handler = (req: Request, params: string[]) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

on("GET", "/api/env", () => json({ platform: process.platform, dialogs: dialogsSupported(), dataDir: db.dataDir() }));

on("GET", "/api/campaigns", () => json(db.listCampaigns()));
on("POST", "/api/campaigns", async (req) => {
  const b = await body<{ name: string; layout: "generic" | { copyFrom: string } }>(req);
  if (!b.name?.trim()) throw new HttpError(400, "Give the campaign a name.");
  let schema: CampaignSchema;
  if (b.layout && typeof b.layout === "object") schema = copySchema(mustCampaign(b.layout.copyFrom).schema);
  else schema = genericSchema();
  return json(db.createCampaign({ name: b.name.trim(), schema, sheets: [] }));
});
on("GET", "/api/campaigns/:id", (_req, [id]) => {
  const campaign = mustCampaign(id!);
  return json({ campaign, rows: db.listRows(id!), contacts: db.listRows(id!, "contacts"), templates: db.listTemplates(id!) });
});
on("PATCH", "/api/campaigns/:id", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ name?: string; schema?: CampaignSchema }>(req);
  if (b.name !== undefined && !b.name.trim()) throw new HttpError(400, "The name cannot be empty.");
  return json(db.updateCampaign(id!, { name: b.name?.trim(), schema: b.schema }));
});
// Removes the campaign from Mudd only: no file is ever deleted.
on("DELETE", "/api/campaigns/:id", (_req, [id]) => {
  stopCampaignRuns(id!);
  db.deleteCampaign(id!);
  return json({ ok: true });
});

on("POST", "/api/campaigns/:id/rows", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ rows: Partial<Row>[] }>(req);
  return json(db.insertRows(id!, b.rows ?? []));
});
on("PATCH", "/api/campaigns/:id/rows", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ edits: CellEdit[] }>(req);
  return json({ updatedAt: db.applyEdits(id!, b.edits ?? []) });
});
on("DELETE", "/api/campaigns/:id/rows", async (req, [id]) => {
  const b = await body<{ ids: string[] }>(req);
  db.deleteRows(id!, b.ids ?? []);
  return json({ ok: true });
});

on("GET", "/api/campaigns/:id/templates", (_req, [id]) => json(db.listTemplates(id!)));
on("POST", "/api/campaigns/:id/templates", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ name: string; body: string }>(req);
  return json(db.createTemplate(id!, b.name?.trim() || "Untitled template", b.body ?? ""));
});
on("PATCH", "/api/templates/:id", async (req, [id]) => {
  const b = await body<{ name?: string; body?: string }>(req);
  const t = db.updateTemplate(id!, b);
  return t ? json(t) : fail(404, "Template not found.");
});
on("DELETE", "/api/templates/:id", (_req, [id]) => {
  db.deleteTemplate(id!);
  return json({ ok: true });
});

on("POST", "/api/import/inspect", async (req) => json(await inspect(req)));
on("POST", "/api/import", async (req) => json(await doImport(req)));
on("POST", "/api/campaigns/:id/save", async (req, [id]) => saveFile(id!, req));

on("POST", "/api/dialog/open", async () => json(await openDialog()));
on("POST", "/api/open-url", async (req) => {
  const b = await body<{ url: string }>(req);
  return openExternal(b.url) ? json({ ok: true }) : fail(400, "Only web and mailto links can be opened.");
});
on("GET", "/api/meetings", () => json(db.listMeetings()));

registerAiRoutes(on, {
  json,
  body,
  fail: (status, message) => {
    throw new HttpError(status, message);
  },
});

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Only Mudd's own page may call the API. Any website open in the user's browser can send requests
 * to 127.0.0.1 too. A DNS-rebound name (evil.com resolving to 127.0.0.1) arrives with that name in
 * the Host header, which Bun puts in `req.url`, so the host must be loopback. Browsers attach an
 * Origin to every cross-site write, so when there is one it must be this server's own.
 */
export function fromOwnPage(req: Request): boolean {
  const url = new URL(req.url);
  if (!LOOPBACK.has(url.hostname)) return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === url.origin;
}

export function createFetchHandler() {
  try {
    markInterruptedRuns();
  } catch (err) {
    console.error("could not tidy interrupted runs:", err);
  }
  return async (req: Request): Promise<Response> => {
    if (!fromOwnPage(req)) return fail(403, "Requests from other sites are not allowed.");
    const url = new URL(req.url);
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        return await h(req, m.slice(1).map(decodeURIComponent));
      } catch (err) {
        if (err instanceof HttpError) return fail(err.status, err.message, err.extra);
        console.error(err);
        return fail(500, (err as Error).message || "Something went wrong.");
      }
    }
    return fail(404, `No route for ${req.method} ${url.pathname}`);
  };
}
