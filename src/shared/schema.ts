/**
 * Column schemas, shared by import, the AI recipes and the Columns dialog: column keys, the
 * roles Mudd looks for (Status, name, company…), the columns Mudd adds on its own, and what a
 * header alone says about a column's type.
 */
import { norm } from "./merge";
import { DEAD, DEFAULT_STAGES, type CampaignSchema, type Column, type ColumnType, type ContactSchema } from "./types";

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
/** The prospect's hook: the researched reason to write to them, which the intro is built on. */
export const HOOK_HEADERS = ["hook", "personalization", "icebreaker", "angle"];

/** The sheet's hook columns, most preferred first. A row's hook is the first of them it fills. */
export const hookColumns = (schema: CampaignSchema): Column[] =>
  HOOK_HEADERS.flatMap((n) => schema.columns.filter((c) => norm(c.header) === n));

/** A contact's job title. "Title" is not among them: see TITLE_HEADER. */
export const ROLE_HEADERS = ["role", "jobtitle", "position", "contactrole", "decisionmakertitle"];
/** How a contact is addressed: Mr., Dr., Col. */
export const HONORIFIC_HEADERS = ["honorific", "salutation"];
/**
 * "Title" is how a contact is addressed in Mudd's own layout, and their job title in most CRM
 * exports (Salesforce, Apollo), so a Title cell is read by its value: see isHonorific.
 */
export const TITLE_HEADER = "title";

// Military ranks too: defense prospects are addressed as Col. Lee.
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "doctor", "prof", "professor", "rev", "sir", "dame", "hon",
  "gen", "ltgen", "majgen", "briggen", "col", "ltcol", "maj", "capt", "cpt", "lt", "cdr", "lcdr", "adm", "radm", "vadm", "sgt",
]);

/** "Dr." or "Lt. Col.", as opposed to a job title such as "CEO". */
export const isHonorific = (v: string) => HONORIFICS.has(v.toLowerCase().replace(/[^a-z]/g, ""));

// ---------- prospect IDs ----------

/** A prospect's ID column: what the Contacts tab points at. */
export const ID_HEADERS = ["id", "prospectid", "orgid", "companyid", "accountid"];
/** The Contacts tab's column naming each person's prospect by that ID. */
export const PROSPECT_ID_HEADERS = ["prospectid", "orgid", "companyid", "accountid"];

/**
 * The next prospect ID: P-001, P-002… after the highest one taken. The P- keeps Excel from
 * reading it as a number, and it is short enough to type into the Contacts tab by hand.
 */
