/**
 * Just enough of the Office Open XML package format to patch a workbook in place: find a sheet's
 * part, read and rewrite its rows and cells, its relationships, and add cell formats to
 * styles.xml. It is string surgery on the original XML on purpose: whatever this code does not
 * touch reaches the saved file byte for byte (charts, SharePoint metadata, notes, every format).
 */
import type JSZip from "jszip";
import { colLetter, colNumber } from "./cells";

// ---------- text ----------

const ENTITY = /&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi;
const NAMED: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };

export function decodeXml(s: string): string {
  return s.replace(ENTITY, (_, e: string) => {
    const l = e.toLowerCase();
    if (l[0] !== "#") return NAMED[l]!;
    return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XML 1.0 has no place for most control characters, and Excel refuses a file holding one. */
// eslint-disable-next-line no-control-regex -- these are exactly the characters being removed
export const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- one start tag's attributes ----------

export function getAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${escRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : null;
}

/** Set, replace or (with null) remove an attribute on a start tag such as `<row r="1">`. */
export function setAttr(tag: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${escRe(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
  if (value === null) return tag.replace(re, "");
  const piece = ` ${name}="${escapeXml(value)}"`;
  if (re.test(tag)) return tag.replace(re, piece);
  return tag.replace(/\s*(\/?)>$/, `${piece}$1>`);
}

/** The start tag of an element's XML. */
export const startTag = (el: string) => el.slice(0, el.indexOf(">") + 1);

/** Rewrite an element's start tag. */
export const withStart = (el: string, fn: (tag: string) => string) => {
  const s = startTag(el);
  return fn(s) + el.slice(s.length);
};

// ---------- blocks inside a part ----------

/** The first `<prefix:tag …/>` or `<prefix:tag …>…</prefix:tag>` element. */
export function findBlock(xml: string, tag: string, prefix = ""): { text: string; index: number } | null {
  const t = escRe(prefix + tag);
  const m = new RegExp(`<${t}\\b[^>]*?(?:/>|>[\\s\\S]*?</${t}>)`).exec(xml);
  return m ? { text: m[0], index: m.index } : null;
}

export function replaceAt(xml: string, at: { text: string; index: number }, replacement: string): string {
  return xml.slice(0, at.index) + replacement + xml.slice(at.index + at.text.length);
}

/**
 * Insert `piece` before the first element (of `followers`, in schema order) that must come after
 * it, or before the closing root tag. Office refuses parts whose children are out of order.
 */
export function insertBefore(xml: string, piece: string, followers: string[], prefix: string, root: string): string {
  for (const tag of followers) {
    const i = xml.search(new RegExp(`<${escRe(prefix + tag)}\\b`));
    if (i >= 0) return xml.slice(0, i) + piece + xml.slice(i);
  }
  const end = xml.lastIndexOf(`</${prefix}${root}>`);
  return xml.slice(0, end) + piece + xml.slice(end);
}

/** Children of <worksheet> in the order ECMA-376 (CT_Worksheet) requires. */
export const WORKSHEET_ORDER = [
  "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection",
  "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells",
  "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup",
  "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
  "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
];

/** The worksheet children that must come after `tag`. */
export const followersOf = (tag: string) => WORKSHEET_ORDER.slice(WORKSHEET_ORDER.indexOf(tag) + 1);

// ---------- cell ranges ----------

export interface Range { c1: number; r1: number; c2: number; r2: number }
const MAX_ROW = 1_048_576;

/** "B2", "$B$2:$D$9", "C:C" (whole column) or "2:5" (whole rows) → numbers. */
export function parseRange(ref: string): Range | null {
  const [a, b = a] = ref.replace(/\$/g, "").trim().split(":");
  const one = (s: string) => /^([A-Z]*)(\d*)$/i.exec(s);
  const p = one(a!);
  const q = one(b!);
  if (!p || !q || (!p[1] && !p[2]) || (!q[1] && !q[2])) return null;
  return {
    c1: p[1] ? colNumber(p[1]) : 1,
    r1: p[2] ? +p[2] : 1,
    c2: q[1] ? colNumber(q[1]) : 16_384,
    r2: q[2] ? +q[2] : MAX_ROW,
  };
}

export const rangesOf = (sqref: string) => sqref.trim().split(/\s+/).map(parseRange).filter((r): r is Range => !!r);

export const rangeText = (r: Range) =>
  r.c1 === r.c2 && r.r1 === r.r2 ? `${colLetter(r.c1)}${r.r1}` : `${colLetter(r.c1)}${r.r1}:${colLetter(r.c2)}${r.r2}`;

export const cellRef = (col: number, row: number) => `${colLetter(col)}${row}`;

// ---------- the package ----------

export async function readText(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? f.async("string") : null;
}

/** "xl/worksheets/sheet1.xml" → "xl/worksheets/_rels/sheet1.xml.rels" */
export function relsPathOf(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** A relationship target, resolved against the part that owns the relationship. */
export function resolvePart(owner: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = owner.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export interface Rel { id: string; type: string; target: string; external: boolean }

export function parseRels(xml: string | null): Rel[] {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)].map((m) => ({
    id: getAttr(m[0], "Id") ?? "",
    type: getAttr(m[0], "Type") ?? "",
    target: getAttr(m[0], "Target") ?? "",
    external: getAttr(m[0], "TargetMode") === "External",
  }));
}

const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

export function addRels(xml: string | null, rels: Rel[]): string {
  const base = xml ?? EMPTY_RELS;
  if (!rels.length) return base;
  const pieces = rels
    .map((r) => `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`)
    .join("");
  if (/<Relationships\b[^>]*\/>/.test(base)) return base.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1>${pieces}</Relationships>`);
  return base.replace(/<\/Relationships>/, `${pieces}</Relationships>`);
}

/** Fresh relationship ids that clash with none already used. */
export function relIds(used: Iterable<string>): () => string {
  const taken = new Set(used);
  let n = 1;
  return () => {
    while (taken.has(`rId${n}`)) n++;
    const id = `rId${n}`;
    taken.add(id);
    return id;
  };
}

export const REL_TYPE = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  worksheet: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
};

export interface SheetPart {
  name: string;
  /** The part path, e.g. "xl/worksheets/sheet3.xml". */
  path: string;
  /** Position in the workbook's tab order (0-based), as `localSheetId` counts it. */
  index: number;
}

/** Where the workbook part lives (almost always xl/workbook.xml). */
export async function workbookPath(zip: JSZip): Promise<string> {
  const rels = parseRels(await readText(zip, "_rels/.rels"));
  const main = rels.find((r) => r.type.endsWith("/officeDocument"));
  return main ? resolvePart("", main.target) : "xl/workbook.xml";
}

/** Every tab, in order, with its part path. */
export async function sheetParts(zip: JSZip): Promise<SheetPart[]> {
  const wbPath = await workbookPath(zip);
  const wbXml = (await readText(zip, wbPath)) ?? "";
  const rels = new Map(parseRels(await readText(zip, relsPathOf(wbPath))).map((r) => [r.id, resolvePart(wbPath, r.target)]));
  const out: SheetPart[] = [];
  for (const m of wbXml.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)) {
    const name = getAttr(m[0], "name");
    const rid = /\s[\w.-]+:id\s*=\s*"([^"]+)"/.exec(m[0])?.[1];
    const path = rid ? rels.get(rid) : undefined;
    if (name !== null && path) out.push({ name, path, index: out.length });
  }
  return out;
}

/** The name as a formula writes it: quoted when it has anything but letters, digits and _. */
export const sheetRefName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

// ---------- sheet data: rows and cells ----------

export interface XCell {
  col: number;
  xml: string;
}

export interface XRow {
  num: number;
  /** The row's attributes, as written in its start tag (r, spans, ht, s…). */
  attrs: string;
  cells: XCell[];
  /** Anything in the row after its cells (an extLst). */
  extra: string;
  /** The original text while the row is unchanged; null once it has been edited. */
  raw: string | null;
}

export interface SheetDoc {
  /** The worksheet's namespace prefix: "" almost always, "x:" from some generators. */
  prefix: string;
  head: string;
  rows: XRow[];
  tail: string;
}

export function parseSheet(xml: string): SheetDoc {
  const prefix = /<((?:[\w.-]+:)?)worksheet\b/.exec(xml)?.[1] ?? "";
  const p = escRe(prefix);
  const open = new RegExp(`<${p}sheetData\\b[^>]*?(/?)>`).exec(xml);
  if (!open) throw new Error("This sheet has no data section.");
  let head: string;
  let body = "";
  let tail: string;
  if (open[1] === "/") {
    head = `${xml.slice(0, open.index)}<${prefix}sheetData>`;
    tail = `</${prefix}sheetData>${xml.slice(open.index + open[0].length)}`;
  } else {
    const close = xml.indexOf(`</${prefix}sheetData>`, open.index);
    head = xml.slice(0, open.index + open[0].length);
    body = xml.slice(open.index + open[0].length, close);
    tail = xml.slice(close);
  }
  const rows: XRow[] = [];
  const rowRe = new RegExp(`<${p}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${p}row>)`, "g");
  const cellRe = new RegExp(`<${p}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${p}c>)`, "g");
  let prevRow = 0;
  for (const m of body.matchAll(rowRe)) {
    const attrs = m[1]!;
    const num = Number(getAttr(`<row${attrs}>`, "r")) || prevRow + 1;
    prevRow = num;
    const inner = m[2] ?? "";
    const cells: XCell[] = [];
    let prevCol = 0;
    let end = 0;
    for (const c of inner.matchAll(cellRe)) {
      const ref = getAttr(startTag(c[0]), "r");
      const col = ref ? colNumber(/^[A-Z]+/i.exec(ref)?.[0] ?? "A") : prevCol + 1;
      prevCol = col;
      cells.push({ col, xml: c[0] });
      end = c.index! + c[0].length;
    }
    const extra = inner.slice(end);
    rows.push({ num, attrs, cells, extra: extra.trim() ? extra : "", raw: m[0] });
  }
  return { prefix, head, rows, tail };
}

const setAttrs = (attrs: string, name: string, value: string | null) => setAttr(`<x${attrs}>`, name, value).slice(2, -1);

function rowXml(p: string, row: XRow): string {
  let attrs = setAttrs(row.attrs, "r", String(row.num));
  if (getAttr(`<x${attrs}>`, "spans") !== null) {
    const cols = row.cells.map((c) => c.col);
    attrs = setAttrs(attrs, "spans", cols.length ? `${Math.min(...cols)}:${Math.max(...cols)}` : null);
  }
  const body = row.cells.map((c) => c.xml).join("") + row.extra;
  return body ? `<${p}row${attrs}>${body}</${p}row>` : `<${p}row${attrs}/>`;
}

export function serializeSheet(doc: SheetDoc): string {
  return doc.head + doc.rows.map((r) => r.raw ?? rowXml(doc.prefix, r)).join("") + doc.tail;
}

export const cellStyle = (cell: XCell | undefined) => (cell ? getAttr(startTag(cell.xml), "s") : null);

/** The cell holds a value (not just a format). */
export const cellHasValue = (cell: XCell | undefined) =>
  !!cell && (/<(?:[\w.-]+:)?v>[^<]/.test(cell.xml) || /<(?:[\w.-]+:)?is\b/.test(cell.xml));

export const cellHasFormula = (cell: XCell | undefined) => !!cell && /<(?:[\w.-]+:)?f\b/.test(cell.xml);

export type XValue = null | { n: number } | { b: boolean } | { s: string };

/** One cell's XML. Text goes in as an inline string, so sharedStrings.xml is never touched. */
export function makeCell(p: string, col: number, row: number, style: string | null, v: XValue): string {
  const r = cellRef(col, row);
  const s = style !== null ? ` s="${style}"` : "";
  if (v === null) return `<${p}c r="${r}"${s}/>`;
  if ("n" in v) return `<${p}c r="${r}"${s}><${p}v>${String(v.n)}</${p}v></${p}c>`;
  if ("b" in v) return `<${p}c r="${r}"${s} t="b"><${p}v>${v.b ? 1 : 0}</${p}v></${p}c>`;
  // Excel's limit for one cell is 32,767 characters.
  const text = escapeXml(cleanText(v.s).slice(0, 32_767));
  return `<${p}c r="${r}"${s} t="inlineStr"><${p}is><${p}t xml:space="preserve">${text}</${p}t></${p}is></${p}c>`;
}

/** Put a cell into its row, in column order, replacing any cell already there. */
export function putCell(row: XRow, col: number, xml: string): void {
  row.raw = null;
  const i = row.cells.findIndex((c) => c.col >= col);
  if (i < 0) row.cells.push({ col, xml });
  else if (row.cells[i]!.col === col) row.cells[i] = { col, xml };
  else row.cells.splice(i, 0, { col, xml });
}

/** Move a row to another row number, rewriting its cells' references. */
export function renumberRow(row: XRow, num: number): void {
  row.raw = null;
  row.num = num;
  row.cells = row.cells.map((c) => ({ col: c.col, xml: withStart(c.xml, (t) => setAttr(t, "r", cellRef(c.col, num))) }));
}

// ---------- data validations ----------

export interface ListValidation {
  sqref: string;
  /** formula1: `"a,b,c"` for a typed list, or a range / name such as `Lists!$A$1:$A$9`. */
  formula: string;
}

/**
 * The list dropdowns of a sheet: the plain `<dataValidations>` block and the Excel 2010
 * `<x14:dataValidations>` inside extLst (how Excel stores a list that lives on another tab).
 */
export function parseListValidations(sheetXml: string): ListValidation[] {
  const out: ListValidation[] = [];
  for (const m of sheetXml.matchAll(/<((?:[\w.-]+:)?)dataValidation\b([^>]*)>([\s\S]*?)<\/\1dataValidation>/g)) {
    const tag = `<x${m[2]}>`;
    if (getAttr(tag, "type") !== "list") continue;
    const inner = m[3]!;
    const f = /<((?:[\w.-]+:)?)formula1>([\s\S]*?)<\/\1formula1>/.exec(inner)?.[2];
    const sqref = getAttr(tag, "sqref") ?? /<(?:[\w.-]+:)?sqref>([^<]*)</.exec(inner)?.[1] ?? null;
    if (f === undefined || !sqref) continue;
    out.push({ sqref: decodeXml(sqref), formula: decodeXml(f.replace(/<\/?(?:[\w.-]+:)?f>/g, "")).trim() });
  }
  return out;
}

/** The options of a typed list formula (`"a,b,c"`), or null for a range or a name. */
export function inlineListOptions(formula: string): string[] | null {
  const f = formula.trim();
  if (!f.startsWith('"')) return null;
  return f.replace(/^"|"$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- styles.xml ----------

const BUILTIN_FMT: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0",
  48: "##0.0E+0", 49: "@",
};

/** A number format that shows a date or a time. */
export function isDateFormat(id: number, code: string): boolean {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\.|_.|\*./g, "")
    .replace(/general/gi, "");
  return /[dmyhs]/i.test(bare);
}

/**
 * The workbook's cell formats (cellXfs), read once, with the ability to add variants of an
 * existing format: the same font, fill and border with a date number format, wrapped text or a
 * fill. Existing formats are never changed or renumbered, so every original cell keeps its look.
 */
export class StyleBook {
  private readonly prefix: string;
  private readonly fmts = new Map<number, string>();
  private readonly xfs: string[] = [];
  private readonly fillCount: number;
  private readonly addedFmts: { id: number; code: string }[] = [];
  private readonly addedFills: string[] = [];
  private readonly addedXfs: string[] = [];
  private readonly cache = new Map<string, string>();

  constructor(private readonly xml: string | null) {
    this.prefix = xml ? /<((?:[\w.-]+:)?)styleSheet\b/.exec(xml)?.[1] ?? "" : "";
    if (!xml) {
      this.fillCount = 0;
      return;
    }
    for (const m of xml.matchAll(/<(?:[\w.-]+:)?numFmt\b[^>]*>/g)) {
      const id = Number(getAttr(m[0], "numFmtId"));
      const code = getAttr(m[0], "formatCode");
      if (Number.isFinite(id) && code !== null) this.fmts.set(id, code);
    }
    const xfBlock = findBlock(xml, "cellXfs", this.prefix);
    if (xfBlock) {
      const p = escRe(this.prefix);
      this.xfs = [...xfBlock.text.matchAll(new RegExp(`<${p}xf\\b[^>]*?(?:/>|>[\\s\\S]*?</${p}xf>)`, "g"))].map((m) => m[0]);
    }
    const fills = findBlock(xml, "fills", this.prefix);
    this.fillCount = fills ? [...fills.text.matchAll(new RegExp(`<${escRe(this.prefix)}fill\\b`, "g"))].length : 0;
  }

  get changed(): boolean {
    return this.addedXfs.length > 0;
  }

  private fmtIdOf(style: string | null): number {
    const xf = this.xfs[Number(style ?? 0)];
    return xf ? Number(getAttr(startTag(xf), "numFmtId") ?? 0) : 0;
  }

  /** The number format code a style shows its value with. */
  formatOf(style: string | null): string {
    const id = this.fmtIdOf(style);
    return this.fmts.get(id) ?? BUILTIN_FMT[id] ?? "General";
  }

  isDate(style: string | null): boolean {
    const id = this.fmtIdOf(style);
    return isDateFormat(id, this.formatOf(style));
  }

  /** A format like `base` but with the changes asked for; added once and reused. */
  derive(base: string | null, want: { numFmt?: string; wrap?: boolean; fill?: string }): string | null {
    if (!this.xml) return base;
    const key = `${base ?? ""}|${want.numFmt ?? ""}|${want.wrap ? 1 : 0}|${want.fill ?? ""}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = this.prefix;
    let xf = this.xfs[Number(base ?? 0)] ?? `<${p}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
    if (want.numFmt) {
      const id = this.fmtId(want.numFmt);
      xf = withStart(xf, (t) => setAttr(setAttr(t, "numFmtId", String(id)), "applyNumberFormat", "1"));
    }
    if (want.fill) {
      const id = this.fillId(want.fill);
      xf = withStart(xf, (t) => setAttr(setAttr(t, "fillId", String(id)), "applyFill", "1"));
    }
    if (want.wrap) {
      xf = withStart(xf, (t) => setAttr(t, "applyAlignment", "1"));
      const align = new RegExp(`<${escRe(p)}alignment\\b[^>]*?/?>`).exec(xf);
      if (align) {
        xf = xf.replace(align[0], setAttr(setAttr(align[0], "wrapText", "1"), "vertical", "top"));
      } else if (/\/>$/.test(startTag(xf)) && startTag(xf) === xf) {
        xf = `${xf.replace(/\s*\/>$/, ">")}<${p}alignment wrapText="1" vertical="top"/></${p}xf>`;
      } else {
        const s = startTag(xf);
        xf = `${s}<${p}alignment wrapText="1" vertical="top"/>${xf.slice(s.length)}`;
      }
    }
    const index = String(this.xfs.length);
    this.xfs.push(xf);
    this.addedXfs.push(xf);
    this.cache.set(key, index);
    return index;
  }

  private fmtId(code: string): number {
    for (const [id, c] of this.fmts) if (c === code) return id;
    const id = Math.max(163, ...this.fmts.keys()) + 1;
    this.fmts.set(id, code);
    this.addedFmts.push({ id, code });
    return id;
  }

  private fillId(argb: string): number {
    const i = this.addedFills.indexOf(argb);
    if (i >= 0) return this.fillCount + i;
    this.addedFills.push(argb);
    return this.fillCount + this.addedFills.length - 1;
  }

  toXml(): string {
    let xml = this.xml!;
    const p = this.prefix;
    /** Append children to a block and set its count to the new total. */
    const extend = (tag: string, pieces: string[], total: number): boolean => {
      if (!pieces.length) return true;
      const b = findBlock(xml, tag, p);
      if (!b) return false;
      let text = b.text;
      if (startTag(text) === text) text = `${text.replace(/\s*\/>$/, ">")}</${p}${tag}>`;
      text = withStart(text, (t) => setAttr(t, "count", String(total)));
      text = text.replace(new RegExp(`</${escRe(p + tag)}>$`), `${pieces.join("")}</${p}${tag}>`);
      xml = replaceAt(xml, b, text);
      return true;
    };
    const fmtPieces = this.addedFmts.map((f) => `<${p}numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`);
    if (!extend("numFmts", fmtPieces, this.fmts.size)) {
      // numFmts is the first child of styleSheet when present.
      const root = new RegExp(`<${escRe(p)}styleSheet\\b[^>]*>`).exec(xml)!;
      const at = root.index + root[0].length;
      xml = `${xml.slice(0, at)}<${p}numFmts count="${fmtPieces.length}">${fmtPieces.join("")}</${p}numFmts>${xml.slice(at)}`;
    }
    extend(
      "fills",
      this.addedFills.map((c) => `<${p}fill><${p}patternFill patternType="solid"><${p}fgColor rgb="${c}"/><${p}bgColor rgb="${c}"/></${p}patternFill></${p}fill>`),
      this.fillCount + this.addedFills.length,
    );
    extend("cellXfs", this.addedXfs, this.xfs.length);
    return xml;
  }
}

// ---------- dates ----------

const DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** A wall-clock date and time → Excel's day number (1900 or 1904 date system). */
export function toSerial(y: number, m: number, d: number, hh = 0, mm = 0, date1904 = false): number {
  const t = Date.UTC(y, m - 1, d, hh, mm);
  if (date1904) return (t - EPOCH_1904) / DAY;
  const n = (t - EPOCH_1900) / DAY;
  // Excel's calendar has a 29 Feb 1900; day numbers before March 1900 are one lower.
  return n < 61 ? n - 1 : n;
}
