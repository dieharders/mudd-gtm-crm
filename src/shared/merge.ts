/**
 * Intro-message templates: `{{Column header}}` placeholders filled from a row.
 *
 *   {{Company}}              the row's Company cell
 *   {{First name}}           first word of the row's name/contact column
 *   {{Company|your team}}    falls back to "your team" when the cell is empty
 *
 * Header matching ignores case, spacing and punctuation, so {{primary contact}} finds
 * "Primary contact". Anything that matches no column is left in place and reported, so the
 * editor can highlight it rather than silently send "Hi {{Frist name}}".
 */
import { CHANNEL, type CampaignSchema, type CellValue } from "./types";

const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

/** A header for matching: case, spacing and punctuation ignored, letters of any script kept. */
export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const CHANNEL_NORM = norm(CHANNEL);

/** A contact's cells whose Contact type is Channel: a way in (a main line, an inbox), no person. */
export function isChannelCells(cells: Record<string, CellValue>, schema: CampaignSchema): boolean {
  const key = schema.contacts?.typeKey;
  return !!key && norm(display(cells[key])) === CHANNEL_NORM;
}

/** The placeholder names left in a text, e.g. an intro still holding "{{First name}}". */
export function placeholderNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

export interface MergeResult {
  text: string;
  unknown: string[];
  missing: string[];
}

export function placeholdersFor(schema: CampaignSchema): string[] {
  const names = schema.columns.filter((c) => !c.hidden || c.key === schema.nameKey).map((c) => c.header);
  if (schema.nameKey) names.unshift("First name");
  return [...new Set(names)];
}

function display(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function firstNameOf(full: string): string {
  // "Jenna Young, CF APMP" → "Jenna"; "Blair Tighe; Bob Nunnally" → "Blair"
  const first = full.split(/[;,/]|\s+(?:and|&)\s+/)[0]?.trim() ?? "";
  return first.split(/\s+/)[0] ?? "";
}

export function resolvePlaceholder(
  name: string,
  schema: CampaignSchema,
  cells: Record<string, CellValue>,
): { known: boolean; value: string } {
  const n = norm(name);
  if (!n) return { known: false, value: "" };
  // A channel (a main line, an inbox) is no one to greet by name, first or full: the fallback is used.
  const unnamed = isChannelCells(cells, schema);
  if (n === "firstname") {
    if (!schema.nameKey) return { known: false, value: "" };
    return { known: true, value: unnamed ? "" : firstNameOf(display(cells[schema.nameKey])) };
  }
  const col = schema.columns.find((c) => norm(c.header) === n);
  if (!col) return { known: false, value: "" };
  return { known: true, value: unnamed && col.key === schema.nameKey ? "" : display(cells[col.key]) };
}

export function mergeTemplate(
  body: string,
  schema: CampaignSchema,
  cells: Record<string, CellValue>,
): MergeResult {
  const unknown: string[] = [];
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER, (whole, name: string, fallback?: string) => {
    const r = resolvePlaceholder(name, schema, cells);
    if (!r.known) {
      unknown.push(name);
      return whole;
    }
    if (r.value) return r.value;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return "";
  });
  return { text, unknown: [...new Set(unknown)], missing: [...new Set(missing)] };
}

/** Split a template into literal text and placeholder tokens, for highlighting in the editor. */
export function tokenize(
  body: string,
  schema: CampaignSchema,
): { text: string; placeholder?: { name: string; known: boolean } }[] {
  const out: { text: string; placeholder?: { name: string; known: boolean } }[] = [];
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    const name = m[1]!;
    const known = resolvePlaceholder(name, schema, {}).known;
    out.push({ text: m[0], placeholder: { name, known } });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
