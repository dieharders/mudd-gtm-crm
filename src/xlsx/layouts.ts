/**
 * Column schemas: detecting a column's type from a sheet, the generic starting layout, the
 * columns Mudd adds on its own (Status, Intro message, Meeting URL/at, Screened reason), and the
 * base-tracker look used when a campaign has no workbook of its own to patch.
 */
import ExcelJS from "exceljs";
import { norm } from "../shared/merge";
import { DEAD, DEFAULT_STAGES, type CampaignSchema, type Column, type ColumnType } from "../shared/types";
import { colLetter, colNumber, hrefFor, numFmtFor, toNumber } from "./cells";

// ---------- keys & roles ----------

export function makeKey(header: string, taken: Set<string>): string {
  const base = header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "col";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

const NAME_HEADERS = ["primarycontact", "contact", "name", "fullname", "contactname", "person", "prospect"];
const COMPANY_HEADERS = ["company", "org", "organization", "organisation", "account", "companyname", "business"];

/** Headers that name the same thing across a Prospects and a Screened-out sheet. */
export function sameHeader(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return COMPANY_HEADERS.includes(na) && COMPANY_HEADERS.includes(nb);
}

export function assignRoles(schema: CampaignSchema): void {
  const find = (pred: (h: string, c: Column) => boolean) =>
    schema.columns.find((c) => pred(norm(c.header), c))?.key;
  schema.statusKey ??= find((h) => h === "status" || h === "stage");
  schema.nameKey ??= NAME_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.companyKey ??= COMPANY_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.introKey ??= find((h) => h === "intromessage" || h === "intro" || h === "introductionmessage");
  schema.meetingUrlKey ??= find((h) => /^meeting(url|link)$/.test(h));
  schema.meetingAtKey ??= find((h) => /^meeting(at|date|time|datetime|when)$/.test(h));
}

/**
 * Add the columns the app's features need when the sheet lacks them. Appended at the END of the
 * schema, and so at the end of the sheet on export — never between existing columns.
 */
export function ensureAppColumns(schema: CampaignSchema, opts: { reason?: boolean } = {}): void {
  assignRoles(schema);
  const taken = new Set(schema.columns.map((c) => c.key));
  const add = (header: string, type: ColumnType, extra: Partial<Column> = {}) => {
    const col: Column = { key: makeKey(header, taken), header, type, origin: "mudd", ...extra };
    schema.columns.push(col);
    return col.key;
  };
  if (!schema.statusKey) {
    schema.statusKey = add("Status", "select", { options: [...DEFAULT_STAGES, DEAD], width: 140 });
  } else {
    const status = schema.columns.find((c) => c.key === schema.statusKey)!;
    if (status.type !== "select" || !status.options?.length) {
      status.type = "select";
      status.options = [...DEFAULT_STAGES, DEAD];
    }
  }
  if (!schema.meetingUrlKey) schema.meetingUrlKey = add("Meeting URL", "url", { width: 220 });
  else schema.columns.find((c) => c.key === schema.meetingUrlKey)!.type = "url";
  if (!schema.meetingAtKey) schema.meetingAtKey = add("Meeting at", "datetime", { width: 170 });
  else schema.columns.find((c) => c.key === schema.meetingAtKey)!.type = "datetime";
  if (!schema.introKey) schema.introKey = add("Intro message", "longtext", { width: 320 });
  if (opts.reason !== false && !schema.reasonKey) schema.reasonKey = add("Screened reason", "longtext", { width: 280 });
}

// ---------- type detection ----------

export function parseListFormula(formula: string | undefined, wb?: ExcelJS.Workbook): string[] | undefined {
  if (!formula) return undefined;
  const f = formula.trim();
  if (f.startsWith('"')) {
    return f
      .replace(/^"|"$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // A range reference: Lists!$A$1:$A$9 — resolve it from the workbook when we can.
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(f);
  if (!m || !wb || !m[1]) return undefined;
  const ws = wb.getWorksheet(m[1]);
  if (!ws) return undefined;
  const out: string[] = [];
  const [c1, r1, c2, r2] = [colNumber(m[2]!), +m[3]!, colNumber(m[4]!), +m[5]!];
  for (let r = r1; r <= Math.min(r2, r1 + 500); r++) {
    for (let c = c1; c <= c2; c++) {
      const v = ws.getCell(r, c).text?.trim();
      if (v) out.push(v);
    }
  }
  return out.length ? out : undefined;
}

export interface ColumnSample {
  header: string;
  values: unknown[]; // raw ExcelJS values
  numFmts: (string | undefined)[];
  listOptions?: string[];
}

export function detectType(s: ColumnSample): Pick<Column, "type" | "options" | "numeric"> {
  const h = norm(s.header);
  const vals = s.values.filter((v) => v !== null && v !== undefined && v !== "");
  const texts = vals.map((v) => (typeof v === "object" && v && "text" in (v as object) ? String((v as { text: unknown }).text) : String(v)));

  if (s.listOptions?.length) {
    const numeric = s.listOptions.every((o) => toNumber(o) !== null);
    return { type: "select", options: s.listOptions, numeric: numeric || undefined };
  }
  if (/^meeting(at|date|time|datetime|when)$/.test(h)) return { type: "datetime" };
  if (/^meeting(url|link)$/.test(h)) return { type: "url" };

  const fmts = s.numFmts.filter(Boolean) as string[];
  const dates = vals.filter((v) => v instanceof Date) as Date[];
  if (fmts.some((f) => /y/.test(f) && /h/.test(f)) || dates.some((d) => d.getUTCHours() || d.getUTCMinutes())) {
    if (dates.length || !vals.length) return { type: "datetime" };
  }
  if (fmts.some((f) => /yy|dd|mmm/i.test(f)) || (dates.length && dates.length === vals.length)) {
    return { type: "date" };
  }
  if (fmts.some((f) => f.includes("$"))) return { type: "currency" };
  if (/^e?mail$|^emailaddress$|^workemail$/.test(h)) return { type: "email" };
  if (/phone|mobile|tel$/.test(h)) return { type: "phone" };
  if (/linkedin|website|url|link|domain/.test(h)) return { type: "url" };
  if (texts.length && texts.filter((t) => hrefFor(t) && /[/.]/.test(t)).length / texts.length >= 0.6 && texts.every((t) => !/\s/.test(t.trim()))) {
    return { type: "url" };
  }
  if (vals.length && vals.every((v) => typeof v === "number")) return { type: "number" };
  const long = texts.filter((t) => t.length > 70).length;
  if (texts.some((t) => t.length > 140) || (texts.length && long / texts.length > 0.3)) return { type: "longtext" };
  if (/notes?|hook|description|summary|why|reason|message/.test(h)) return { type: "longtext" };
  return { type: "text" };
}

/** Excel's width unit (characters) → CSS pixels for the grid. */
export function charsToPx(chars: number | undefined, type: ColumnType): number {
  const fallback: Record<ColumnType, number> = {
    text: 160, longtext: 300, number: 90, currency: 100, date: 120, datetime: 170,
    select: 140, url: 220, email: 220, phone: 150,
  };
  if (!chars) return fallback[type];
  // Excel shows "2026-07-15" in 11 characters; the grid shows "15 Jul 2026", which needs more.
  const floor = type === "date" ? 112 : type === "datetime" ? 176 : type === "select" ? 96 : 72;
  return Math.round(Math.min(480, Math.max(floor, chars * 7 + 12)));
}

export function pxToChars(px: number | undefined, type: ColumnType): number {
  return Math.round(Math.max(6, ((px ?? charsToPx(undefined, type)) - 12) / 7));
}

// ---------- the generic layout ----------

export function genericSchema(): CampaignSchema {
  const taken = new Set<string>();
  const c = (header: string, type: ColumnType, extra: Partial<Column> = {}): Column => ({
    key: makeKey(header, taken), header, type, origin: "user", width: charsToPx(undefined, type), ...extra,
  });
  const columns: Column[] = [
    c("Name", "text", { width: 180 }),
    c("Company", "text", { width: 190 }),
    c("Title", "text"),
    c("Email", "email"),
    c("LinkedIn", "url"),
    c("Phone", "phone"),
    c("Location", "text"),
    c("Website", "url"),
    c("Status", "select", { options: [...DEFAULT_STAGES, DEAD] }),
    c("Next step", "text", { width: 200 }),
    c("Next date", "date"),
    c("Meeting URL", "url"),
    c("Meeting at", "datetime"),
    c("Notes", "longtext"),
    c("Source", "text"),
    c("Intro message", "longtext", { width: 320 }),
    c("Screened reason", "longtext", { width: 280 }),
  ];
  const schema: CampaignSchema = { columns, reasonKey: columns.at(-1)!.key };
  ensureAppColumns(schema);
  return schema;
}

export function copySchema(from: CampaignSchema): CampaignSchema {
  const schema: CampaignSchema = JSON.parse(JSON.stringify(from));
  for (const col of schema.columns) if (col.origin === "sheet") col.origin = "user";
  ensureAppColumns(schema);
  return schema;
}

// ---------- the base-tracker look, for campaigns with no workbook of their own ----------

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
  yours: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFF0" }, bgColor: { argb: "FFFFFFF0" } } as ExcelJS.Fill,
  green: "FFDDF3E0",
  red: "FFFBEEEC",
  blue: "FFEEF3F9",
};

/** The style a data cell of this column gets in a generated sheet (and in an appended column). */
export function dataStyle(col: Column, schema: CampaignSchema): Partial<ExcelJS.Style> {
  const s: Partial<ExcelJS.Style> = JSON.parse(JSON.stringify(STYLE.cell));
  const fmt = numFmtFor(col.type);
  if (fmt) s.numFmt = fmt;
  if (col.type === "longtext") s.alignment = { vertical: "top", wrapText: true };
  const yours = [schema.statusKey, schema.introKey, schema.meetingAtKey, schema.meetingUrlKey, schema.reasonKey];
  if (yours.includes(col.key) || /^(next|notes?|last)/i.test(col.header)) s.fill = JSON.parse(JSON.stringify(STYLE.yours));
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
    if (col.type === "select" && col.options?.length) {
      validations(ws).add(`${L}2:${L}${VALIDATION_ROWS}`, {
        type: "list", allowBlank: true, formulae: [listFormula(col.options)],
      });
    }
    if (col.key === schema.statusKey) ws.addConditionalFormatting(statusFormatting(`${L}2:${L}${VALIDATION_ROWS}`));
  });
}
