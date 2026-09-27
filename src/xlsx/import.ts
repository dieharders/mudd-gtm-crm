/**
 * Spreadsheet → campaign.
 *
 * Two steps, because the user chooses which tab is which: `inspectWorkbook` lists the tabs with a
 * guessed role each, and `importWorkbook` reads the two chosen tabs (Prospects, and optionally
 * Screened out) into one schema and one list of rows. Every other tab is left alone and written
 * back untouched on export.
 */
import ExcelJS from "exceljs";
import { norm } from "../shared/merge";
import type { CampaignSchema, Column, InspectSheet, Row, SheetMeta, SheetRole } from "../shared/types";
import { colLetter, colNumber, readCellValue } from "./cells";
import {
  assignRoles, charsToPx, detectType, ensureAppColumns, makeKey, parseListFormula, sameHeader,
  type ColumnSample,
} from "./layouts";

export const TEMPLATES_SHEET = "Intro templates";

export function isCsvName(name: string): boolean {
  return /\.(csv|tsv|txt)$/i.test(name);
}

// ---------- CSV ----------

export function parseDelimited(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export async function loadWorkbook(buf: Uint8Array, fileName: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (isCsvName(fileName)) {
    const text = new TextDecoder().decode(buf).replace(/^﻿/, "");
    const ws = wb.addWorksheet("Prospects");
    for (const r of parseDelimited(text)) {
      ws.addRow(r.map((v) => {
        const t = v.trim();
        return /^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t) ? Number(t) : v;
      }));
    }
    return wb;
  }
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

// ---------- reading a sheet ----------

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" || (typeof v === "object" && v !== null && "richText" in v && !(v as { richText: { text: string }[] }).richText.map((r) => r.text).join(""));

export interface SheetTable {
  headers: string[];
  lastCol: number;
  lastDataRow: number;
  hasFormulas: boolean;
  samples: ColumnSample[];
  rows: { r: number; values: ExcelJS.CellValue[] }[];
  /** Note rows under the data, after a blank row ("From Rob's sheet, 4 Sep"). Kept, not imported. */
  trailer?: { from: number; to: number };
}

function listValidations(ws: ExcelJS.Worksheet): Map<number, string> {
  const byCol = new Map<number, string>();
  const model = (ws as unknown as { dataValidations?: { model?: Record<string, ExcelJS.DataValidation | undefined> } })
    .dataValidations?.model ?? {};
  for (const [addr, dv] of Object.entries(model)) {
    if (!dv || dv.type !== "list" || !dv.formulae?.[0]) continue;
    const first = addr.split(":")[0]!;
    const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(first);
    if (!m) continue;
    const col = colNumber(m[1]!);
    const end = addr.includes(":") ? +(/(\d+)$/.exec(addr)?.[1] ?? m[2]) : +m[2]!;
    if (end < 2) continue; // a validation on the header row only
    if (!byCol.has(col)) byCol.set(col, String(dv.formulae[0]));
  }
  return byCol;
}

export function readSheet(ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook): SheetTable {
  const headerRow = ws.getRow(1);
  let lastCol = 0;
  const maxCol = Math.max(ws.columnCount, headerRow.cellCount);
  for (let c = 1; c <= maxCol; c++) if (!isEmpty(headerRow.getCell(c).value)) lastCol = c;

  let lastDataRow = 1;
  let hasFormulas = false;
  const rows: SheetTable["rows"] = [];
  const width = Math.max(lastCol, 1);
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: ExcelJS.CellValue[] = [];
    let any = false;
    for (let c = 1; c <= width; c++) {
      const v = row.getCell(c).value;
      values.push(v);
      if (!isEmpty(v)) any = true;
      if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) hasFormulas = true;
    }
    if (any) {
      lastDataRow = r;
      rows.push({ r, values });
    }
  }

  // A short run of one-cell rows after a blank gap is a footnote, not data. Anything bigger is
  // data with a stray blank row in it, and is imported whole.
  let trailer: SheetTable["trailer"];
  const gapAt = rows.findIndex((row, i) => i > 0 && row.r > rows[i - 1]!.r + 1);
  if (gapAt > 0) {
    const tail = rows.slice(gapAt);
    const noteLike = tail.length <= 3 && tail.every((t) => t.values.filter((v) => !isEmpty(v)).length === 1);
    if (noteLike) {
      trailer = { from: tail[0]!.r, to: tail.at(-1)!.r };
      rows.splice(gapAt);
      lastDataRow = rows.at(-1)!.r;
    }
  }

  const dvs = listValidations(ws);
  const headers: string[] = [];
  const samples: ColumnSample[] = [];
  for (let c = 1; c <= lastCol; c++) {
    const text = headerRow.getCell(c).text?.trim() || `Column ${colLetter(c)}`;
    headers.push(text);
    const numFmts: (string | undefined)[] = [];
    for (let r = 2; r <= Math.min(Math.max(lastDataRow, 2), 60); r++) numFmts.push(ws.getRow(r).getCell(c).numFmt);
    samples.push({
      header: text,
      values: rows.map((row) => row.values[c - 1]),
      numFmts,
      listOptions: parseListFormula(dvs.get(c), wb),
    });
  }
  return { headers, lastCol, lastDataRow, hasFormulas, samples, rows, trailer };
}

// ---------- inspect ----------