export function newProspectId(taken: Iterable<string>): string {
  let max = 0;
  for (const t of taken) {
    const m = /^P-(\d+)$/i.exec(t.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(3, "0")}`;
}

// ---------- contacts ----------

/** A contact who is no one person: a main line, a general inbox, a program desk. */
export const CHANNEL = "Channel";

/** The kinds of stakeholder a contact can be, and Channel for a way in that isn't a person. */
export const CONTACT_TYPES = ["Economic Buyer", "Technical Buyer", "End User", "Influencer", "Blocker", "Gatekeeper", CHANNEL];

/** What each contact type means: the type picker's hints. */
export const CONTACT_TYPE_HINTS: Record<string, string> = {
  "Economic Buyer": "Holds or controls the budget and gives final financial approval.",
  "Technical Buyer": "The evaluator: checks the product meets technical, security and data standards.",
  "End User": "The operator: uses the product every day.",
  Influencer: "Shapes the group's opinion, without final sign-off.",
  Blocker: "The ratifier: legal, compliance, procurement or IT security, who can stall or kill the deal.",
  Gatekeeper: "Controls information and access to the senior decision-makers.",
  [CHANNEL]: "Not a person: a main line, a general inbox or a program desk. Never greeted by name, and not researched as a person.",
};

const CONTACT_TYPE_HEADERS = ["contacttype", "type", "stakeholder", "stakeholdertype", "persona"];
/** "Primary contact" is a name, not this box. */
const PRIMARY_HEADERS = ["primary", "isprimary"];

const NO_CONTACTS: ContactSchema = { columns: [] };

/** A campaign's contact columns: none for a schema that has no contacts. */
export const contactSchema = (schema: CampaignSchema): ContactSchema => schema.contacts ?? NO_CONTACTS;

/** Every column, the prospect's then its contacts'. */
export const allColumns = (schema: CampaignSchema): Column[] => [...schema.columns, ...(schema.contacts?.columns ?? [])];

/** A column of the prospect or of its contacts. */
export const columnOf = (schema: CampaignSchema, key: string): Column | undefined =>
  schema.columns.find((c) => c.key === key) ?? schema.contacts?.columns.find((c) => c.key === key);

/** A key of one of the contact columns. */
export const isContactKey = (schema: CampaignSchema, key: string) => !!schema.contacts?.columns.some((c) => c.key === key);

const merged = new WeakMap<CampaignSchema, { cols: Column[]; contactCols: Column[] | undefined; n: number; view: CampaignSchema }>();

/**
 * A prospect and its primary contact read as one: the prospect's columns, then the contact's,
 * with the contact's name as the name. Templates, titles and AI prompts read this over
 * `prospectCells`. A header both have is the prospect's, being found first.
 */
export function prospectSchema(schema: CampaignSchema): CampaignSchema {
  const contactCols = schema.contacts?.columns;
  const n = schema.columns.length + (contactCols?.length ?? 0);
  const hit = merged.get(schema);
  // Same arrays and lengths: the view's own column array stays the same one, which keeps
  // contactColumns() from working the columns out again on every card and title.
  if (hit && hit.cols === schema.columns && hit.contactCols === contactCols && hit.n === n) return hit.view;
  const view: CampaignSchema = { ...schema, columns: [...schema.columns, ...(contactCols ?? [])], nameKey: schema.contacts?.nameKey ?? schema.nameKey };
  merged.set(schema, { cols: schema.columns, contactCols, n, view });
  return view;
}

export function assignRoles(schema: CampaignSchema): void {
  const find = (pred: (h: string, c: Column) => boolean) =>
    schema.columns.find((c) => pred(norm(c.header), c))?.key;
  schema.statusKey ??= find((h) => h === "status" || h === "stage");
  schema.companyKey ??= COMPANY_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.idKey ??= ID_HEADERS.map((n) => find((h) => h === n)).find(Boolean);
  schema.introKey ??= find((h) => h === "intromessage" || h === "intro" || h === "introductionmessage");
  schema.meetingUrlKey ??= find((h) => /^meeting(url|link)$/.test(h));
  schema.meetingAtKey ??= find((h) => /^meeting(at|date|time|datetime|when)$/.test(h));
  schema.screenedKey ??= find((h, c) => SCREENED_HEADERS.includes(h) && c.type === "checkbox");
  schema.reasonKey ??= find((h) => REASON_HEADERS.includes(h));
}

/**
 * Add the columns the app's features need when the sheet lacks them. Appended at the END of the
 * schema, and so at the end of the sheet on export — never between existing columns. Contact
 * columns share the prospect's keys' namespace; `extraTaken` adds keys a deleted column left
 * values under, which a new column must not show.
 */
export function ensureAppColumns(schema: CampaignSchema, extraTaken: Iterable<string> = []): void {
  assignRoles(schema);
  const taken = new Set([...schema.columns.map((c) => c.key), ...(schema.contacts?.columns ?? []).map((c) => c.key), ...extraTaken]);
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
  if (!schema.idKey) schema.idKey = add("ID", "text", { width: 90, hidden: true });
  ensureContactColumns(schema, taken);
}

/** Contact columns a new campaign starts with. */
function defaultContactColumns(taken: Set<string>): Column[] {
  const c = (header: string, type: ColumnType, extra: Partial<Column> = {}): Column => ({
    key: makeKey(header, taken), header, type, origin: "user", width: DEFAULT_WIDTH[type], ...extra,
  });
  return [
    c("Name", "text", { width: 180 }),
    c("Contact type", "select", { options: [...CONTACT_TYPES], width: 150 }),
    c("Primary", "checkbox", { width: 90 }),
    // Text, not a dropdown: honorifics are an open list (Prof., Rev., Col.).
    c("Title", "text", { width: 90 }),
    c("Role", "text", { width: 200 }),
    c("Email", "email"),
    c("Phone", "phone"),
    c("LinkedIn", "url"),
    c("Notes", "longtext"),
  ];
}

/** The contact columns Mudd relies on: a name, a Contact type dropdown, the Primary box. */
function ensureContactColumns(schema: CampaignSchema, taken: Set<string>): void {
  const contacts = (schema.contacts ??= { columns: defaultContactColumns(taken) });
  const find = (names: string[]) => names.map((n) => contacts.columns.find((c) => norm(c.header) === n)).find(Boolean)?.key;
  const colOf = (key: string) => contacts.columns.find((c) => c.key === key)!;
  const add = (header: string, type: ColumnType, extra: Partial<Column> = {}) => {
    const col: Column = { key: makeKey(header, taken), header, type, origin: "mudd", width: DEFAULT_WIDTH[type], ...extra };
    contacts.columns.push(col);
    return col.key;
  };
  contacts.nameKey ??= find(NAME_HEADERS) ?? add("Name", "text", { width: 180 });
  contacts.typeKey ??= find(CONTACT_TYPE_HEADERS);
  if (!contacts.typeKey) contacts.typeKey = add("Contact type", "select", { options: [...CONTACT_TYPES], width: 150 });
  else {
    const type = colOf(contacts.typeKey);
    if (type.type !== "select" || !type.options?.length) {
      type.type = "select";
      type.options = [...CONTACT_TYPES];
    }
  }
  contacts.primaryKey ??= find(PRIMARY_HEADERS);
  if (!contacts.primaryKey) contacts.primaryKey = add("Primary", "checkbox", { width: 90 });
  else colOf(contacts.primaryKey).type = "checkbox";
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
  // The company's columns. Its people's come from ensureAppColumns (defaultContactColumns).
  const columns: Column[] = [
    c("ID", "text", { width: 90, hidden: true, origin: "mudd" }),
    c("Company", "text", { width: 190 }),
    c("Rank", "number"),
    c("Type", "text"),
    c("Location", "text"),
    c("Website", "url"),
    c("Status", "select", { options: [...DEFAULT_STAGES, DEAD] }),
    c("Next step", "text", { width: 200 }),
    c("Next date", "date"),
    c("Meeting URL", "url"),
    c("Meeting at", "datetime"),
    c("Hook", "longtext"),
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
  for (const col of [...schema.columns, ...(schema.contacts?.columns ?? [])]) {
    if (col.origin === "sheet") col.origin = "user";
    delete col.importedHeader;
  }
  ensureAppColumns(schema);
  return schema;
}
