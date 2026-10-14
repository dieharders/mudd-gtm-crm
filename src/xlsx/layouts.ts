/**
 * Column types and looks on the spreadsheet side: detecting a column's type from a sheet, the
 * widths the grid uses, and the base-tracker look used when a campaign has no workbook of its
 * own to patch (and for the columns Mudd appends to one that does).
 */
import type ExcelJS from "exceljs";
import { contactRecordKeys, DEFAULT_WIDTH, typeFromHeader } from "../shared/schema";
import { DEAD, type CampaignSchema, type Column, type ColumnType } from "../shared/types";
import { colLetter, hrefFor, isTimeOnly, numFmtFor, readCellValue, toNumber } from "./cells";
import { inlineListOptions } from "./ooxml";

// ---------- type detection ----------

/**
 * A list dropdown's options. A typed list ("a,b,c") is read directly; a range or a defined name
 * is handed to `resolve`, which reads the cells it points at.
 */
export function parseListFormula(formula: string | undefined, resolve?: (ref: string) => string[] | undefined): string[] | undefined {
  if (!formula) return undefined;
  const f = formula.trim().replace(/^=/, "");
  const inline = inlineListOptions(f);
  if (inline) return inline.length ? inline : undefined;
  return resolve?.(f);
}

export interface ColumnSample {
  header: string;
  values: unknown[]; // raw ExcelJS values; the covered cells of a merge are left out
  numFmts: (string | undefined)[];
  listOptions?: string[];
}

export function detectType(s: ColumnSample): Pick<Column, "type" | "options" | "numeric"> {
  const byHeader = typeFromHeader(s.header);
  const vals = s.values.filter((v) => v !== null && v !== undefined && v !== "");
  // Rich text, links and formula results read as the text the sheet shows.
  const texts = vals.map((v) => String(readCellValue(v as ExcelJS.CellValue) ?? ""));

  if (s.listOptions?.length) {
    const numeric = s.listOptions.every((o) => toNumber(o) !== null);
    return { type: "select", options: s.listOptions, numeric: numeric || undefined };
  }
  if (vals.length && vals.every((v) => typeof v === "boolean")) return { type: "checkbox" };

  const fmts = s.numFmts.filter(Boolean) as string[];
  // A time with no date (h:mm) is kept as text ("10:30"), not shown as a day in 1899.
  const dates = vals.filter((v) => v instanceof Date && !isTimeOnly(v)) as Date[];
  const timesOnly = vals.length > 0 && vals.every((v) => v instanceof Date && isTimeOnly(v));
  if (!timesOnly) {
    if (fmts.some((f) => /y/.test(f) && /h/.test(f)) || dates.some((d) => d.getUTCHours() || d.getUTCMinutes())) {
      if (dates.length || !vals.length) return { type: "datetime" };
    }
    if (fmts.some((f) => /yy|dd|mmm/i.test(f)) || (dates.length && dates.length === vals.length)) {
      return { type: "date" };
    }
  }
  if (fmts.some((f) => f.includes("$"))) return { type: "currency" };
  if (byHeader?.strong) return { type: byHeader.type };
  // Numbers before links: "4.5" is a score, not a website.
  if (vals.length && vals.every((v) => typeof v === "number")) return { type: "number" };
  if (texts.length && texts.filter((t) => hrefFor(t) && /[/.]/.test(t)).length / texts.length >= 0.6 && texts.every((t) => !/\s/.test(t.trim()))) {
    return { type: "url" };
  }
  const long = texts.filter((t) => t.length > 70).length;
  if (texts.some((t) => t.length > 140) || (texts.length && long / texts.length > 0.3)) return { type: "longtext" };
  if (byHeader?.type === "longtext") return { type: "longtext" };
  return { type: "text" };
}

/** Excel's width unit (characters) → CSS pixels for the grid. */
export function charsToPx(chars: number | undefined, type: ColumnType): number {
  if (!chars) return DEFAULT_WIDTH[type];
  // Excel shows "2026-07-15" in 11 characters; the grid shows "15 Jul 2026", which needs more.
  const floor = type === "date" ? 112 : type === "datetime" ? 176 : type === "select" ? 96 : 72;
  return Math.round(Math.min(480, Math.max(floor, chars * 7 + 12)));
}

export function pxToChars(px: number | undefined, type: ColumnType): number {
  return Math.round(Math.max(6, ((px ?? DEFAULT_WIDTH[type]) - 12) / 7));
}

// ---------- the base-tracker look ----------

