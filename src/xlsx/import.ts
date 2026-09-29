/**
 * Spreadsheet → campaign.
 *
 * Two steps: `inspectWorkbook` lists the tabs with a guessed role each, and `importWorkbook`
 * reads the chosen Prospects tab into one schema and one list of rows. Every other tab is left
 * alone (it reaches the saved file untouched); a Mudd "Intro templates" tab is read back as the
 * campaign's templates. A tab that looks like an old Screened-out list is never offered.
 *
 * A "Contacts" tab holds the prospects' people, one per row. Its Prospect ID column names each
 * person's prospect by the ID in the Prospects tab (P-001), so a renamed company keeps its
 * people; a row with no ID is matched by its Company instead. Rows that match no prospect in the
 * chosen tab are skipped, and stay in the file as they are; their IDs are never given to a new
 * prospect, which would take those people.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { norm } from "../shared/merge";
import { COMPANY_HEADERS, EMPLOYEES_HEADER, ensureAppColumns, isEmployeesHeader, looksLikeScreenedTab, makeKey, PROSPECT_ID_HEADER, prospectIds } from "../shared/schema";
import { ORG_ID_KEY, ORG_KEY, type CampaignSchema, type CellValue, type Column, type InspectSheet, type Row, type SheetMeta, type SheetRole } from "../shared/types";
import { colLetter, readCellValue } from "./cells";
import { charsToPx, detectType, parseListFormula, type ColumnSample } from "./layouts";
import {
  findBlock, getAttr, parseListValidations, parseRange, rangesOf, readText, replaceAt, setAttr, sheetParts, workbookPath,
  type ListValidation,
} from "./ooxml";

export const TEMPLATES_SHEET = "Intro templates";

export function isCsvName(name: string): boolean {
  return /\.(csv|tsv|txt)$/i.test(name);
}

// ---------- CSV ----------

/** Text from a file's bytes: UTF-8, or UTF-16 as Excel's "Unicode Text" writes it. */
function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = new Uint8Array(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  // UTF-16 with no byte-order mark: every other byte of plain text is zero.
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[3] === 0) return new TextDecoder("utf-16le").decode(buf);
  return new TextDecoder().decode(buf).replace(/^\uFEFF/, "");
}

/** Comma, semicolon (Excel's CSV in much of Europe) or tab: whichever the header uses most. */
function sniffDelimiter(text: string, fileName: string): string {
  if (/\.tsv$/i.test(fileName)) return "\t";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]!++;
  }
  const best = (["\t", ",", ";"] as const).reduce((a, b) => (counts[b]! > counts[a]! ? b : a));
  return counts[best]! > 0 ? best : ",";
}

