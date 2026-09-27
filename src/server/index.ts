/**
 * The REST API the page talks to. Same-origin JSON over 127.0.0.1; nothing here makes an
 * outbound request.
 */
import fs from "node:fs";
import path from "node:path";
import type { Bucket, CampaignSchema, CellEdit, InspectResult, Row } from "../shared/types";
import { exportCampaign } from "../xlsx/export";
import { importWorkbook, inspectWorkbook, isCsvName, loadWorkbook } from "../xlsx/import";
import { copySchema, genericSchema } from "../xlsx/layouts";
import * as db from "./db";
import { dialogsSupported, downloadsDir, openDialog, openExternal, saveDialog } from "./dialogs";

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
  if (!/\.(xlsx|xlsm|csv|tsv|txt)$/i.test(fileName)) {
    throw new HttpError(400, `${fileName} is not a spreadsheet Mudd can read. Use .xlsx or .csv.`);
  }
  let wb;
  try {
    wb = await loadWorkbook(buf, fileName);
  } catch (err) {
    throw new HttpError(400, `Could not read ${fileName}: ${(err as Error).message}`);
  }
  const { sheets, templates } = inspectWorkbook(wb);
  const token = stage({ buf, fileName, path: filePath, mtime });
  return { token, fileName, path: filePath, sheets, templates };
}

async function doImport(req: Request) {
  const b = await body<{ token: string; name?: string; prospects: string; screened: string | null }>(req);
  const s = staged.get(b.token);
  if (!s) throw new HttpError(410, "That upload expired. Please import the file again.");
  const wb = await loadWorkbook(s.buf, s.fileName);
  const imp = importWorkbook(wb, { prospects: b.prospects, screened: b.screened ?? null });
  const csv = isCsvName(s.fileName);
  const base = s.fileName.replace(/\.[^.]+$/, "");
  const campaign = db.createCampaign({
    name: b.name?.trim() || (wb.worksheets.length > 1 && !csv ? `${base} · ${b.prospects}` : base),
    schema: imp.schema,
    sheets: csv ? [] : imp.sheets,
    sourceName: s.fileName,
    // A CSV has nowhere to keep formatting, so its "original" is not something to write back to.
    sourcePath: csv ? null : s.path,
    sourceMtime: csv ? null : s.mtime,
    original: csv ? null : s.buf,
    rows: imp.rows,
    templates: imp.templates,
  });
  staged.delete(b.token);
  return campaign;
}

// ---------- export ----------

const safeFileName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "campaign";

function defaultExportName(c: ReturnType<typeof mustCampaign>): string {
  if (c.sourceName && !isCsvName(c.sourceName)) return c.sourceName;
  return `${safeFileName(c.name)}.xlsx`;
}

async function buildExport(id: string) {
  const c = mustCampaign(id);
  const bytes = await exportCampaign(c, db.getOriginal(id), db.listRows(id), db.listTemplates(id));
  return { c, bytes };
}

function writeFileSafely(target: string, bytes: Uint8Array, backup: boolean): void {
  try {
    if (backup && fs.existsSync(target)) {
      const bak = target.replace(/(\.[^.\\/]+)?$/, ".bak$1");
      fs.copyFileSync(target, bak);
    }
    fs.writeFileSync(target, bytes);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new HttpError(423, `${path.basename(target)} is open in another program (probably Excel). Close it there and try again.`, { code: "locked" });
    }
    throw err;
  }
}

async function doExport(id: string, req: Request) {
  const b = await body<{ target: "original" | "saveAs" | "download"; force?: boolean }>(req);
  const { c, bytes } = await buildExport(id);
  const name = defaultExportName(c);

  if (b.target === "download") {
    return new Response(new Blob([bytes as BlobPart]), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        ...SECURITY_HEADERS,
      },
    });
  }

  if (b.target === "original") {
    if (!c.sourcePath) throw new HttpError(400, "This campaign is not linked to a file yet. Use Save as.");
    const recorded = db.getSourceMtime(id);
    if (fs.existsSync(c.sourcePath) && recorded && !b.force) {
      const now = Math.round(fs.statSync(c.sourcePath).mtimeMs);
      if (Math.abs(now - recorded) > 2000) {
        throw new HttpError(409, `${path.basename(c.sourcePath)} was changed outside Mudd since it was imported. Saving will replace those changes (a .bak copy is kept).`, { code: "changed" });
      }
    }
    writeFileSafely(c.sourcePath, bytes, true);
    db.setSource(id, c.sourcePath, Math.round(fs.statSync(c.sourcePath).mtimeMs));
    return json({ path: c.sourcePath });
  }

  // saveAs
  const suggested = c.sourcePath ? path.join(path.dirname(c.sourcePath), name) : path.join(downloadsDir(), name);
  const pick = await saveDialog(suggested);
  if ("unsupported" in pick) return fail(501, "No native save dialog on this system; use Download.", { code: "unsupported" });
  if ("cancelled" in pick) return json({ cancelled: true });
  writeFileSafely(pick.path, bytes, false);
  const mtime = Math.round(fs.statSync(pick.path).mtimeMs);
  // The first Save As links a campaign to a file, so the next export can simply "Save".
  if (!c.sourcePath) db.setSource(id, pick.path, mtime);
  else if (path.resolve(pick.path) === path.resolve(c.sourcePath)) db.setSource(id, pick.path, mtime);
  return json({ path: pick.path, linked: !c.sourcePath });
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
  return json({ campaign, rows: db.listRows(id!), templates: db.listTemplates(id!) });
});
on("PATCH", "/api/campaigns/:id", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ name?: string; schema?: CampaignSchema }>(req);
  if (b.name !== undefined && !b.name.trim()) throw new HttpError(400, "The name cannot be empty.");
  return json(db.updateCampaign(id!, { name: b.name?.trim(), schema: b.schema }));
});
on("DELETE", "/api/campaigns/:id", (_req, [id]) => {
  db.deleteCampaign(id!);
  return json({ ok: true });
});

on("POST", "/api/campaigns/:id/rows", async (req, [id]) => {
  mustCampaign(id!);
  const b = await body<{ rows: (Partial<Row> & { bucket: Bucket })[] }>(req);
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
on("POST", "/api/campaigns/:id/rows/move", async (req, [id]) => {
  const b = await body<{ ids: string[]; bucket: Bucket; positions?: Record<string, number> }>(req);
  if (b.bucket !== "prospects" && b.bucket !== "screened") throw new HttpError(400, "Unknown bucket.");
  db.moveRows(id!, b.ids ?? [], b.bucket, b.positions);
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
on("POST", "/api/campaigns/:id/export", async (req, [id]) => doExport(id!, req));

on("POST", "/api/dialog/open", async () => json(await openDialog()));
on("POST", "/api/open-url", async (req) => {
  const b = await body<{ url: string }>(req);
  return openExternal(b.url) ? json({ ok: true }) : fail(400, "Only web and mailto links can be opened.");
});
on("GET", "/api/meetings", () => json(db.listMeetings()));

export function createFetchHandler() {
  return async (req: Request): Promise<Response> => {
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
