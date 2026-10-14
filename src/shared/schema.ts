/**
 * Column schemas, shared by import, the AI recipes and the Columns dialog: column keys, the
 * roles Mudd looks for (Status, name, company…), the columns Mudd adds on its own, and what a
 * header alone says about a column's type.
 */
import { norm } from "./merge";
import { CHANNEL, DEAD, ORG_KEY, STAGES, type CampaignSchema, type Column, type ColumnType, type ContactSchema } from "./types";

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

/** A column made by Mudd: a key free among `taken` (which it joins), the type's width unless given. */
function newColumn(taken: Set<string>, header: string, type: ColumnType, extra: Partial<Column> = {}): Column {
  return { key: makeKey(header, taken), header, type, origin: "user", width: DEFAULT_WIDTH[type], ...extra };
}

/** A column Mudd relies on, as Mudd writes it. */
type RoleSpec = { header: string; type: ColumnType; width: number; options?: readonly string[]; hidden?: boolean };
/**
 * Which key of the schema names each role's column, and what Mudd uses it for (the Columns
 * dialog says so); `add: false` for one a sheet may lack.
 */
type Roles<K extends string> = readonly { key: K; spec: RoleSpec; label: string; add?: false }[];
const roleColumn = (taken: Set<string>, spec: RoleSpec, extra: Partial<Column> = {}) =>
  newColumn(taken, spec.header, spec.type, { width: spec.width, ...(spec.options ? { options: [...spec.options] } : {}), ...(spec.hidden ? { hidden: true } : {}), ...extra });

const STATUS_COLUMN: RoleSpec = { header: "Status", type: "select", width: 140, options: [...STAGES, DEAD] };
const COMPANY_COLUMN: RoleSpec = { header: "Company", type: "text", width: 190 };
/** The headers Mudd writes for the prospect's status and company, normalised: import looks for them. */
export const STATUS_HEADER = norm(STATUS_COLUMN.header);
export const COMPANY_HEADER = norm(COMPANY_COLUMN.header);

/**
 * The prospect's columns Mudd relies on, in the order it adds the ones a sheet lacks. The
 * company is only read: a sheet without one doesn't get one.
 */
const PROSPECT_ROLES: Roles<"statusKey" | "companyKey" | "meetingUrlKey" | "meetingAtKey" | "introKey" | "screenedKey" | "reasonKey" | "idKey"> = [
  { key: "statusKey", spec: STATUS_COLUMN, label: "Pipeline status" },
  { key: "companyKey", spec: COMPANY_COLUMN, label: "Company", add: false },
  { key: "meetingUrlKey", spec: { header: "Meeting URL", type: "url", width: 220 }, label: "Meeting link" },
  { key: "meetingAtKey", spec: { header: "Meeting at", type: "datetime", width: 170 }, label: "Meeting time" },
  { key: "introKey", spec: { header: "Intro message", type: "longtext", width: 320 }, label: "Intro message" },
  { key: "screenedKey", spec: { header: "Screened out", type: "checkbox", width: 120 }, label: "Screened out" },
  { key: "reasonKey", spec: { header: "Screened reason", type: "longtext", width: 280 }, label: "Screened reason" },
  { key: "idKey", spec: { header: "ID", type: "text", width: 90, hidden: true }, label: "Prospect ID: the Contacts tab links by it" },
];

/** The five contact columns Mudd relies on, as a new campaign has them and as import adds them. */
const NAME_COLUMN: RoleSpec = { header: "Name", type: "text", width: 180 };
const TYPE_COLUMN: RoleSpec = { header: "Contact type", type: "select", width: 150, options: CONTACT_TYPES };
const PRIMARY_COLUMN: RoleSpec = { header: "Primary", type: "checkbox", width: 90 };
const LAST_CONTACTED_COLUMN: RoleSpec = { header: "Last contacted", type: "date", width: 130 };
const LAST_REPLY_COLUMN: RoleSpec = { header: "Last reply", type: "date", width: 120 };
const CONTACT_ROLES: Roles<"nameKey" | "typeKey" | "primaryKey" | "lastContactedKey" | "lastReplyKey"> = [
  { key: "nameKey", spec: NAME_COLUMN, label: "Contact name" },
  { key: "typeKey", spec: TYPE_COLUMN, label: "Contact type" },
  { key: "primaryKey", spec: PRIMARY_COLUMN, label: "Primary contact" },
  { key: "lastContactedKey", spec: LAST_CONTACTED_COLUMN, label: "Last contacted" },
  { key: "lastReplyKey", spec: LAST_REPLY_COLUMN, label: "Last reply" },
];