export function parseDelimited(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Text that becomes a number with nothing lost: no leading zeros ("007"), no digits past what a
 * double holds (a 19-digit ID), trailing decimal zeros aside ("19.90" is 19.9).
 */
function losslessNumber(t: string): boolean {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return false;
  const n = Number(t);
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return false;
  const canonical = t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
  return String(n) === canonical;
}

function csvWorkbook(buf: Uint8Array, fileName: string): ExcelJS.Workbook {
  const text = decodeText(buf);
  const rows = parseDelimited(text, sniffDelimiter(text, fileName));
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  // A column is numbers only when every value in it converts losslessly; otherwise it stays text.
  const numeric = Array.from({ length: width }, (_, c) => {
    const vals = rows.slice(1).map((r) => (r[c] ?? "").trim()).filter(Boolean);
    return vals.length > 0 && vals.every(losslessNumber);
  });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prospects");
  rows.forEach((r, i) => ws.addRow(r.map((v, c) => (i > 0 && numeric[c] && v.trim() ? Number(v.trim()) : v))));
  return wb;
}

// ---------- loading a workbook ----------

export interface LoadedBook {
  wb: ExcelJS.Workbook;
  csv: boolean;
  /** List dropdowns per sheet (by its name in the file), read from the sheet XML. */
  validations: Map<string, ListValidation[]>;
  /** A sheet's name in the file. ExcelJS refuses a few names ("History"): those load renamed. */
  realName: (ws: ExcelJS.Worksheet) => string;
}

/** Remove a sheet's plain <dataValidations> block. */
function stripValidations(xml: string): string {
  const prefix = /<((?:[\w.-]+:)?)worksheet\b/.exec(xml)?.[1] ?? "";
  const b = findBlock(xml, "dataValidations", prefix);
  return b ? replaceAt(xml, b, "") : xml;
}

export async function loadWorkbook(buf: Uint8Array, fileName: string): Promise<LoadedBook> {
  if (isCsvName(fileName)) {
    return { wb: csvWorkbook(buf, fileName), csv: true, validations: new Map(), realName: (ws) => ws.name };
  }
  const zip = await JSZip.loadAsync(buf);
  const parts = await sheetParts(zip);
  const validations = new Map<string, ListValidation[]>();
  let changed = false;
  for (const part of parts) {
    const xml = await readText(zip, part.path);
    if (!xml) continue;
    validations.set(part.name, parseListValidations(xml));
    // ExcelJS expands every dropdown range cell by cell (a whole-column list costs over half a
    // gigabyte), and Mudd reads dropdowns from the XML above, so ExcelJS never sees them.
    const stripped = stripValidations(xml);
    if (stripped !== xml) {
      zip.file(part.path, stripped);
      changed = true;
    }
  }
  const aliases = new Map<string, string>();
  const wbPath = await workbookPath(zip);
  const wbXml = await readText(zip, wbPath);
  if (wbXml && parts.some((p) => p.name === "History")) {
    const taken = new Set(parts.map((p) => p.name.toLowerCase()));
    const renamed = wbXml.replace(/<(?:[\w.-]+:)?sheet\b[^>]*>/g, (tag) => {
      if (getAttr(tag, "name") !== "History") return tag;
      let alias = "History (1)";
      for (let i = 2; taken.has(alias.toLowerCase()); i++) alias = `History (${i})`;
      taken.add(alias.toLowerCase());
      aliases.set(alias, "History");
      return setAttr(tag, "name", alias);
    });
    zip.file(wbPath, renamed);
    changed = true;
  }
  const wb = new ExcelJS.Workbook();
  const bytes = changed ? await zip.generateAsync({ type: "uint8array", compression: "STORE" }) : buf;
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return { wb, csv: false, validations, realName: (ws) => aliases.get(ws.name) ?? ws.name };
}

// ---------- reading a sheet ----------

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" ||
  (typeof v === "object" && v !== null && "richText" in v && !(v as { richText: { text: string }[] }).richText.map((r) => r.text).join(""));

const isFormula = (v: unknown) => !!v && typeof v === "object" && ("formula" in v || "sharedFormula" in v);

export interface SheetTable {
  headers: string[];
  /** The last column with a header or any data: the columns imported. */
  dataCols: number;
  /** The last column anything uses (data, merges, dropdown ranges, conditional formats). New
   *  columns go after it, so they never land on something the sheet already has. */
  lastCol: number;
  lastDataRow: number;
  hasFormulas: boolean;
  samples: ColumnSample[];
  rows: { r: number; values: ExcelJS.CellValue[] }[];
  /** Note rows under the data, after a blank row ("From Rob's sheet, 4 Sep"). Kept, not imported. */
  trailer?: { from: number; to: number };
  /** How many note rows that is. */
  footnotes: number;
}

interface MergeRange { top: number; left: number; bottom: number; right: number }

/** Reads the cells a dropdown's range or defined name points at. */
function listResolver(book: LoadedBook, current: ExcelJS.Worksheet): (ref: string) => string[] | undefined {
  const byName = new Map(book.wb.worksheets.map((w) => [book.realName(w), w]));
  const read = (ref: string, depth: number): string[] | undefined => {
    const m = /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/i.exec(ref.trim());
    if (m) {
      const sheet = m[1]?.replace(/''/g, "'") ?? m[2] ?? null;
      const ws = sheet ? byName.get(sheet) : current;
      const rg = parseRange(m[3]!);
      if (!ws || !rg) return undefined;
      const out: string[] = [];
      for (let r = rg.r1; r <= Math.min(rg.r2, rg.r1 + 500); r++) {
        for (let c = rg.c1; c <= Math.min(rg.c2, rg.c1 + 20); c++) {
          const v = readCellValue(ws.getCell(r, c).value);
          if (v !== null && String(v).trim()) out.push(String(v).trim());
        }
      }
      return out.length ? out : undefined;
    }
    if (depth < 3 && /^[A-Za-z_\\][\w.]*$/.test(ref.trim())) {
      try {
        const names = book.wb.definedNames as unknown as { getRanges(n: string): { ranges?: string[] } | undefined };
        const first = names.getRanges(ref.trim())?.ranges?.[0];
        return first ? read(first, depth + 1) : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  return (ref) => read(ref, 0);
}

export function readSheet(ws: ExcelJS.Worksheet, book: LoadedBook, opts: { footnotes?: boolean } = {}): SheetTable {
  const name = book.realName(ws);
  // The covered cells of a merge read back as the merge's value; here they are empty, so a
  // merged footnote is one cell and a merged label is not repeated across the row.
  const covered = new Set<string>();
  let usedRight = 0;
  const merges = (ws as unknown as { _merges?: Record<string, MergeRange> })._merges ?? {};
  for (const m of Object.values(merges)) {
    for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) if (r !== m.top || c !== m.left) covered.add(`${r}:${c}`);
    usedRight = Math.max(usedRight, m.right);
  }

  const grid = new Map<number, Map<number, ExcelJS.CellValue>>();
  let dataCols = 0;
  let maxRow = 0;
  let hasFormulas = false;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const v = cell.value;
      if (isFormula(v)) hasFormulas = true;
      if (covered.has(`${r}:${c}`) || isEmpty(v)) return;
      let line = grid.get(r);
      if (!line) grid.set(r, (line = new Map()));
      line.set(c, v);
      dataCols = Math.max(dataCols, c);
      maxRow = Math.max(maxRow, r);
    });
  });

  const dvs = book.validations.get(name) ?? [];
  for (const dv of dvs) for (const rg of rangesOf(dv.sqref)) if (rg.c2 < 16_384) usedRight = Math.max(usedRight, rg.c2);
  const cfs = (ws as unknown as { conditionalFormattings?: { ref: string }[] }).conditionalFormattings ?? [];
  for (const cf of cfs) for (const rg of rangesOf(cf.ref ?? "")) if (rg.c2 < 16_384) usedRight = Math.max(usedRight, rg.c2);

  const rows: SheetTable["rows"] = [];
  for (const r of [...grid.keys()].sort((a, b) => a - b)) {
    if (r < 2) continue;
    const line = grid.get(r)!;
    rows.push({ r, values: Array.from({ length: dataCols }, (_, i) => line.get(i + 1) ?? null) });
  }

  // A short run of one-cell rows after a blank gap is a footnote, not data. Anything bigger is
  // data with a stray blank row in it, and is imported whole.
  let trailer: SheetTable["trailer"];
  let footnotes = 0;
  const gapAt = opts.footnotes === false ? -1 : rows.findIndex((row, i) => i > 0 && row.r > rows[i - 1]!.r + 1);
  if (gapAt > 0) {
    const tail = rows.slice(gapAt);
    const noteLike = tail.length <= 3 && tail.every((t) => t.values.filter((v) => !isEmpty(v)).length === 1);
    if (noteLike) {
      trailer = { from: tail[0]!.r, to: tail.at(-1)!.r };
      footnotes = tail.length;
      rows.splice(gapAt);
    }
  }
  const lastDataRow = rows.at(-1)?.r ?? 1;

  const resolve = listResolver(book, ws);
  const header = grid.get(1);
  const headers: string[] = [];
  const samples: ColumnSample[] = [];
  for (let c = 1; c <= dataCols; c++) {
    const text = String(readCellValue(header?.get(c) ?? null) ?? "").trim() || `Column ${colLetter(c)}`;
    headers.push(text);
    const numFmts: (string | undefined)[] = [];
    for (let r = 2; r <= Math.min(Math.max(lastDataRow, 2), 60); r++) numFmts.push(ws.getRow(r).getCell(c).numFmt);
    const dv = dvs.find((v) => rangesOf(v.sqref).some((rg) => rg.c1 <= c && c <= rg.c2 && rg.r2 >= 2));
    samples.push({
      header: text,
      values: rows.map((row) => row.values[c - 1]),
      numFmts,
      listOptions: parseListFormula(dv?.formula, resolve),
    });
  }
  return { headers, dataCols, lastCol: Math.max(dataCols, usedRight), lastDataRow, hasFormulas, samples, rows, trailer, footnotes };
}

