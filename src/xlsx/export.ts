/**
 * Campaign → spreadsheet, patched INTO the workbook it came from.
 *
 * The rule the whole file follows: change as little as possible. The original workbook is
 * loaded, and only the two bucket sheets and the templates sheet are rewritten; every other
 * tab (Summary and its formulas, a second prospect tab that belongs to a different campaign)
 * is carried through as ExcelJS read it.
 *
 * On a bucket sheet:
 *   - every existing column keeps its letter, so formulas elsewhere keep pointing at the right
 *     data; new columns are appended after the last one
 *   - a row keeps the cell styles of the row it was read from (tier-1 beige, yellow "yours"
 *     cells); a new row takes the styles of the first empty row under the original data
 *   - a cell the user did not edit keeps its original value object, so rich text, hyperlinks and
 *     formulas survive; an edited cell is written with a real type (Date, number, hyperlink)
 *
 * ExcelJS mangles two things on write, and ./postprocess.ts puts them back from the original
 * XML: the <cols> width list (it drops a width equal to its own default) and the
 * <dataValidations> block (it re-splits each range into overlapping pieces).
 */
import ExcelJS from "exceljs";
import type { Campaign, CampaignSchema, Column, Row, SheetMeta, Template } from "../shared/types";
import { cloneStyle, colLetter, colNumber, numFmtFor, readCellValue, sameValue, toExcelValue } from "./cells";
import { TEMPLATES_SHEET } from "./import";
import { dataStyle, listFormula, pxToChars, STYLE, styleGeneratedSheet, validations, VALIDATION_ROWS } from "./layouts";
import { restoreSheetXml, type SheetPatch } from "./postprocess";

type Style = Partial<ExcelJS.Style>;
interface Snap {
  height?: number;
  values: ExcelJS.CellValue[];
  styles: Style[];
}

const nonEmpty = (v: unknown) => v !== null && v !== undefined && v !== "";

function snapshotRow(ws: ExcelJS.Worksheet, r: number, width: number): Snap {
  const row = ws.getRow(r);
  const values: ExcelJS.CellValue[] = [];
  const styles: Style[] = [];
  for (let c = 1; c <= width; c++) {
    const cell = row.getCell(c);
    values.push(cell.value);
    styles.push(cloneStyle(cell.style ?? {}));
  }
  return { height: row.height, values, styles };
}

/** Which campaign columns a bucket sheet carries on export, and at which column index. */
function planColumns(meta: SheetMeta, schema: CampaignSchema, rows: Row[]) {
  const colMap: Record<string, number> = {};
  for (const [key, idx] of Object.entries(meta.colMap)) {
    if (schema.columns.some((c) => c.key === key)) colMap[key] = idx;
  }
  const appended: Column[] = [];
  let next = Math.max(meta.lastCol, ...Object.values(meta.colMap), 0) + 1;
  for (const col of schema.columns) {
    if (col.key in colMap) continue;
    const hasData = rows.some((r) => nonEmpty(r.cells[col.key]));
    // Prospects carries every column except the screening reason. Screened out carries the
    // rest only when a row in it has something there, so screening a prospect out keeps every
    // field without widening the tab with twenty empty columns.
    const include = meta.role === "prospects" ? col.key !== schema.reasonKey : hasData;
    if (!include) continue;
    colMap[col.key] = next++;
    appended.push(col);
  }
  return { colMap, appended, lastCol: next - 1 };
}

