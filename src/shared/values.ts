/**
 * Reading and comparing cell values, shared by the server (import, export, enrichment) and the
 * page (grid, prospect panel), so the two never disagree about what a number or a link is.
 */
import { norm } from "./merge";
import { CHANNEL, contactSchema, HONORIFIC_HEADERS, isHonorific, prospectSchema, ROLE_HEADERS, TITLE_HEADER } from "./schema";
import { CHECKED, isChecked, type CampaignSchema, type CellValue, type Column, type Row } from "./types";

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

type ContactKeys = { roleKey?: string; honorificKey?: string; titleKey?: string };
// Worked out once per column list, not per row: every card and title would compare every
// header again (50–90 ms per 5k rows). A change to the columns always makes a new list; the
// length covers columns appended to the same one.
const contactKeys = new WeakMap<Column[], { length: number; keys: ContactKeys }>();

/** The columns a contact is read from, other than the name. Hidden columns are left out. */
export function contactColumns(schema: CampaignSchema): ContactKeys {
  const hit = contactKeys.get(schema.columns);
  if (hit?.length === schema.columns.length) return hit.keys;
  const visible = schema.columns.filter((c) => !c.hidden);
  const first = (names: string[]) => names.map((n) => visible.find((c) => norm(c.header) === n)).find(Boolean)?.key;
  const keys = { roleKey: first(ROLE_HEADERS), honorificKey: first(HONORIFIC_HEADERS), titleKey: first([TITLE_HEADER]) };
  contactKeys.set(schema.columns, { length: schema.columns.length, keys });
  return keys;
}

export interface Contact {
  /** The name as addressed: "Dr. Ann Lee". */
  name: string;
  /** The job title: the Role column, and a Title cell that holds one. */
  role: string;
  /** Contact cells shown in neither, such as an honorific with no name to go before. */
  rest: { key: string; value: string }[];
}

/** A row's contact, read the same way wherever a prospect is shown. */
export function contactOf(cells: Record<string, CellValue>, schema: CampaignSchema): Contact {
  const { roleKey, honorificKey, titleKey } = contactColumns(schema);
  const text = (k?: string) => (k ? String(cells[k] ?? "").trim() : "");
  const bare = text(schema.nameKey);
  const roles = [text(roleKey)];
  const rest: Contact["rest"] = [];
  let honorific = "";
  for (const key of [honorificKey, titleKey]) {
    const v = text(key);
    if (!v) continue;
    const same = !!honorific && norm(v) === norm(honorific);
    if (isHonorific(v) && bare && (!honorific || same)) honorific = v;
    else if (key === titleKey && !isHonorific(v)) roles.push(v);
    else if (!same) rest.push({ key: key!, value: v });
  }
  // A name that already starts with it ("Dr. Ann Lee") keeps it once.
  const name = honorific && norm(bare.split(/\s+/)[0] ?? "") !== norm(honorific) ? `${honorific} ${bare}` : bare;
  const role = roles.filter((r, i) => r && roles.findIndex((x) => norm(x) === norm(r)) === i).join(" · ");
  return { name, role, rest };
}

/** What to call a prospect: company over name ("Acme / Dr. Ann Lee"), else the first column. */
export function rowTitle(row: Pick<Row, "cells">, schema: CampaignSchema): { title: string; subtitle: string } {
  const name = contactOf(row.cells, schema).name;
  const company = schema.companyKey ? String(row.cells[schema.companyKey] ?? "").trim() : "";
  // Not the ID: "P-004" is no name for a prospect.
  const firstCol = schema.columns.find((c) => c.key !== schema.idKey && !c.hidden);
  const first = firstCol ? String(row.cells[firstCol.key] ?? "").trim() : "";
  if (company && name) return { title: company, subtitle: name };
  return { title: company || name || first || "Untitled prospect", subtitle: "" };
}

// ---------- a prospect's contacts ----------

/** A contact of type Channel: a way in (a main line, an inbox) rather than a person. */
export function isChannel(contact: Pick<Row, "cells">, schema: CampaignSchema): boolean {
  const key = schema.contacts?.typeKey;
  return !!key && norm(String(contact.cells[key] ?? "")) === norm(CHANNEL);
}

/**
 * The contact intros and templates address: the first one ticked Primary, else the first person,
 * else the first contact (a channel).
 */
export function primaryOf<T extends Pick<Row, "cells">>(contacts: readonly T[], schema: CampaignSchema): T | undefined {
  const key = schema.contacts?.primaryKey;
  return (key ? contacts.find((c) => isChecked(c.cells[key])) : undefined) ?? contacts.find((c) => !isChannel(c, schema)) ?? contacts[0];
}

/** A contact that holds nothing yet (a Primary tick aside): one a run made for someone it found. */
export function isEmptyContact(contact: Pick<Row, "cells">, schema: CampaignSchema): boolean {
  const primaryKey = schema.contacts?.primaryKey;
  return Object.entries(contact.cells).every(([k, v]) => k === primaryKey || v === null || v === "");
}

/** Contacts as the panel lists them: the primary first, the others in their own order. */
export function orderedContacts<T extends Pick<Row, "cells">>(contacts: readonly T[], schema: CampaignSchema): T[] {
  const primary = primaryOf(contacts, schema);
  return primary ? [primary, ...contacts.filter((c) => c !== primary)] : [...contacts];
}

/** A prospect's cells with its primary contact's, for `prospectSchema`. Their keys never overlap. */
export function prospectCells(org: Pick<Row, "cells">, primary?: Pick<Row, "cells"> | null): Record<string, CellValue> {
  return primary ? { ...org.cells, ...primary.cells } : org.cells;
}

/** What to call a prospect: its company, with its primary contact's name under it. */
export function prospectTitle(org: Pick<Row, "cells">, primary: Pick<Row, "cells"> | null | undefined, schema: CampaignSchema) {
  return rowTitle({ cells: prospectCells(org, primary) }, prospectSchema(schema));
}

/** What to call a contact: their name, else their email, else "Unnamed contact". */
export function contactLabel(contact: Pick<Row, "cells">, schema: CampaignSchema): string {
  const cs = contactSchema(schema);
  const name = contactOf(contact.cells, cs).name;
  if (name) return name;
  const email = cs.columns.filter((c) => c.type === "email").map((c) => String(contact.cells[c.key] ?? "").trim()).find(Boolean);
  return email || "Unnamed contact";
}