// ---------- inspect ----------

function templateColumns(t: SheetTable): { name: number; body: number } | null {
  const name = t.headers.findIndex((h) => norm(h) === "name");
  const body = t.headers.findIndex((h) => ["template", "body", "message", "text"].includes(norm(h)));
  return body < 0 ? null : { name, body };
}

function readTemplates(t: SheetTable, cols: { name: number; body: number }): { name: string; body: string }[] {
  return t.rows
    .map((r, i) => ({
      name: String((cols.name >= 0 ? readCellValue(r.values[cols.name] ?? null) : null) ?? `Template ${i + 1}`),
      body: String(readCellValue(r.values[cols.body] ?? null) ?? ""),
    }))
    .filter((x) => x.body.trim());
}

/** "Intro templates", in any case, or "Intro templates 2" when the name was taken. */
const templatesName = (name: string) => /^introtemplates\d*$/.test(norm(name));

/** A Mudd "Intro templates" tab: that name and a Template column. */
const isTemplatesTab = (name: string, t: SheetTable) => templatesName(name) && templateColumns(t) !== null;

/** "Contacts", in any case, or "Contacts 2". */
const contactsName = (name: string) => /^contacts\d*$/.test(norm(name));

/** The link columns of a Contacts tab: the prospect's ID, and its company. -1 when missing. */
function linkColumns(t: SheetTable): { id: number; company: number } {
  const find = (names: string[]) => names.map((n) => t.headers.findIndex((h) => norm(h) === n)).find((i) => i >= 0) ?? -1;
  return { id: find([PROSPECT_ID_HEADER]), company: find(COMPANY_HEADERS) };
}