function writeBucket(
  ws: ExcelJS.Worksheet,
  meta: SheetMeta,
  schema: CampaignSchema,
  rows: Row[],
  opts: { generated: boolean; blank?: Style[] },
): SheetPatch {
  const { colMap, appended, lastCol } = planColumns(meta, schema, rows);
  const origWidth = Math.max(meta.lastCol, 1);

  const snaps = new Map<number, Snap>();
  for (let r = 2; r <= meta.lastDataRow; r++) snaps.set(r, snapshotRow(ws, r, origWidth));
  const blankSnap = opts.blank
    ? { values: [], styles: opts.blank, height: undefined }
    : snapshotRow(ws, meta.lastDataRow + 1, origWidth);
  const headerStyle = cloneStyle(ws.getCell(1, 1).style ?? STYLE.header);
  const trailer: Snap[] = [];
  if (meta.trailer) for (let r = meta.trailer.from; r <= meta.trailer.to; r++) trailer.push(snapshotRow(ws, r, origWidth));

  // Header: renamed columns, and the appended ones in the sheet's own header style.
  for (const col of schema.columns) {
    const idx = colMap[col.key];
    if (!idx) continue;
    const cell = ws.getCell(1, idx);
    if (idx > meta.lastCol) {
      cell.value = col.header;
      cell.style = cloneStyle(headerStyle);
      ws.getColumn(idx).width = pxToChars(col.width, col.type);
    } else if (col.importedHeader !== undefined && col.header !== col.importedHeader) {
      cell.value = col.header;
    }
  }

  const colsByKey = new Map(schema.columns.map((c) => [c.key, c]));
  const styleFor = (base: Snap, col: Column, idx: number): Style => {
    if (idx <= origWidth && base.styles[idx - 1]) return cloneStyle(base.styles[idx - 1]!);
    // An appended column: this row's look (its fill and border), with the column's own format.
    const neighbour = cloneStyle(base.styles[origWidth - 1] ?? STYLE.cell) as Style;
    const own = dataStyle(col, schema);
    return {
      ...neighbour,
      numFmt: own.numFmt,
      alignment: col.type === "longtext" ? { vertical: "top", wrapText: true } : neighbour.alignment,
      fill: own.fill ?? neighbour.fill,
    };
  };

  const ordered = [...rows].sort((a, b) => a.position - b.position);
  ordered.forEach((row, i) => {
    const r = i + 2;
    const src = row.sourceSheet === meta.name && row.sourceRow ? snaps.get(row.sourceRow) : undefined;
    const base = src ?? blankSnap;
    const xrow = ws.getRow(r);
    if (base.height !== undefined || xrow.height !== undefined) xrow.height = base.height as number;
    for (let c = 1; c <= origWidth; c++) {
      const cell = xrow.getCell(c);
      cell.style = cloneStyle(base.styles[c - 1] ?? {});
      cell.value = src ? src.values[c - 1] ?? null : null;
    }
    for (const [key, idx] of Object.entries(colMap)) {
      const col = colsByKey.get(key)!;
      const cell = xrow.getCell(idx);
      const v = row.cells[key] ?? null;
      if (idx > origWidth) cell.style = styleFor(base, col, idx);
      if (src && idx <= origWidth && sameValue(readCellValue(src.values[idx - 1] ?? null, col.type), v)) continue;
      cell.value = toExcelValue(v, col);
      // A typed value in a cell with no format of its own gets the column's (a date should not
      // show as 46291). A cell that already has a format keeps it: that is the sheet's choice.
      const fmt = numFmtFor(col.type);
      const typed = cell.value instanceof Date || typeof cell.value === "number";
      if (fmt && typed && (!cell.numFmt || cell.numFmt === "General")) cell.numFmt = fmt;
      if (col.type === "datetime" && cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm";
    }
  });

  // Rows the data no longer reaches: empty, in the empty-row style.
  const firstUnused = ordered.length + 2;
  const oldEnd = Math.max(meta.lastDataRow, meta.trailer?.to ?? 0);
  for (let r = firstUnused; r <= oldEnd; r++) {
    const xrow = ws.getRow(r);
    xrow.height = blankSnap.height as number;
    for (let c = 1; c <= lastCol; c++) {
      const cell = xrow.getCell(c);
      cell.value = null;
      if (c <= origWidth) cell.style = cloneStyle(blankSnap.styles[c - 1] ?? {});
      else cell.style = {};
    }
  }

  // The footnote goes back under the data, with the same blank gap above it.
  if (meta.trailer && trailer.length) {
    const gap = Math.max(1, meta.trailer.from - meta.lastDataRow - 1);
    const start = ordered.length + 1 + gap + 1;
    trailer.forEach((snap, i) => {
      const xrow = ws.getRow(start + i);
      if (snap.height !== undefined) xrow.height = snap.height;
      for (let c = 1; c <= origWidth; c++) {
        const cell = xrow.getCell(c);
        cell.style = cloneStyle(snap.styles[c - 1] ?? {});
        cell.value = snap.values[c - 1] ?? null;
      }
    });
  }

  // Autofilter: same top-left, stretched over any appended column and every row of data.
  const af = ws.autoFilter;
  if (af && typeof af === "string") {
    const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(af);
    if (m) {
      const endRow = Math.max(+m[4]!, ordered.length + 1);
      ws.autoFilter = `${m[1]}${m[2]}:${colLetter(Math.max(lastCol, colNumber(m[3]!)))}${endRow}`;
    }
  }

  const newSelects = appended.filter((c) => c.type === "select" && c.options?.length);
  if (opts.generated) {
    for (const col of newSelects) {
      const L = colLetter(colMap[col.key]!);
      validations(ws).add(`${L}2:${L}${VALIDATION_ROWS}`, { type: "list", allowBlank: true, formulae: [listFormula(col.options!)] });
    }
  }

  return {
    sheet: meta.name,
    newCols: appended.map((c) => ({ index: colMap[c.key]!, width: pxToChars(c.width, c.type) })),
    newValidations: newSelects.map((c) => {
      const L = colLetter(colMap[c.key]!);
      return { sqref: `${L}2:${L}${VALIDATION_ROWS}`, formula: listFormula(c.options!) };
    }),
  };
}

function writeTemplates(wb: ExcelJS.Workbook, templates: Template[], headerStyle: Style): void {
  const existing = wb.getWorksheet(TEMPLATES_SHEET);
  if (existing) wb.removeWorksheet(existing.id);
  if (!templates.length) return;
  const ws = wb.addWorksheet(TEMPLATES_SHEET);
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 100;
  const h = ws.getRow(1);
  h.height = 21.75;
  ["Name", "Template"].forEach((t, i) => {
    const cell = h.getCell(i + 1);
    cell.value = t;
    cell.style = cloneStyle(headerStyle);
  });
  [...templates].sort((a, b) => a.position - b.position).forEach((t, i) => {
    const row = ws.getRow(i + 2);
    row.getCell(1).value = t.name;
    row.getCell(2).value = t.body;
    for (const c of [1, 2]) {
      row.getCell(c).style = { ...cloneStyle(STYLE.cell), alignment: { vertical: "top", wrapText: true } };
    }
  });
}

/** A workbook in the base-tracker look, for a campaign that has none of its own. */
function generatedWorkbook(schema: CampaignSchema): { wb: ExcelJS.Workbook; sheets: SheetMeta[]; blanks: Record<string, Style[]> } {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mudd.io";
  const pCols = schema.columns.filter((c) => c.key !== schema.reasonKey);
  const lead = [schema.companyKey, schema.nameKey].filter(Boolean) as string[];
  const sCols = [
    ...lead.map((k) => schema.columns.find((c) => c.key === k)!),
    ...(schema.reasonKey ? [schema.columns.find((c) => c.key === schema.reasonKey)!] : []),
  ].filter(Boolean);
  if (!sCols.length) sCols.push(schema.columns[0]!);

  const make = (name: string, role: "prospects" | "screened", cols: Column[]) => {
    const ws = wb.addWorksheet(name);
    styleGeneratedSheet(ws, cols, schema);
    const colMap: Record<string, number> = {};
    cols.forEach((c, i) => (colMap[c.key] = i + 1));
    const meta: SheetMeta = { name, role, colMap, lastDataRow: 1, lastCol: cols.length };
    return { meta, blank: cols.map((c) => dataStyle(c, schema)) };
  };
  const p = make("Prospects", "prospects", pCols);
  const s = make("Screened out", "screened", sCols);
  return { wb, sheets: [p.meta, s.meta], blanks: { Prospects: p.blank, "Screened out": s.blank } };
}

export async function exportCampaign(
  campaign: Campaign,
  original: Uint8Array | null,
  rows: Row[],
  templates: Template[],
): Promise<Uint8Array> {
  const schema = campaign.schema;
  let wb: ExcelJS.Workbook;
  let sheets: SheetMeta[];
  let blanks: Record<string, Style[]> = {};
  const generated = !original;

  if (original) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(original as unknown as ArrayBuffer);
    sheets = campaign.sheets;
  } else {
    ({ wb, sheets, blanks } = generatedWorkbook(schema));
  }

  const patches: SheetPatch[] = [];
  let headerStyle: Style = STYLE.header;
  for (const meta of sheets) {
    if (meta.role !== "prospects" && meta.role !== "screened") continue;
    const ws = wb.getWorksheet(meta.name);
    if (!ws) throw new Error(`The tab "${meta.name}" is missing from the stored workbook.`);
    if (meta.role === "prospects") headerStyle = cloneStyle(ws.getCell(1, 1).style ?? STYLE.header);
    const bucketRows = rows.filter((r) => r.bucket === meta.role);
    patches.push(writeBucket(ws, meta, schema, bucketRows, { generated, blank: blanks[meta.name] }));
  }
  // A campaign imported without a Screened-out tab gets one, so screened rows are not lost.
  if (!sheets.some((s) => s.role === "screened") && rows.some((r) => r.bucket === "screened")) {
    let name = "Screened out";
    for (let i = 2; wb.getWorksheet(name); i++) name = `Screened out ${i}`;
    const ws = wb.addWorksheet(name);
    const lead = [schema.companyKey, schema.nameKey, schema.reasonKey].filter(Boolean) as string[];
    const cols = lead.map((k) => schema.columns.find((c) => c.key === k)!).filter(Boolean);
    styleGeneratedSheet(ws, cols, schema);
    const colMap: Record<string, number> = {};
    cols.forEach((c, i) => (colMap[c.key] = i + 1));
    writeBucket(ws, { name, role: "screened", colMap, lastDataRow: 1, lastCol: cols.length }, schema,
      rows.filter((r) => r.bucket === "screened"), { generated: true, blank: cols.map((c) => dataStyle(c, schema)) });
  }

  writeTemplates(wb, templates, headerStyle);
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };

  const out = new Uint8Array(await wb.xlsx.writeBuffer());
  if (!original) return out;
  return restoreSheetXml(out, original, patches);
}
