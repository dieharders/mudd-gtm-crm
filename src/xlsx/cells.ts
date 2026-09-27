/**
 * Converting between ExcelJS cell values and the app's CellValue.
 *
 * ONE READER FOR IMPORT AND EXPORT, on purpose. Export decides whether a cell was edited by
 * reading the original cell again and comparing it to the app's value. If the two sides
 * normalised differently, every untouched cell would look edited and be rewritten, and a
 * rewrite loses whatever the plain value cannot carry: rich text runs, hyperlinks, formulas.
 */
import type ExcelJS from "exceljs";
import type { CellValue, Column, ColumnType } from "../shared/types";

const pad = (n: number) => String(n).padStart(2, "0");

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

/** Flatten any ExcelJS value to what the app stores. */
export function readCellValue(value: ExcelJS.CellValue, type?: ColumnType): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return dateToString(value, type === "datetime" || (type !== "date" && hasTime(value)));
  }
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      const s = (v.richText as { text: string }[]).map((r) => r.text).join("");
      return s === "" ? null : s;
    }
    if ("hyperlink" in v) {
      const text = v.text;
      if (text && typeof text === "object") return readCellValue(text as ExcelJS.CellValue, type);
      return readCellValue((text as string) ?? (v.hyperlink as string), type);
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
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

export function toNumber(v: CellValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,\s]/g, "");
  return NUMERIC_RE.test(s) ? Number(s) : null;
}

export function hrefFor(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^(https?:|mailto:)/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

/** The app's value → what ExcelJS should write, typed so Excel sees dates and numbers as such. */
export function toExcelValue(v: CellValue, col: Column): ExcelJS.CellValue {
  if (v === null || v === "") return null;
  switch (col.type) {
    case "number":
    case "currency": {
      const n = toNumber(v);
      return n ?? String(v);
    }
    case "date": {
      const m = typeof v === "string" ? DATE_RE.exec(v) : null;
      return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : v;
    }
    case "datetime": {
      if (typeof v !== "string") return v;
      const m = DATETIME_RE.exec(v);
      if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
      const d = DATE_RE.exec(v);
      return d ? new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)) : v;
    }
    case "select": {
      if (col.numeric) {
        const n = toNumber(v);
        if (n !== null) return n;
      }
      return String(v);
    }
    case "url": {
      const text = String(v);
      const href = hrefFor(text);
      return href ? { text, hyperlink: href } : text;
    }
    default:
      return typeof v === "number" ? v : String(v);
  }
}

export function sameValue(a: CellValue, b: CellValue): boolean {
  const na = a === "" ? null : a;
  const nb = b === "" ? null : b;
  if (na === nb) return true;
  if (na === null || nb === null) return false;
  // Tier 1 stored as 1, edited through a dropdown as "1": the same value.
  return String(na) === String(nb);
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
