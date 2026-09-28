/**
 * Reading and comparing cell values, shared by the server (import, export, enrichment) and the
 * page (grid, prospect panel), so the two never disagree about what a number or a link is.
 */
import { CHECKED, type CampaignSchema, type CellValue, type Row } from "./types";

const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/** A number, or text that is one once "$", "," and spaces are stripped ("$1,200", "1 200"). */
export function toNumber(v: CellValue | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,\s]/g, "");
  return NUMERIC_RE.test(s) ? Number(s) : null;
}

// A bare domain needs a real top-level domain (letters), so "4.5" or "19.90" is not a link.
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)*\.[a-z]{2,63}(:\d+)?([/?#]\S*)?$/i;

/** The link a cell's text points at: http(s) and mailto as they are, a bare domain as https. */
export function hrefFor(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^(https?:|mailto:)/i.test(t)) return t;
  if (DOMAIN_RE.test(t)) return `https://${t}`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The link a cell opens in the app: an email column's address as mailto, anything else via hrefFor. */
export function linkFor(text: string, type: "url" | "email" | string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (type === "email" && EMAIL_RE.test(t)) return `mailto:${t}`;
  return hrefFor(t);
}

/** Two cell values that mean the same thing: "" is empty, and Tier 1 equals "1". */
export function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  const na = a === "" || a === undefined ? null : a;
  const nb = b === "" || b === undefined ? null : b;
  if (na === nb) return true;
  if (na === null || nb === null) return false;
  return String(na) === String(nb);
}

/** Text that means a ticked checkbox: TRUE, yes, x, ✓, 1. */
export function parseFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v !== "string") return false;
  return /^(true|yes|y|x|1|✓|✔|☑|checked)$/i.test(v.trim());
}

/** A checkbox value as the app stores it. */
export const flagValue = (on: boolean): CellValue => (on ? CHECKED : null);

/** Cells after a batch of edits: an empty value removes the key. Returns a new object. */
export function applyCellEdits(
  cells: Record<string, CellValue>,
  edits: { key: string; value: CellValue }[],
): Record<string, CellValue> {
  const out = { ...cells };
  for (const e of edits) {
    if (e.value === null || e.value === "") delete out[e.key];
    else out[e.key] = e.value;
  }
  return out;
}

/** A datetime-local input wants "YYYY-MM-DDTHH:mm"; a bare date gets 09:00. */
export const toLocalInput = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T09:00` : v.slice(0, 16));

/** What to call a prospect: company over name ("Acme / Ann Lee"), else the first column. */
export function rowTitle(row: Pick<Row, "cells">, schema: CampaignSchema): { title: string; subtitle: string } {
  const name = schema.nameKey ? String(row.cells[schema.nameKey] ?? "").trim() : "";
  const company = schema.companyKey ? String(row.cells[schema.companyKey] ?? "").trim() : "";
  const first = schema.columns[0] ? String(row.cells[schema.columns[0].key] ?? "").trim() : "";
  if (company && name) return { title: company, subtitle: name };
  return { title: company || name || first || "Untitled prospect", subtitle: "" };
}
