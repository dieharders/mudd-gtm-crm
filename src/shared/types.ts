/**
 * The data model shared by the server and the client.
 *
 * A campaign is ONE schema (column list) and two buckets of rows: Prospects and Screened out.
 * The spreadsheet it came from is remembered separately, as `sheets`, so export can write each
 * bucket back to the sheet it was read from without moving any existing column letter — the
 * Summary tab's formulas point at fixed letters, so a moved column is a broken formula.
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
  | "phone";

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
  /** Who made the column. `mudd` = added by the app itself (Intro message, Meeting URL…). */
  origin?: "sheet" | "user" | "mudd" | "enrichment";
  /** Phase 2: the enrichment recipe that fills this column. */
  recipeId?: string;
}

export interface CampaignSchema {
  columns: Column[];
  statusKey?: string;
  reasonKey?: string;
  introKey?: string;
  meetingUrlKey?: string;
  meetingAtKey?: string;
  nameKey?: string;
  companyKey?: string;
}

export type Bucket = "prospects" | "screened";

/**
 * A cell value as the app stores it.
 *   date      "YYYY-MM-DD"
 *   datetime  "YYYY-MM-DDTHH:mm"   (wall-clock time, no time zone)
 *   number / currency → number when the cell held one, else the text as typed
 */
export type CellValue = string | number | null;

export interface Row {
  id: string;
  bucket: Bucket;
  position: number;
  cells: Record<string, CellValue>;
  /** Where the row was read from, so export can reuse that row's cell styles. */
  sourceSheet?: string | null;
  sourceRow?: number | null;
}

export type SheetRole = "prospects" | "screened" | "passthrough" | "templates";

export interface SheetMeta {
  name: string;
  role: SheetRole;
  /** Column key → 1-based column index in this sheet. */
  colMap: Record<string, number>;
  /** Last row holding data when imported (1 = header only). */
  lastDataRow: number;
  /** Last used column when imported. New columns go after it. */
  lastCol: number;
  /** Footnote rows under the data, kept below it on export. */
  trailer?: { from: number; to: number };
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
  prospects: number;
  screened: number;
  byStatus: Record<string, number>;
  stages: string[];
}

export interface CampaignBundle {
  campaign: Campaign;
  rows: Row[];
  templates: Template[];
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

export interface InspectSheet {
  name: string;
  rows: number;
  cols: number;
  headers: string[];
  hasStatus: boolean;
  hasFormulas: boolean;
  guess: SheetRole;
}

export interface InspectResult {
  token: string;
  fileName: string;
  path: string | null;
  sheets: InspectSheet[];
  /** A Mudd-exported "Intro templates" sheet was found. */
  templates: number;
}

export interface CellEdit {
  rowId: string;
  key: string;
  value: CellValue;
}

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
