/**
 * The data model shared by the server and the client.
 *
 * A campaign is a list of prospects (companies), each with its own people (contacts). Both are
 * rows: a prospect row holds the company's columns, a contact row holds a person's and points
 * at its prospect (`parentId`). They are read from two tabs of a workbook, Prospects and
 * Contacts; the Contacts tab names each person's prospect by its ID (P-001), so renaming a
 * company never loses its people.
 *
 * Screening a prospect out only ticks its "Screened out" column, so a row never moves between
 * lists. The workbook is remembered separately, as `sheets`, so export can write each row back
 * to the sheet row it was read from without moving any existing column letter: formulas on
 * other tabs point at fixed letters, so a moved column is a broken formula.
 */

export type ColumnType =
  | "text"
  | "longtext"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "select"
  | "url"
  | "email"
  | "phone"
  | "checkbox";

export const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date + time" },
  { value: "select", label: "Dropdown" },
  { value: "url", label: "Link" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "checkbox", label: "Checkbox" },
];

export interface Column {
  key: string;
  header: string;
  type: ColumnType;
  /** Dropdown choices, for `select`. Read from the sheet's list data validation. */
  options?: string[];
  /** A `select` whose options are all numbers (e.g. Tier 1–4): written back as numbers. */
  numeric?: boolean;
  /** Width in CSS pixels, for the grid. */
  width?: number;
  /** Hidden in the grid (still exported). */
  hidden?: boolean;
  /** The header as imported. Export rewrites a sheet's header cell only when this differs
   *  (the user renamed the column), so matched headers such as Org/Company stay as they were. */
  importedHeader?: string;
  /**
   * Who made the column. `mudd` = added by the app itself (Intro message, Meeting URL…);
   * `discovery` = the intel columns a Discovery campaign starts with (Fit, Why they fit…).
   */
  origin?: "sheet" | "user" | "mudd" | "enrichment" | "discovery";
  /** Phase 2: the enrichment recipe that fills this column. */
  recipeId?: string;
}

/** A contact's columns. Keys are unique across these and the prospect's columns. */
export interface ContactSchema {
  columns: Column[];
  /** The person's name. */
  nameKey?: string;
  /** What kind of stakeholder they are: Economic Buyer, Gatekeeper… */
  typeKey?: string;
  /** Checkbox: the contact intros and templates address. At most one per prospect. */
  primaryKey?: string;
}

export interface CampaignSchema {
  columns: Column[];
  statusKey?: string;
  /** Checkbox column: ticked when the prospect is screened out (disabled in the app). */
  screenedKey?: string;
  /** Why the prospect was screened out. */
  reasonKey?: string;
  introKey?: string;
  meetingUrlKey?: string;
  meetingAtKey?: string;
  /** A person's name. On a prospect schema only in `prospectSchema`'s merged view, from `contacts`. */
  nameKey?: string;
  companyKey?: string;
  /** The prospect's ID (P-001): what the Contacts tab points at. Read-only in the app. */
  idKey?: string;
  /**
   * Prospect IDs the workbook's Contacts tab gives people whose prospect isn't in the campaign:
   * never handed to a new prospect, which would take those people on the next import.
   */
  reservedIds?: string[];
  contacts?: ContactSchema;
}

/**
 * A cell value as the app stores it.
 *   date      "YYYY-MM-DD"
 *   datetime  "YYYY-MM-DDTHH:mm"   (wall-clock time, no time zone)
 *   checkbox  "TRUE" when ticked, empty otherwise
 *   number / currency → number when the cell held one, else the text as typed
 */
export type CellValue = string | number | null;

/** A ticked checkbox cell. */
export const CHECKED = "TRUE";

/** The contact type of a way in that is no one person: a main line, a general inbox, a program desk. */
export const CHANNEL = "Channel";

export interface Row {
  id: string;
  position: number;
  cells: Record<string, CellValue>;
  /** A contact's prospect (that row's id). Absent on prospects. */
  parentId?: string | null;
  /** The sheet and row this was read from: export writes the row back to that same row. */
  sourceSheet?: string | null;
  sourceRow?: number | null;
}

/** `thesis`: a Mudd "ICP thesis" tab, the questionnaire a Discovery campaign is driven by. */
export type SheetRole = "prospects" | "contacts" | "passthrough" | "templates" | "thesis";

/**
 * The Contacts tab's link columns, as keys in its `colMap` and in a contact's export cells:
 * the prospect's ID (the foreign key) and its company name (a readable copy). Never real column
 * keys, which are only ever [a-z0-9_].
 */
export const ORG_ID_KEY = "@orgid";
export const ORG_KEY = "@org";