/** A Contacts tab: that name, a column linking each person to a prospect, and no formulas. */
function isContactsTab(name: string, t: SheetTable): boolean {
  const link = linkColumns(t);
  return contactsName(name) && !t.hasFormulas && (link.id >= 0 || link.company >= 0);
}

export function guessRoles(sheets: Omit<InspectSheet, "guess">[], templatesAt: number, contactsAt = -1): SheetRole[] {
  const roles: SheetRole[] = sheets.map(() => "passthrough");
  if (templatesAt >= 0) roles[templatesAt] = "templates";
  // Never the default Prospects tab, though it can still be picked as one.
  if (contactsAt >= 0) roles[contactsAt] = "contacts";
  const open = (s: Omit<InspectSheet, "guess">, i: number) => roles[i] === "passthrough" && !s.hasFormulas && !looksLikeScreenedTab(s.name);
  let prospects = sheets.findIndex((s, i) => open(s, i) && s.hasStatus);
  if (prospects < 0) prospects = sheets.findIndex((s, i) => open(s, i) && s.cols > 1);
  if (prospects >= 0) roles[prospects] = "prospects";
  return roles;
}

export function inspectWorkbook(book: LoadedBook): { sheets: InspectSheet[]; templates: number } {
  const tables = book.wb.worksheets.map((ws) => {
    const name = book.realName(ws);
    return { name, t: readSheet(ws, book, { footnotes: !templatesName(name) }) };
  });
  const base = tables.map(({ name, t }) => ({
    name,
    rows: t.rows.length,
    cols: t.dataCols,
    headers: t.headers.slice(0, 10),
    hasStatus: t.headers.some((h) => ["status", "stage"].includes(norm(h))),
    hasFormulas: t.hasFormulas,
    footnotes: t.footnotes,
  }));
  const tplAt = tables.findIndex(({ name, t }) => isTemplatesTab(name, t));
  const roles = guessRoles(base, tplAt, tables.findIndex(({ name, t }) => isContactsTab(name, t)));
  const tpl = tables[tplAt];
  return {
    sheets: base.map((s, i) => ({ ...s, guess: roles[i]! })),
    templates: tpl ? readTemplates(tpl.t, templateColumns(tpl.t)!).length : 0,
  };
}

// ---------- import ----------

export type ImportedRow = Omit<Row, "id"> & { orig: Record<string, CellValue> };

