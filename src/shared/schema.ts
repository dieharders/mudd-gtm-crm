/**
 * Column schemas, shared by import, the AI recipes and the Columns dialog: column keys, the
 * roles Mudd looks for (Status, name, company…), the columns Mudd adds on its own, and what a
 * header alone says about a column's type.
 */
import { norm } from "./merge";
import { CHANNEL, DEAD, DEFAULT_STAGES, ORG_KEY, type CampaignSchema, type Column, type ColumnType, type ContactSchema } from "./types";

// Keys are used as plain object keys on a row's cells, so none may shadow Object.prototype
// ("constructor" would read back as a function on every row that lacks it).
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

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

/**
 * How many people a company employs, under any of its names (Staff, Headcount, Size…): always
 * one Number column, called "# Employees".
 */
export const EMPLOYEES_HEADER = "# Employees";
export const EMPLOYEES_HEADERS = ["employees", "staff", "headcount", "size", "companysize", "employeecount", "numemployees", "numberofemployees"];
export const isEmployeesHeader = (header: string) => EMPLOYEES_HEADERS.includes(norm(header));

/**
 * The prospect's website: a column so headed, else the first link column that isn't a person's
 * profile or the meeting link. Discovery reads it to tell a found company from one already in
 * the list, and writes an accepted company's website into it: one rule for both.
 */
export const WEBSITE_HEADERS = ["website", "url", "domain", "site", "homepage", "web", "companywebsite"];
export function websiteColumn(schema: Pick<CampaignSchema, "columns">): Column | undefined {
  return columnByHeaders(schema.columns, WEBSITE_HEADERS)
    ?? schema.columns.find((c) => c.type === "url" && !/linkedin|meeting|profile/i.test(c.header));
}

/** The first column headed by any of these names (normalised), the names in order of preference. */
export const columnByHeaders = (cols: Column[], names: string[]): Column | undefined =>
  names.map((n) => cols.find((c) => norm(c.header) === n)).find(Boolean);

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

/** The Prospects tab's ID column, as Mudd writes it: "ID". */
export const ID_HEADER = "id";
/** The Contacts tab's column naming each person's prospect by that ID: "Prospect ID". */
export const PROSPECT_ID_HEADER = "prospectid";

/**
 * Prospect IDs after the highest one taken: P-001, P-002… The P- keeps Excel from reading it as
 * a number, and it is short enough to type into the Contacts tab by hand. Each call of the
 * returned function gives the next one, so a whole sheet is numbered in one pass.
 */