export interface SheetMeta {
  name: string;
  role: SheetRole;
  /** Column key → 1-based column index in this sheet. For `templates`: `name` and `body`. */
  colMap: Record<string, number>;
  /** Last row holding data when imported (1 = header only). */
  lastDataRow: number;
  /** Last used column when imported (data, merges, dropdowns, conditional formats). New
   *  columns go after it. */
  lastCol: number;
  /** Footnote rows under the data, kept below it on export. */
  trailer?: { from: number; to: number };
  /** The sheet rows that were imported as prospects. A deleted prospect's row is blanked. */
  dataRows?: number[];
}

export interface Campaign {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceName: string | null;
  sourcePath: string | null;
  hasOriginal: boolean;
  schema: CampaignSchema;
  sheets: SheetMeta[];
}

export interface Template {
  id: string;
  campaignId: string;
  name: string;
  body: string;
  position: number;
  updatedAt: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  updatedAt: number;
  sourceName: string | null;
  /** The file Save file writes to, when the campaign is linked to one. */
  sourcePath: string | null;
  /** Prospects still in play (not screened out). */
  prospects: number;
  screened: number;
  byStatus: Record<string, number>;
  stages: string[];
}

export interface CampaignBundle {
  campaign: Campaign;
  /** The prospects. */
  rows: Row[];
  contacts: Row[];
  templates: Template[];
  /** The ICP thesis; null for a campaign that is not a Discovery campaign (see isDiscovery). */
  thesis: Thesis | null;
}

/** The questions of the ICP thesis, by id (see THESIS_SECTIONS in thesis.ts). */
export type ThesisId =
  | "offer" | "avatar" | "pains" | "fit" | "jobs"
  | "painRoles" | "payerRoles" | "gainRoles" | "friction"
  | "exclude" | "triggers" | "channels"
  | "dealShape" | "clock" | "approach" | "win";

/** A Discovery campaign's ICP thesis: the answers that drive the search for prospects. */
export interface Thesis {
  campaignId: string;
  answers: Partial<Record<ThesisId, string>>;
  /** Answers the AI drafted and the user has neither edited nor kept. */
  drafted: ThesisId[];
  updatedAt: number;
}

export interface Meeting {
  campaignId: string;
  campaignName: string;
  rowId: string;
  title: string;
  subtitle: string;
  at: string;
  url: string | null;
  status: string | null;
}

/** GET /api/update/notes: what changed in the running version, from its GitHub release. */
export interface ReleaseNotes {
  version: string;
  /** The release's title, e.g. "Mudd v0.1.8". */
  title: string;
  /** One line per change; empty when the release lists none. */
  changes: string[];
}

/** GET /api/update: whether there's a newer Mudd, and whether this copy can install it itself. */
export interface UpdateInfo {
  current: string;
  /** A newer published release, or null when this is the newest (or GitHub couldn't be reached). */
  latest: { version: string; url: string } | null;
  /** The version already swapped in, waiting for Mudd to restart; null when none is. */
  installed: string | null;
  /** Why Mudd can't update itself, so the UI offers the download page instead; null when it can. */
  blocked: string | null;
}

export interface InspectSheet {
  name: string;
  rows: number;
  cols: number;
  headers: string[];
  hasStatus: boolean;
  hasFormulas: boolean;
  guess: SheetRole;
  /** One-cell note rows under the data (after a blank row): kept in the file, not imported. */
  footnotes: number;
}

export interface InspectResult {
  token: string;
  fileName: string;
  path: string | null;
  sheets: InspectSheet[];
  /** A Mudd-exported "Intro templates" sheet was found. */
  templates: number;
  /** Answers on a Mudd-exported "ICP thesis" sheet, if one was found. */
  thesis: number;
}

export interface CellEdit {
  rowId: string;
  key: string;
  value: CellValue;
}

/** The file types import accepts. Macro workbooks (.xlsm) are refused: saving would drop the macros. */
export const IMPORT_EXTENSIONS = [".xlsx", ".csv", ".tsv", ".txt"];

/** The Status column's stages when the sheet does not supply its own. */
export const DEFAULT_STAGES = [
  "Not contacted",
  "Contacted",
  "Replied",
  "Meeting booked",
  "Clinic held",
  "Trial",
  "Signed",
];
export const DEAD = "Dead";
export const MEETING_STAGE = "Meeting booked";

/** The pipeline stages for a campaign: its Status dropdown minus "Dead", or the defaults. */
export function stagesOf(schema: CampaignSchema): string[] {
  const col = schema.columns.find((c) => c.key === schema.statusKey);
  const opts = col?.options?.filter((o) => o.toLowerCase() !== DEAD.toLowerCase());
  return opts && opts.length > 1 ? opts : DEFAULT_STAGES;
}

/** A checkbox cell is ticked. */
export function isChecked(v: CellValue | undefined): boolean {
  return v === CHECKED;
}

/** The prospect is screened out: still in the list, but disabled. */
export function isScreened(row: Pick<Row, "cells">, schema: CampaignSchema): boolean {
  return !!schema.screenedKey && isChecked(row.cells[schema.screenedKey]);
}