export const STYLE = {
  header: {
    font: { bold: true, size: 10, color: { argb: "FFFFFFFF" }, name: "Arial" },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1B18" }, bgColor: { argb: "FF1C1B18" } },
    alignment: { vertical: "middle" },
    border: {},
  } as Partial<ExcelJS.Style>,
  cell: {
    font: { size: 10, color: { argb: "FF1C1B18" }, name: "Arial" },
    border: { bottom: { style: "thin", color: { argb: "FFE4E1D8" } } },
    alignment: { vertical: "top" },
  } as Partial<ExcelJS.Style>,
  green: "FFDDF3E0",
  red: "FFFBEEEC",
  blue: "FFEEF3F9",
};

/** The pale fill base-tracker gives the cells its owner fills in by hand. */
export const YOURS_FILL = "FFFFFFF0";

/**
 * Columns that get the "yours" fill: the ones Mudd and its user keep up to date, the contacts'
 * own record (Primary, Last contacted, Last reply) among them, whatever they are renamed to.
 */
export function isYours(col: Column, schema: CampaignSchema): boolean {
  const keys = [schema.statusKey, schema.introKey, schema.meetingAtKey, schema.meetingUrlKey, schema.reasonKey, schema.screenedKey, ...contactRecordKeys(schema)];
  return keys.includes(col.key) || /^(next|notes?|last)/i.test(col.header);
}

/** The style a data cell of this column gets in a generated sheet. */
export function dataStyle(col: Column, schema: CampaignSchema): Partial<ExcelJS.Style> {
  const s: Partial<ExcelJS.Style> = JSON.parse(JSON.stringify(STYLE.cell));
  const fmt = numFmtFor(col.type);
  if (fmt) s.numFmt = fmt;
  if (col.type === "longtext") s.alignment = { vertical: "top", wrapText: true };
  if (isYours(col, schema)) s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YOURS_FILL }, bgColor: { argb: YOURS_FILL } };
  return s;
}

/** Status-colour conditional formats, matching base-tracker. */
export function statusFormatting(ref: string): ExcelJS.ConditionalFormattingOptions {
  const fill = (argb: string) => ({ fill: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb }, fgColor: { argb } } });
  const rule = (value: string, argb: string, priority: number): ExcelJS.ConditionalFormattingRule => ({
    type: "cellIs", operator: "equal", priority, formulae: [`"${value}"`], style: fill(argb),
  });
  return {
    ref,
    rules: [
      rule("Signed", STYLE.green, 1),
      rule(DEAD, STYLE.red, 2),
      rule("Clinic held", STYLE.blue, 3),
      rule("Meeting booked", STYLE.blue, 4),
    ],
  };
}

export const listFormula = (options: string[]) => `"${options.map((o) => o.replace(/"/g, "")).join(",")}"`;

/** Excel refuses a typed dropdown list longer than 255 characters. */
export const LIST_FORMULA_MAX = 255;

export const VALIDATION_ROWS = 1000;

/** ExcelJS has `worksheet.dataValidations` at runtime but leaves it out of its typings. */
export function validations(ws: ExcelJS.Worksheet): { add(range: string, dv: ExcelJS.DataValidation): void } {
  return (ws as unknown as { dataValidations: { add(range: string, dv: ExcelJS.DataValidation): void } }).dataValidations;
}

/** A sheet in the base-tracker style: dark header, frozen at C2, autofilter, dropdowns. */
export function styleGeneratedSheet(ws: ExcelJS.Worksheet, cols: Column[], schema: CampaignSchema): void {
  ws.views = [{ state: "frozen", xSplit: Math.min(2, cols.length), ySplit: 1, topLeftCell: "C2", activeCell: "C2" }];
  const header = ws.getRow(1);
  header.height = 21.75;
  cols.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.style = JSON.parse(JSON.stringify(STYLE.header));
    ws.getColumn(i + 1).width = pxToChars(col.width, col.type);
  });
  const last = colLetter(Math.max(1, cols.length));
  ws.autoFilter = `A1:${last}1`;
  cols.forEach((col, i) => {
    const L = colLetter(i + 1);
    if (col.type === "select" && col.options?.length && listFormula(col.options).length <= LIST_FORMULA_MAX) {
      validations(ws).add(`${L}2:${L}${VALIDATION_ROWS}`, {
        type: "list", allowBlank: true, formulae: [listFormula(col.options)],
      });
    }
    if (col.key === schema.statusKey) ws.addConditionalFormatting(statusFormatting(`${L}2:${L}${VALIDATION_ROWS}`));
  });
}