/** The keys of a list's columns Mudd relies on, each with what Mudd uses it for. */
function rolesOf<K extends string>(holder: Partial<Record<K, string>>, roles: Roles<K>): Map<string, string> {
  return new Map(roles.flatMap(({ key, label }) => (holder[key] ? [[holder[key], label] as const] : [])));
}
export const prospectRoles = (schema: CampaignSchema) => rolesOf(schema, PROSPECT_ROLES);
export const contactRoles = (contacts: ContactSchema) => rolesOf(contacts, CONTACT_ROLES);

const NO_CONTACTS: ContactSchema = { columns: [] };

/** A campaign's contact columns: none for a schema that has no contacts. */
export const contactSchema = (schema: CampaignSchema): ContactSchema => schema.contacts ?? NO_CONTACTS;

/**
 * The contact columns that are the user's own record, not facts about the person: the Primary
 * box, Last contacted and Last reply. Nothing is researched into them, and they don't go to the
 * AI as context.
 */
export function contactRecordKeys(schema: CampaignSchema): string[] {
  const { primaryKey, lastContactedKey, lastReplyKey } = contactSchema(schema);
  return [primaryKey, lastContactedKey, lastReplyKey].filter((k): k is string => !!k);
}

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

/**
 * The column headed as Mudd heads `header`, give or take case and punctuation ("STATUS",
 * "Status:"). The closest wins: with both "Status:" and "Status", it is "Status", and
 * "Status:" stays the sheet's own.
 */
function roleColumnOf(columns: Column[], header: string): Column | undefined {
  return columns.find((c) => c.header === header)
    ?? columns.find((c) => c.header.trim().toLowerCase() === header.toLowerCase())
    ?? columns.find((c) => norm(c.header) === norm(header));
}

/**
 * Give each role the column headed as Mudd heads it, adding one where the sheet has none, and
 * make that column Mudd's whatever the sheet made it: its header, type and dropdown list. The
 * cells stay the sheet's, read as that type: a box is ticked only by what reads as a tick (TRUE,
 * yes, x, ✓, 1), and any other text in it reads as unticked.
 */
function ensureRoles<K extends string>(holder: Partial<Record<K, string>>, columns: Column[], roles: Roles<K>, taken: Set<string>): void {
  for (const { key, spec, add } of roles) {
    holder[key] ??= roleColumnOf(columns, spec.header)?.key;
    const col = columns.find((c) => c.key === holder[key]);
    if (col) {
      col.header = spec.header;
      col.type = spec.type;
      if (spec.options) col.options = [...spec.options];
      else delete col.options;
    } else if (add !== false) {
      const added = roleColumn(taken, spec, { origin: "mudd" });
      columns.push(added);
      holder[key] = added.key;
    }
  }
}

/**
 * Add the columns the app's features need when the sheet lacks them. Appended at the END of the
 * schema, and so at the end of the sheet on export — never between existing columns. Contact
 * columns share the prospect's keys' namespace; `extraTaken` adds keys a deleted column left
 * values under, which a new column must not show.
 */
export function ensureAppColumns(schema: CampaignSchema, extraTaken: Iterable<string> = []): void {
  const taken = new Set([...allColumns(schema).map((c) => c.key), ...extraTaken]);
  ensureRoles(schema, schema.columns, PROSPECT_ROLES, taken);
  const contacts = (schema.contacts ??= { columns: defaultContactColumns(taken) });
  ensureRoles(contacts, contacts.columns, CONTACT_ROLES, taken);
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
    roleColumn(taken, LAST_REPLY_COLUMN),
    newColumn(taken, "Notes", "longtext"),
  ];
}

/**
 * What a header alone says about its column, for import and for columns an AI recipe creates,
 * so the same header gets the same type either way. A `strong` answer wins over what the values
 * suggest (a "Phone" column of digits is still phones); a weak one only breaks a tie. The
 * columns Mudd relies on aren't here: they are Mudd's type whatever the sheet says (ensureRoles).
 */
export function typeFromHeader(header: string): { type: ColumnType; strong: boolean } | null {
  const h = norm(header);
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
    c("Status", "select", { options: [...STAGES, DEAD] }),
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
    c("Status", "select", { options: [...STAGES, DEAD] }),
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
