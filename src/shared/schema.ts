/**
 * Column schemas, shared by import, the AI recipes and the Columns dialog: column keys, the
 * roles Mudd looks for (Status, name, company…), the columns Mudd adds on its own, and what a
 * header alone says about a column's type.
 */
import { norm } from "./merge";
import { DEAD, DEFAULT_STAGES, type CampaignSchema, type Column, type ColumnType } from "./types";

// Keys are used as plain object keys on a row's cells, so none may shadow Object.prototype
// ("constructor" would read back as a function on every row that lacks it).
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

export function isReservedKey(key: string): boolean {
  return RESERVED.has(key);
}

/** A column key from its header, unique among `taken` (which it joins). */
export function makeKey(header: string, taken: Set<string>): string {
  let base = header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "col";
  if (RESERVED.has(base)) base = `${base}_col`;
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

/** A tab holding an old Screened-out list: never imported, and never shown in the app. */
export const looksLikeScreenedTab = (name: string) => /screen|disqual|reject|exclu|do.?not|dnc|dropped/i.test(name);

export const NAME_HEADERS =["primarycontact", "contact", "name", "fullname", "contactname", "person", "prospect"];
export const COMPANY_HEADERS = ["company", "org", "organization", "organisation", "account", "companyname", "business"];
const SCREENED_HEADERS = ["screenedout", "screened", "screenout"];
const REASON_HEADERS = ["screenedreason", "screeningreason", "screenoutreason", "reasonscreened", "whyscreened", "whyscreenedout"];

export function assignRoles(schema: CampaignSchema): void {
  const find = (pred: (h: string, c: Column) => boolean) =>
    schema.columns.find((c) => pred(norm(c.header), c))?.key;
  schema.statusKey ??= find((h) => h === "status" || h === "stage");
  schema.nameKey ??= NAME_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.companyKey ??= COMPANY_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.introKey ??= find((h) => h === "intromessage" || h === "intro" || h === "introductionmessage");
  schema.meetingUrlKey ??= find((h) => /^meeting(url|link)$/.test(h));
  schema.meetingAtKey ??= find((h) => /^meeting(at|date|time|datetime|when)$/.test(h));
  schema.screenedKey ??= find((h, c) => SCREENED_HEADERS.includes(h) && c.type === "checkbox");
  schema.reasonKey ??= find((h) => REASON_HEADERS.includes(h));
}

/**
 * Add the columns the app's features need when the sheet lacks them. Appended at the END of the
 * schema, and so at the end of the sheet on export — never between existing columns.
 */
export function ensureAppColumns(schema: CampaignSchema): void {
  assignRoles(schema);
  const taken = new Set(schema.columns.map((c) => c.key));
  const add = (header: string, type: ColumnType, extra: Partial<Column> = {}) => {
    const col: Column = { key: makeKey(header, taken), header, type, origin: "mudd", ...extra };
    schema.columns.push(col);
    return col.key;
  };
  const colOf = (key: string) => schema.columns.find((c) => c.key === key)!;
  if (!schema.statusKey) {
    schema.statusKey = add("Status", "select", { options: [...DEFAULT_STAGES, DEAD], width: 140 });
  } else {
    const status = colOf(schema.statusKey);
    if (status.type !== "select" || !status.options?.length) {
      status.type = "select";
      status.options = [...DEFAULT_STAGES, DEAD];
    }
  }
  if (!schema.meetingUrlKey) schema.meetingUrlKey = add("Meeting URL", "url", { width: 220 });
  else colOf(schema.meetingUrlKey).type = "url";
  if (!schema.meetingAtKey) schema.meetingAtKey = add("Meeting at", "datetime", { width: 170 });
  else colOf(schema.meetingAtKey).type = "datetime";
  if (!schema.introKey) schema.introKey = add("Intro message", "longtext", { width: 320 });
  if (!schema.screenedKey) schema.screenedKey = add("Screened out", "checkbox", { width: 120 });
  else colOf(schema.screenedKey).type = "checkbox";
  if (!schema.reasonKey) schema.reasonKey = add("Screened reason", "longtext", { width: 280 });
}

/**
 * What a header alone says about its column, for import and for columns an AI recipe creates,
 * so the same header gets the same type either way. A `strong` answer wins over what the values
 * suggest (a "Phone" column of digits is still phones); a weak one only breaks a tie.
 */
export function typeFromHeader(header: string): { type: ColumnType; strong: boolean } | null {
  const h = norm(header);
  if (/^meeting(at|date|time|datetime|when)$/.test(h)) return { type: "datetime", strong: true };
  if (/^meeting(url|link)$/.test(h)) return { type: "url", strong: true };
  if (SCREENED_HEADERS.includes(h)) return { type: "checkbox", strong: true };
  if (h.includes("email") && !/source|status|verified|sent|opened|bounced|count/.test(h)) return { type: "email", strong: true };
  if (/phone|mobile|telephone|^tel$|^cell$/.test(h)) return { type: "phone", strong: true };
  if (/linkedin|website|url|link|domain/.test(h)) return { type: "url", strong: true };
  if (/notes?|hook|description|summary|why|reason|message|news|angle/.test(h)) return { type: "longtext", strong: false };
  return null;
}

/** A sensible grid width, in CSS pixels, for a column of this type. */
export const DEFAULT_WIDTH: Record<ColumnType, number> = {
  text: 160, longtext: 300, number: 90, currency: 100, date: 120, datetime: 170,
  select: 140, url: 220, email: 220, phone: 150, checkbox: 110,
};

// ---------- the generic layout ----------

export function genericSchema(): CampaignSchema {
  const taken = new Set<string>();
  const c = (header: string, type: ColumnType, extra: Partial<Column> = {}): Column => ({
    key: makeKey(header, taken), header, type, origin: "user", width: DEFAULT_WIDTH[type], ...extra,
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
    c("Screened out", "checkbox", { width: 120 }),
    c("Screened reason", "longtext", { width: 280 }),
  ];
  const schema: CampaignSchema = { columns };
  ensureAppColumns(schema);
  return schema;
}

export function copySchema(from: CampaignSchema): CampaignSchema {
  const schema: CampaignSchema = JSON.parse(JSON.stringify(from));
  for (const col of schema.columns) {
    if (col.origin === "sheet") col.origin = "user";
    delete col.importedHeader;
  }
  ensureAppColumns(schema);
  return schema;
}