export function prospectIds(taken: Iterable<string>): () => string {
  let max = 0;
  for (const t of taken) {
    const m = /^P-(\d+)$/i.exec(t.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return () => `P-${String(++max).padStart(3, "0")}`;
}

/** The next prospect ID after the highest one taken. */
export const newProspectId = (taken: Iterable<string>): string => prospectIds(taken)();

// ---------- contacts ----------

export { CHANNEL };

/** Whoever holds the budget: the Contacts tab has a quick filter for them. */
export const ECONOMIC_BUYER = "Economic Buyer";

/** The kinds of stakeholder a contact can be, and Channel for a way in that isn't a person. */
export const CONTACT_TYPES = [ECONOMIC_BUYER, "Champion", "Technical Buyer", "End User", "Influencer", "Blocker", "Gatekeeper", CHANNEL];

/** What each contact type means: the type picker's hints. */
export const CONTACT_TYPE_HINTS: Record<string, string> = {
  [ECONOMIC_BUYER]: "Holds or controls the budget and gives final financial approval.",
  Champion: "The advocate with the most to gain: feels the pain and sells the deal internally.",
  "Technical Buyer": "The evaluator: checks the product meets technical, security and data standards.",
  "End User": "The operator: uses the product every day.",
  Influencer: "Shapes the group's opinion, without final sign-off.",
  Blocker: "The ratifier: legal, compliance, procurement or IT security, who can stall or kill the deal.",
  Gatekeeper: "Controls information and access to the senior decision-makers.",
  [CHANNEL]: "Not a person: a main line, a general inbox or a program desk. Never greeted by name, and not researched as a person.",
};

/**
 * Only "Contact type": a Contacts tab's own "Type" or "Persona" column means something else
 * (Mobile/Work, the user's own personas), and turning it into this dropdown would make Excel
 * reject its values.
 */
const CONTACT_TYPE_HEADER = "contacttype";
/** "Primary contact" is a name, not this box. */
const PRIMARY_HEADERS = ["primary", "isprimary"];
const LAST_CONTACTED_HEADERS = ["lastcontacted", "lastcontact", "lastcontactdate", "lastcontacteddate", "datelastcontacted"];

/** A column made by Mudd: a key free among `taken` (which it joins), the type's width unless given. */
function newColumn(taken: Set<string>, header: string, type: ColumnType, extra: Partial<Column> = {}): Column {
  return { key: makeKey(header, taken), header, type, origin: "user", width: DEFAULT_WIDTH[type], ...extra };
}

/** The four contact columns Mudd relies on, as a new campaign has them and as import adds them. */
const NAME_COLUMN = { header: "Name", type: "text", width: 180 } as const;
const TYPE_COLUMN = { header: "Contact type", type: "select", width: 150 } as const;
const PRIMARY_COLUMN = { header: "Primary", type: "checkbox", width: 90 } as const;
const LAST_CONTACTED_COLUMN = { header: "Last contacted", type: "date", width: 130 } as const;
const roleColumn = (taken: Set<string>, spec: { header: string; type: ColumnType; width: number }, extra: Partial<Column> = {}) =>
  newColumn(taken, spec.header, spec.type, { width: spec.width, ...(spec.type === "select" ? { options: [...CONTACT_TYPES] } : {}), ...extra });

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

/**
 * The Company column the Contacts tab (in the workbook and in the app) shows beside each person,
 * copied from their prospect. None when the prospects have no Company column: there is nothing
 * to copy, and writing blanks would wipe the tab's own.
 */
export function orgColumn(schema: CampaignSchema): Column | null {
  const company = schema.columns.find((c) => c.key === schema.companyKey);
  return company ? { key: ORG_KEY, header: company.header, type: "text", width: company.width ?? 190 } : null;
}

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
  schema.idKey ??= find((h) => h === ID_HEADER);
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
  return [
    roleColumn(taken, NAME_COLUMN),
    roleColumn(taken, TYPE_COLUMN),
    roleColumn(taken, PRIMARY_COLUMN),
    // Text, not a dropdown: honorifics are an open list (Prof., Rev., Col.).
    newColumn(taken, "Title", "text", { width: 90 }),
    newColumn(taken, "Role", "text", { width: 200 }),
    newColumn(taken, "Email", "email"),
    newColumn(taken, "Phone", "phone"),
    newColumn(taken, "LinkedIn", "url"),
    roleColumn(taken, LAST_CONTACTED_COLUMN),
    newColumn(taken, "Notes", "longtext"),
  ];
}

/** The contact columns Mudd relies on: a name, a Contact type dropdown, the Primary box, Last contacted. */
function ensureContactColumns(schema: CampaignSchema, taken: Set<string>): void {
  const contacts = (schema.contacts ??= { columns: defaultContactColumns(taken) });
  const find = (names: string[]) => names.map((n) => contacts.columns.find((c) => norm(c.header) === n)).find(Boolean)?.key;
  const colOf = (key: string) => contacts.columns.find((c) => c.key === key)!;
  const add = (spec: Parameters<typeof roleColumn>[1]) => {
    const col = roleColumn(taken, spec, { origin: "mudd" });
    contacts.columns.push(col);
    return col.key;
  };
  contacts.nameKey ??= find(NAME_HEADERS) ?? add(NAME_COLUMN);
  contacts.typeKey ??= find([CONTACT_TYPE_HEADER]);
  if (!contacts.typeKey) contacts.typeKey = add(TYPE_COLUMN);
  else {
    const type = colOf(contacts.typeKey);
    if (type.type !== "select" || !type.options?.length) {
      type.type = "select";
      type.options = [...CONTACT_TYPES];
    }
  }
  contacts.primaryKey ??= find(PRIMARY_HEADERS);
  if (!contacts.primaryKey) contacts.primaryKey = add(PRIMARY_COLUMN);
  else colOf(contacts.primaryKey).type = "checkbox";
  contacts.lastContactedKey ??= find(LAST_CONTACTED_HEADERS);
  if (!contacts.lastContactedKey) contacts.lastContactedKey = add(LAST_CONTACTED_COLUMN);
  else colOf(contacts.lastContactedKey).type = "date";
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
  if (isEmployeesHeader(header)) return { type: "number", strong: true };
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
  const c = (header: string, type: ColumnType, extra: Partial<Column> = {}) => newColumn(taken, header, type, extra);
  // The company's columns. Its people's come from ensureAppColumns (defaultContactColumns).
  const columns: Column[] = [
    c("ID", "text", { width: 90, hidden: true, origin: "mudd" }),
    c("Company", "text", { width: 190 }),
    c("Rank", "number"),
    c("Type", "text"),
    c("Location", "text"),
    c("Website", "url"),
    c(EMPLOYEES_HEADER, "number"),
    c("Status", "select", { options: [...DEFAULT_STAGES, DEAD] }),
    c("Last touch", "date"),
    c("Next step", "text", { width: 200 }),
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

// ---------- the Discovery layout ----------

/** A prospect's fit with the thesis, as Discovery rates it. */
export const FIT_OPTIONS = ["High", "Medium", "Low"];

export interface DiscoveryField {
  id: "fit" | "whyFit" | "whyNow" | "budget" | "clock" | "dealRole" | "gain" | "angle";
  header: string;
  type: ColumnType;
  options?: string[];
  width?: number;
  /** A detail of a person: one of the contact columns. */
  person?: boolean;
}

/**
 * The intel Discovery writes about each company and each of its people. A Discovery campaign
 * starts with a column for each; accepting a company adds back any the user deleted, matched by
 * header.
 */
export const DISCOVERY_FIELDS: DiscoveryField[] = [
  { id: "fit", header: "Fit", type: "select", options: [...FIT_OPTIONS], width: 100 },
  { id: "whyFit", header: "Why they fit", type: "longtext" },
  { id: "whyNow", header: "Why now", type: "longtext" },
  { id: "budget", header: "Budget source", type: "text", width: 200 },
  { id: "clock", header: "Buying clock", type: "text", width: 180 },
  { id: "dealRole", header: "Role in deal", type: "longtext", person: true },
  { id: "gain", header: "What they gain", type: "longtext", person: true },
  { id: "angle", header: "Angle", type: "longtext", person: true },
];

/** The column a Discovery field fills, found by header among the prospect's or the contacts' columns. */
export function discoveryColumn(schema: CampaignSchema, field: DiscoveryField): Column | undefined {
  const pool = field.person ? schema.contacts?.columns ?? [] : schema.columns;
  return pool.find((c) => norm(c.header) === norm(field.header));
}

/**
 * The layout a Discovery campaign starts with: the generic one without Rank and Type (Discovery
 * rates fit instead), with the intel columns after the company's basics, and the contacts' intel
 * after their details.
 */
export function discoverySchema(): CampaignSchema {
  const taken = new Set<string>();
  const c = (header: string, type: ColumnType, extra: Partial<Column> = {}) => newColumn(taken, header, type, extra);
  const intel = (f: DiscoveryField) => c(f.header, f.type, { origin: "discovery", ...(f.options ? { options: [...f.options] } : {}), ...(f.width ? { width: f.width } : {}) });
  const columns: Column[] = [
    c("ID", "text", { width: 90, hidden: true, origin: "mudd" }),
    c("Company", "text", { width: 190 }),
    c("Website", "url"),
    c("Location", "text"),
    c(EMPLOYEES_HEADER, "number"),
    ...DISCOVERY_FIELDS.filter((f) => !f.person).map(intel),
    c("Status", "select", { options: [...DEFAULT_STAGES, DEAD] }),
    c("Last touch", "date"),
    c("Next step", "text", { width: 200 }),
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
  for (const f of DISCOVERY_FIELDS.filter((x) => x.person)) schema.contacts!.columns.push(newColumn(taken, f.header, f.type, { origin: "discovery", ...(f.width ? { width: f.width } : {}) }));
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