export interface ImportedCampaign {
  schema: CampaignSchema;
  sheets: SheetMeta[];
  rows: ImportedRow[];
  /** Each with the index in `rows` of its prospect. */
  contacts: (ImportedRow & { parent: number })[];
  /** Contacts-tab rows that match no prospect in the chosen tab: left in the file, not imported. */
  skippedContacts: number;
  /**
   * Contacts linked by Prospect ID whose Company names another company than that prospect's:
   * the ID wins, but rows moved in the Prospects tab without their IDs would do this.
   */
  mismatchedContacts: number;
  templates: { name: string; body: string }[];
}

/** An ID or company as it is matched: case, spacing and punctuation ignored ("Acme, Inc." is Acme Inc). */
const linkKey = (v: CellValue | undefined) => (v === null || v === undefined ? "" : norm(String(v)));

/** A column read from a sheet: its type from its values, its width from the sheet's. */
function sheetColumn(ws: ExcelJS.Worksheet, s: ColumnSample, index: number, taken: Set<string>): Column {
  const d = detectType(s);
  return {
    key: makeKey(s.header, taken),
    header: s.header,
    ...d,
    width: charsToPx(ws.getColumn(index + 1).width, d.type),
    origin: "sheet",
    importedHeader: s.header,
  };
}

export function importWorkbook(book: LoadedBook, choice: { prospects: string }): ImportedCampaign {
  const ws = book.wb.worksheets.find((w) => book.realName(w) === choice.prospects);
  if (!ws) throw new Error(`No tab named "${choice.prospects}" in this workbook.`);
  const t = readSheet(ws, book);
  if (t.hasFormulas) {
    throw new Error(`"${choice.prospects}" has formulas, and Mudd can't write into it without breaking them. Pick another tab, or save a copy of it without formulas.`);
  }

  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: [] };
  const colMap: Record<string, number> = {};
  t.samples.forEach((s, i) => {
    const col = sheetColumn(ws, s, i, taken);
    // Staff, Headcount, Size…: the first is "# Employees" (and export writes that header back).
    if (isEmployeesHeader(col.header) && !schema.columns.some((c) => c.header === EMPLOYEES_HEADER)) col.header = EMPLOYEES_HEADER;
    schema.columns.push(col);
    colMap[col.key] = i + 1;
  });

  // The people: the first Contacts tab, other than the one chosen, that is one (inspectWorkbook's
  // rule too, so the import dialog names the same tab), its columns keyed apart from the
  // prospect's (one namespace). Its two link columns are not contact columns.
  let contactsTab: { ws: ExcelJS.Worksheet; t: SheetTable; name: string; link: ReturnType<typeof linkColumns> } | null = null;
  for (const w of book.wb.worksheets) {
    const name = book.realName(w);
    if (w === ws || !contactsName(name)) continue;
    const ct = readSheet(w, book);
    if (!isContactsTab(name, ct)) continue;
    contactsTab = { ws: w, t: ct, name, link: linkColumns(ct) };
    break;
  }
  const contactMap: Record<string, number> = {};
  if (contactsTab) {
    const { link } = contactsTab;
    if (link.id >= 0) contactMap[ORG_ID_KEY] = link.id + 1;
    if (link.company >= 0) contactMap[ORG_KEY] = link.company + 1;
    const columns: Column[] = [];
    contactsTab.t.samples.forEach((s, i) => {
      if (i === link.id || i === link.company) return;
      const col = sheetColumn(contactsTab.ws, s, i, taken);
      columns.push(col);
      contactMap[col.key] = i + 1;
    });
    schema.contacts = { columns };
  }
  ensureAppColumns(schema);
  // The ID is for the sheet's links, not for reading: shown in the prospect panel, not the grid.
  const idCol = schema.columns.find((c) => c.key === schema.idKey);
  if (idCol) idCol.hidden = true;

  const read = (values: ExcelJS.CellValue[], map: Record<string, number>, cols: Column[]) => {
    const cells: Record<string, CellValue> = {};
    for (const col of cols) {
      const idx = map[col.key];
      if (!idx) continue;
      const v = readCellValue(values[idx - 1] ?? null, col.type, { preferLink: col.type === "url" || col.type === "email" });
      if (v !== null) cells[col.key] = v;
    }
    return cells;
  };
  const rows: ImportedRow[] = t.rows.map((r, i) => {
    const cells = read(r.values, colMap, schema.columns);
    return { position: i, cells, orig: { ...cells }, sourceSheet: choice.prospects, sourceRow: r.r };
  });

  // The Contacts tab's rows with their links, read before any ID is given out: an ID a person
  // there points at is never given to another prospect, even when theirs is not in this tab.
  const people = (contactsTab?.t.rows ?? []).map((r) => {
    const { link } = contactsTab!;
    return {
      r,
      id: link.id >= 0 ? readCellValue(r.values[link.id] ?? null) : null,
      company: link.company >= 0 ? readCellValue(r.values[link.company] ?? null) : null,
    };
  });

  // Every prospect has an ID, and no two the same: a missing or repeated one gets the next free
  // P-###, which the next save writes into the sheet. The first of two equal IDs keeps it.
  const idKey = schema.idKey!;
  const byId = new Map<string, number>();
  const nextId = prospectIds([
    ...rows.map((r) => String(r.cells[idKey] ?? "")),
    ...people.map((p) => String(p.id ?? "")),
  ]);
  rows.forEach((r, i) => {
    const k = linkKey(r.cells[idKey]);
    if (k && !byId.has(k)) {
      byId.set(k, i);
      return;
    }
    const id = nextId();
    r.cells[idKey] = id;
    byId.set(linkKey(id), i);
  });
  const companyOf = (i: number) => linkKey(rows[i]!.cells[schema.companyKey!]);
  const byCompany = new Map<string, number>();
  if (schema.companyKey) {
    rows.forEach((_, i) => {
      const k = companyOf(i);
      if (k && !byCompany.has(k)) byCompany.set(k, i);
    });
  }

  const contacts: ImportedCampaign["contacts"] = [];
  let skippedContacts = 0;
  let mismatchedContacts = 0;
  const reserved = new Set<string>();
  const linkedRows: number[] = [];
  for (const { r, id, company } of people) {
    const cells = read(r.values, contactMap, schema.contacts!.columns);
    // The ID when there is one: a company name can be stale, or shared.
    const parent = linkKey(id) ? byId.get(linkKey(id)) : byCompany.get(linkKey(company));
    if (parent === undefined) {
      skippedContacts++;
      if (linkKey(id)) reserved.add(String(id).trim());
      continue;
    }
    if (linkKey(id) && schema.companyKey && linkKey(company) && companyOf(parent) && linkKey(company) !== companyOf(parent)) mismatchedContacts++;
    const orig: Record<string, CellValue> = { ...cells };
    if (id !== null) orig[ORG_ID_KEY] = id;
    if (company !== null) orig[ORG_KEY] = company;
    contacts.push({ parent, position: contacts.length, cells, orig, sourceSheet: contactsTab!.name, sourceRow: r.r });
    linkedRows.push(r.r);
  }
  if (reserved.size) schema.reservedIds = [...reserved];

  const sheets: SheetMeta[] = book.wb.worksheets.map((w) => {
    const name = book.realName(w);
    if (w === ws) {
      return {
        name, role: "prospects", colMap, lastDataRow: t.lastDataRow, lastCol: t.lastCol, trailer: t.trailer,
        dataRows: t.rows.map((r) => r.r),
      };
    }
    if (contactsTab && w === contactsTab.ws) {
      // Only the rows imported: a deleted contact's row is blanked, the skipped ones never touched.
      const { lastDataRow, lastCol, trailer } = contactsTab.t;
      return { name, role: "contacts", colMap: contactMap, lastDataRow, lastCol, trailer, dataRows: linkedRows };
    }
    return { name, role: "passthrough", colMap: {}, lastDataRow: 0, lastCol: 0 };
  });

  let templates: ImportedCampaign["templates"] = [];
  for (const w of book.wb.worksheets) {
    const name = book.realName(w);
    if (w === ws || w === contactsTab?.ws || !templatesName(name)) continue;
    const tt = readSheet(w, book, { footnotes: false });
    const cols = templateColumns(tt);
    if (!cols) continue;
    templates = readTemplates(tt, cols);
    const meta = sheets.find((s) => s.name === name)!;
    meta.role = "templates";
    meta.colMap = cols.name >= 0 ? { name: cols.name + 1, body: cols.body + 1 } : { body: cols.body + 1 };
    meta.lastDataRow = tt.lastDataRow;
    meta.lastCol = tt.lastCol;
    break;
  }
  return { schema, sheets, rows, contacts, skippedContacts, mismatchedContacts, templates };
}