export function guessRoles(sheets: Omit<InspectSheet, "guess">[]): SheetRole[] {
  const roles: SheetRole[] = sheets.map(() => "passthrough");
  sheets.forEach((s, i) => {
    if (s.name === TEMPLATES_SHEET) roles[i] = "templates";
  });
  const screened = sheets.findIndex(
    (s, i) => roles[i] === "passthrough" && !s.hasFormulas && s.cols > 0 && /screen|disqual|reject|exclu|do.?not|dnc|dropped/i.test(s.name),
  );
  if (screened >= 0) roles[screened] = "screened";
  let prospects = sheets.findIndex((s, i) => roles[i] === "passthrough" && s.hasStatus && !s.hasFormulas);
  if (prospects < 0) prospects = sheets.findIndex((s, i) => roles[i] === "passthrough" && !s.hasFormulas && s.cols > 1);
  if (prospects >= 0) roles[prospects] = "prospects";
  return roles;
}

export function inspectWorkbook(wb: ExcelJS.Workbook): { sheets: InspectSheet[]; templates: number } {
  const base = wb.worksheets.map((ws) => {
    const t = readSheet(ws, wb);
    return {
      name: ws.name,
      rows: t.rows.length,
      cols: t.lastCol,
      headers: t.headers.slice(0, 10),
      hasStatus: t.headers.some((h) => ["status", "stage"].includes(norm(h))),
      hasFormulas: t.hasFormulas,
    };
  });
  const roles = guessRoles(base);
  const tpl = wb.getWorksheet(TEMPLATES_SHEET);
  return {
    sheets: base.map((s, i) => ({ ...s, guess: roles[i]! })),
    templates: tpl ? readTemplates(tpl, wb).length : 0,
  };
}

// ---------- import ----------

export interface ImportedCampaign {
  schema: CampaignSchema;
  sheets: SheetMeta[];
  rows: Omit<Row, "id">[];
  templates: { name: string; body: string }[];
}

function readTemplates(ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook): { name: string; body: string }[] {
  const t = readSheet(ws, wb);
  const nameIdx = t.headers.findIndex((h) => norm(h) === "name");
  const bodyIdx = t.headers.findIndex((h) => ["template", "body", "message", "text"].includes(norm(h)));
  if (bodyIdx < 0) return [];
  return t.rows
    .map((r, i) => ({
      name: String(readCellValue(r.values[nameIdx] ?? null) ?? `Template ${i + 1}`),
      body: String(readCellValue(r.values[bodyIdx] ?? null) ?? ""),
    }))
    .filter((x) => x.body.trim());
}

export function importWorkbook(
  wb: ExcelJS.Workbook,
  choice: { prospects: string; screened: string | null },
): ImportedCampaign {
  const pws = wb.getWorksheet(choice.prospects);
  if (!pws) throw new Error(`No tab named "${choice.prospects}" in this workbook.`);
  const sws = choice.screened ? wb.getWorksheet(choice.screened) : undefined;
  if (choice.screened && !sws) throw new Error(`No tab named "${choice.screened}" in this workbook.`);
  if (sws && sws.name === pws.name) throw new Error("Prospects and Screened out must be different tabs.");

  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: [] };
  const pt = readSheet(pws, wb);
  const pMap: Record<string, number> = {};
  pt.samples.forEach((s, i) => {
    const t = detectType(s);
    const col: Column = {
      key: makeKey(s.header, taken),
      header: s.header,
      ...t,
      width: charsToPx(pws.getColumn(i + 1).width, t.type),
      origin: "sheet",
      importedHeader: s.header,
    };
    schema.columns.push(col);
    pMap[col.key] = i + 1;
  });
  assignRoles(schema);

  const sMap: Record<string, number> = {};
  let st: SheetTable | undefined;
  if (sws) {
    st = readSheet(sws, wb);
    st.samples.forEach((s, i) => {
      const match = schema.columns.find((c) => !(c.key in sMap) && sameHeader(c.header, s.header));
      if (match) {
        sMap[match.key] = i + 1;
        return;
      }
      const t = detectType(s);
      const col: Column = {
        key: makeKey(s.header, taken),
        header: s.header,
        ...t,
        width: charsToPx(sws.getColumn(i + 1).width, t.type),
        origin: "sheet",
        importedHeader: s.header,
      };
      schema.columns.push(col);
      sMap[col.key] = i + 1;
      if (!schema.reasonKey && (/why|reason|fail|filter|screen/i.test(s.header) || t.type === "longtext")) {
        schema.reasonKey = col.key;
      }
    });
  }
  ensureAppColumns(schema);

  const rows: Omit<Row, "id">[] = [];
  const pushRows = (table: SheetTable, map: Record<string, number>, bucket: Row["bucket"], sheet: string) => {
    for (const r of table.rows) {
      const cells: Row["cells"] = {};
      for (const col of schema.columns) {
        const idx = map[col.key];
        if (!idx) continue;
        const v = readCellValue(r.values[idx - 1] ?? null, col.type);
        if (v !== null) cells[col.key] = v;
      }
      rows.push({ bucket, position: rows.length, cells, sourceSheet: sheet, sourceRow: r.r });
    }
  };
  pushRows(pt, pMap, "prospects", pws.name);
  if (st && sws) pushRows(st, sMap, "screened", sws.name);

  const sheets: SheetMeta[] = wb.worksheets.map((ws) => {
    if (ws.name === pws.name) return { name: ws.name, role: "prospects", colMap: pMap, lastDataRow: pt.lastDataRow, lastCol: pt.lastCol, trailer: pt.trailer };
    if (sws && ws.name === sws.name) return { name: ws.name, role: "screened", colMap: sMap, lastDataRow: st!.lastDataRow, lastCol: st!.lastCol, trailer: st!.trailer };
    const role: SheetRole = ws.name === TEMPLATES_SHEET ? "templates" : "passthrough";
    return { name: ws.name, role, colMap: {}, lastDataRow: 0, lastCol: 0 };
  });

  const tpl = wb.getWorksheet(TEMPLATES_SHEET);
  return { schema, sheets, rows, templates: tpl ? readTemplates(tpl, wb) : [] };
}
