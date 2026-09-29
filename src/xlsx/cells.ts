/**
 * Converting between spreadsheet cell values and the app's CellValue.
 *
 * Import reads with `readCellValue`. Export does not need to read anything back: each row keeps
 * its cells as imported, so a cell counts as edited when the app's value differs from that, and
 * only edited cells are written (see export.ts).
 */
import type ExcelJS from "exceljs";
import { CHECKED, type CellValue, type Column, type ColumnType } from "../shared/types";
import { hrefFor, parseFlag, toNumber } from "../shared/values";

export { hrefFor, sameValue, toNumber } from "../shared/values";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
// Excel counts a 29 Feb 1900 that never existed, so its day numbers before 1 March 1900 are one
// lower than a plain count; ExcelJS converts them plainly and lands a day early.
const MARCH_1900 = Date.UTC(1900, 2, 1);

/**
 * Excel dates have no time zone, and ExcelJS hands them over as UTC Dates. Reading the UTC
 * parts back gives the wall-clock value the sheet shows, whatever zone this machine is in.
 */
export function dateToString(d: Date, withTime: boolean): string {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function hasTime(d: Date): boolean {
  return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
}

/** A time with no date (a cell formatted h:mm) comes back as a day in December 1899. */
export const isTimeOnly = (d: Date) => d.getUTCFullYear() < 1900;

const looksLikeLink = (t: string) => !!hrefFor(t) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.trim());

/**
 * Flatten any ExcelJS value to what the app stores. With `preferLink`, a hyperlink whose text is
 * only a label ("Profile") gives its target instead, so a Link column holds something to open.
 */
export function readCellValue(value: ExcelJS.CellValue, type?: ColumnType, opts: { preferLink?: boolean } = {}): CellValue {
  if (value === null || value === undefined) return null;
  if (type === "checkbox") {
    const flat = typeof value === "object" && !(value instanceof Date) ? readCellValue(value, "text") : value;
    return parseFlag(flat) ? CHECKED : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    if (isTimeOnly(value)) return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
    const d = value.getTime() < MARCH_1900 ? new Date(value.getTime() + DAY) : value;
    return dateToString(d, type === "datetime" || (type !== "date" && hasTime(d)));
  }
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      const s = (v.richText as { text: string }[]).map((r) => r.text).join("");
      return s === "" ? null : s;
    }
    if ("hyperlink" in v) {
      const text = v.text && typeof v.text === "object" ? readCellValue(v.text as ExcelJS.CellValue, type) : ((v.text as string) || null);
      const target = typeof v.hyperlink === "string" ? v.hyperlink.replace(/^mailto:/i, "") : null;
      if (opts.preferLink && target && (!text || !looksLikeLink(String(text)))) return target;
      return readCellValue(text ?? target, type);
    }
    if ("formula" in v || "sharedFormula" in v) {
      return readCellValue((v.result as ExcelJS.CellValue) ?? null, type);
    }
    if ("error" in v) return String(v.error);
  }
  return String(value);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" → its parts, or null for any other text. */
export function parseAppDate(v: CellValue): { y: number; m: number; d: number; hh: number; mm: number; time: boolean } | null {
  if (typeof v !== "string") return null;
  const dt = DATETIME_RE.exec(v);
  if (dt) return { y: +dt[1]!, m: +dt[2]!, d: +dt[3]!, hh: +dt[4]!, mm: +dt[5]!, time: true };
  const d = DATE_RE.exec(v);
  return d ? { y: +d[1]!, m: +d[2]!, d: +d[3]!, hh: 0, mm: 0, time: false } : null;
}

/** The app's value → what ExcelJS should write, typed so Excel sees dates and numbers as such. */
export function toExcelValue(v: CellValue, col: Column): ExcelJS.CellValue {
  if (v === null || v === "") return null;
  switch (col.type) {
    case "number":
    case "currency":
      return toNumber(v) ?? String(v);
    case "date":
    case "datetime": {
      // A datetime written to a Date column (or the other way round) is still a date.
      const p = parseAppDate(v);
      if (!p) return v;
      return new Date(Date.UTC(p.y, p.m - 1, p.d, col.type === "datetime" ? p.hh : 0, col.type === "datetime" ? p.mm : 0));
    }
    case "select":
      if (col.numeric) {
        const n = toNumber(v);
        if (n !== null) return n;
      }
      return String(v);
    case "checkbox":
      return parseFlag(v) ? true : null;
    case "url": {
      const text = String(v);
      const href = hrefFor(text);
      return href ? { text, hyperlink: href } : text;
    }
    default:
      return typeof v === "number" ? v : String(v);
  }
}

export function numFmtFor(type: ColumnType): string | undefined {
  if (type === "date") return "yyyy-mm-dd";
  if (type === "datetime") return "yyyy-mm-dd hh:mm";
  if (type === "currency") return '"$"#,##0';
  return undefined;
}

export function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export const cloneStyle = <T>(s: T): T => (s ? (JSON.parse(JSON.stringify(s)) as T) : s);
