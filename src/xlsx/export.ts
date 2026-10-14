/**
 * Campaign → spreadsheet.
 *
 * With the workbook it was imported from, export PATCHES that workbook: it opens the package,
 * rewrites the Prospects tab's XML (and the Intro templates tab), and every other part reaches
 * the saved file byte for byte — other tabs and their formulas, charts, notes, cell formats,
 * SharePoint properties.
 *
 * On the Prospects tab:
 *   - a row is written back to the sheet row it came from, and only the cells whose value changed
 *     since import are rewritten, each keeping its own format. Nothing moves, so formulas on
 *     other tabs, notes, merges and hidden rows stay with the right prospect.
 *   - a deleted prospect's row is blanked (its formats stay), never removed
 *   - new prospects go in the rows under the data; a footnote under the data moves down
 *   - columns the sheet lacks are appended after its last used column
 *   - dropdown lists follow the options set in the app
 *
 * The Contacts tab is patched the same way, a contact to the row it came from; it gets each
 * person's Prospect ID and Company from their prospect, so a renamed company is renamed there
 * too. A workbook without one gets one added, once it has contacts.
 *
 * A campaign with no workbook of its own (a CSV, or created in Mudd) gets a new one in the
 * base-tracker look instead, built with ExcelJS.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { contactSchema, orgColumn } from "../shared/schema";
import { THESIS_QUESTIONS, THESIS_SHEET } from "../shared/thesis";
import { ORG_ID_KEY, ORG_KEY, type Campaign, type CampaignSchema, type CellValue, type Column, type Row, type SheetMeta, type Template, type Thesis } from "../shared/types";
import { orderedContacts, parseFlag, sameValue } from "../shared/values";
import { colLetter, hrefFor, numFmtFor, parseAppDate, toExcelValue, toNumber } from "./cells";
import { TEMPLATES_SHEET, THESIS_DRAFT_MARK } from "./import";
import {
  dataStyle, isYours, LIST_FORMULA_MAX, listFormula, pxToChars, STYLE, styleGeneratedSheet, VALIDATION_ROWS, YOURS_FILL,
} from "./layouts";
import {
  addRels, cellHasValue, cellRef, cellStyle, decodeXml, escapeXml, findBlock, followersOf, getAttr, inlineListOptions,
  insertBefore, makeCell, parseListValidations, parseRange, parseRels, parseSheet, putCell, rangesOf, rangeText, readText,
  relIds, relsPathOf, REL_TYPE, renumberRow, replaceAt, resolvePart, serializeSheet, setAttr, sheetParts, sheetRefName,
  startTag, StyleBook, toSerial, withStart, workbookPath, type Range, type Rel, type SheetDoc, type SheetPart, type XRow,
  type XValue,
} from "./ooxml";

/** A row to export, with its cells as imported (`orig`) when it came from the sheet. */
export type ExportRow = Row & { orig?: Record<string, CellValue> | null };

/** The Contacts tab's name, when Mudd adds it. */
export const CONTACTS_SHEET = "Contacts";

/**
 * `rows` are the prospects, `contacts` their people. Contacts are required: a workbook's
 * Contacts tab written without them would lose every person on it. So is the thesis (null for a
 * campaign without one): a save that forgot it would drop the tab that makes the campaign a
 * Discovery campaign when the file is imported again.
 */
export async function exportCampaign(
  campaign: Campaign,
  original: Uint8Array | null,
  rows: ExportRow[],
  templates: Template[],
  contacts: ExportRow[],
  thesis: Thesis | null,
): Promise<Uint8Array> {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const tpls = [...templates].sort((a, b) => a.position - b.position);
  const people = contactExportRows(campaign.schema, ordered, contacts);
  if (!original) return generatedWorkbook(campaign.schema, ordered, tpls, people, thesis);
  return patchWorkbook(campaign, original, ordered, tpls, people, thesis);
}

/** The thesis tab's rows: every question in order, its answer, and who filled it. */
function thesisRows(thesis: Thesis): { question: string; answer: string; filledBy: string }[] {
  return THESIS_QUESTIONS.map((q) => ({
    question: q.label,
    answer: thesis.answers[q.id] ?? "",
    filledBy: thesis.answers[q.id] && thesis.drafted.includes(q.id) ? THESIS_DRAFT_MARK : "",
  }));
}

const hasAnswers = (thesis: Thesis | null): thesis is Thesis => !!thesis && Object.values(thesis.answers).some((a) => a?.trim());

/**
 * The Contacts tab's columns: the prospect's ID (what the tab links by) and its company (to read
 * by, when the prospects have a Company column), both from the prospect, then the contact's own.
 * A Company column the tab has that isn't among these is left as it is. The contacts' roles go
 * along, for the columns' look (isYours).
 */
function contactsTabSchema(schema: CampaignSchema): CampaignSchema {
  const id = schema.columns.find((c) => c.key === schema.idKey);
  const org = orgColumn(schema);
  return {
    columns: [
      { key: ORG_ID_KEY, header: "Prospect ID", type: "text", width: id?.width ?? 90 },
      ...(org ? [org] : []),
      ...contactSchema(schema).columns,
    ],
    contacts: schema.contacts,
  };
}

/** Contacts as the tab lists them: by prospect, primary first, each with its prospect's ID and company. */
function contactExportRows(schema: CampaignSchema, orgs: ExportRow[], contacts: ExportRow[]): ExportRow[] {
  const byOrg = new Map<string, ExportRow[]>();
  for (const c of [...contacts].sort((a, b) => a.position - b.position)) {
    if (!c.parentId) continue;
    const list = byOrg.get(c.parentId);
    if (list) list.push(c);
    else byOrg.set(c.parentId, [c]);
  }
  const out: ExportRow[] = [];
  for (const org of orgs) {
    const id = schema.idKey ? org.cells[schema.idKey] ?? null : null;
    const company = schema.companyKey ? org.cells[schema.companyKey] ?? null : null;
    for (const c of orderedContacts(byOrg.get(org.id) ?? [], schema)) {
      out.push({ ...c, cells: { ...c.cells, [ORG_ID_KEY]: id, [ORG_KEY]: company } });
    }
  }
  return out;
}

// ---------- patching the imported workbook ----------

const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The prefix a part uses for the relationships namespace (r:id), declaring `r` if it has none. */
function relsPrefix(xml: string, root: string): { xml: string; prefix: string } {
  const m = new RegExp(`xmlns:([\\w.-]+)="${RELS_NS.replace(/[/.]/g, "\\$&")}"`).exec(xml);
  if (m) return { xml, prefix: m[1]! };
  const open = new RegExp(`<((?:[\\w.-]+:)?)${root}\\b[^>]*?(/?)>`).exec(xml)!;
  return { xml: xml.replace(open[0], setAttr(open[0], "xmlns:r", RELS_NS)), prefix: "r" };
}

async function patchWorkbook(campaign: Campaign, original: Uint8Array, rows: ExportRow[], templates: Template[], contacts: ExportRow[], thesis: Thesis | null): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(original);
  const parts = await sheetParts(zip);
  const wbPath = await workbookPath(zip);
  let wbXml = (await readText(zip, wbPath))!;
  const wbRels = parseRels(await readText(zip, relsPathOf(wbPath)));
  const stylesRel = wbRels.find((r) => r.type.endsWith("/styles"));
  const stylesPath = stylesRel ? resolvePart(wbPath, stylesRel.target) : "xl/styles.xml";
  const book = new StyleBook(await readText(zip, stylesPath));
  const date1904 = /<(?:[\w.-]+:)?workbookPr\b[^>]*\bdate1904\s*=\s*"(?:1|true)"/.test(wbXml);

  const meta = campaign.sheets.find((s) => s.role === "prospects");
  if (!meta) throw new Error("This campaign has no Prospects tab to write to.");
  const part = parts.find((p) => p.name === meta.name);
  if (!part) throw new Error(`The tab "${meta.name}" is missing from the stored workbook.`);

  const res = await patchSheet(zip, part, meta, campaign.schema, rows, book, date1904);
  if (res.filter) wbXml = setFilterName(wbXml, part, res.filter);
  wbXml = await writeContactsTab(zip, wbPath, wbXml, parts, campaign, contacts, book, date1904, res.headerStyle);
  wbXml = await writeTemplatesTab(zip, wbPath, wbXml, parts, campaign.sheets, templates, book, res.headerStyle);
  wbXml = await writeThesisTab(zip, wbPath, wbXml, parts, campaign.sheets, thesis, book, res.headerStyle);
  wbXml = forceRecalc(wbXml);
  zip.file(wbPath, wbXml);
  if (book.changed) zip.file(stylesPath, book.toXml());
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Most-used style of the cells in each column over some rows; cells holding a value count first. */
function typicalStyles(rows: XRow[], from: number, to: number): Map<number, string> {
  const valued = new Map<number, Map<string, number>>();
  const any = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (r.num < from || r.num > to) continue;
    for (const c of r.cells) {
      const s = cellStyle(c);
      if (s === null) continue;
      const target = cellHasValue(c) ? valued : any;
      let m = target.get(c.col);
      if (!m) target.set(c.col, (m = new Map()));
      m.set(s, (m.get(s) ?? 0) + 1);
    }
  }
  const best = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const out = new Map<number, string>();
  for (const [col, m] of any) out.set(col, best(m));
  for (const [col, m] of valued) out.set(col, best(m));
  return out;
}

/** Column default styles from <cols>, for the columns up to `upTo`. */
function colDefaults(head: string, prefix: string, upTo: number): Map<number, string> {
  const out = new Map<number, string>();
  const cols = findBlock(head, "cols", prefix);
  if (!cols) return out;
  for (const m of cols.text.matchAll(/<(?:[\w.-]+:)?col\b[^>]*>/g)) {
    const style = getAttr(m[0], "style");
    if (style === null) continue;
    const min = Number(getAttr(m[0], "min"));
    const max = Math.min(Number(getAttr(m[0], "max")), upTo);
    for (let c = min; c <= max; c++) out.set(c, style);
  }
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.trim() === b[i]!.trim());

interface SheetResult {
  /** The tab's header style, for the header of a tab Mudd adds. */
  headerStyle: string | null;
  /** The autofilter's new range, when it changed. */
  filter: Range | null;
}

/** Write rows into a tab read at import (Prospects, Contacts): see the top of this file. */
async function patchSheet(
  zip: JSZip,
  part: SheetPart,
  meta: SheetMeta,
  schema: CampaignSchema,
  rows: ExportRow[],
  book: StyleBook,
  date1904: boolean,
): Promise<SheetResult> {
  const doc = parseSheet((await readText(zip, part.path))!);
  const p = doc.prefix;
  const relsPath = relsPathOf(part.path);
  const relsXml = await readText(zip, relsPath);
  const rels = parseRels(relsXml);

  const byNum = new Map(doc.rows.map((r) => [r.num, r]));
  const rowAt = (num: number): XRow => {
    let r = byNum.get(num);
    if (!r) byNum.set(num, (r = { num, attrs: "", cells: [], extra: "", raw: null }));
    return r;
  };
  const cellAt = (row: XRow | undefined, col: number) => row?.cells.find((c) => c.col === col);

  // Where each column goes: its own column, or appended after the last used one.
  const placed: { col: Column; idx: number; inSheet: boolean }[] = [];
  let next = meta.lastCol + 1;
  for (const col of schema.columns) {
    const idx = meta.colMap[col.key];
    placed.push(idx ? { col, idx, inSheet: true } : { col, idx: next++, inSheet: false });
  }
  const appended = placed.filter((x) => !x.inSheet);
  const lastCol = Math.max(meta.lastCol, next - 1);

  const typical = typicalStyles(doc.rows, 2, Math.max(2, meta.lastDataRow));
  const defaults = colDefaults(doc.head, p, lastCol);
  const rowStyle = (row: XRow) => {
    const tag = `<x${row.attrs}>`;
    return getAttr(tag, "customFormat") === "1" || getAttr(tag, "customFormat") === "true" ? getAttr(tag, "s") : null;
  };
  const baseStyle = (row: XRow, idx: number) => typical.get(idx) ?? defaults.get(idx) ?? rowStyle(row) ?? null;

  // A column the sheet lacks: this row's look (fill, border) from its last column, with the
  // column's own number format, wrapping for long text and the "yours" fill.
  const appendedStyle = (row: XRow, col: Column) => {
    const neighbour = cellStyle(cellAt(row, meta.lastCol)) ?? typical.get(meta.lastCol) ?? null;
    const want = { numFmt: numFmtFor(col.type), wrap: col.type === "longtext", fill: isYours(col, schema) ? YOURS_FILL : undefined };
    return want.numFmt || want.wrap || want.fill ? book.derive(neighbour, want) : neighbour;
  };

  // ----- hyperlinks -----
  const links = new Map<string, string>(); // ref → <hyperlink> XML kept from the sheet
  const hlBlock = findBlock(doc.tail, "hyperlinks", p);
  if (hlBlock) for (const m of hlBlock.text.matchAll(/<(?:[\w.-]+:)?hyperlink\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?hyperlink>)/g)) {
    const ref = getAttr(startTag(m[0]), "ref");
    if (ref) links.set(ref.toUpperCase(), m[0]);
  }
  const newLinks = new Map<string, string>(); // ref → URL to add
  let linksChanged = false;
  const setLink = (ref: string, url: string | null) => {
    if (links.delete(ref)) linksChanged = true;
    if (newLinks.delete(ref)) linksChanged = true;
    if (url) {
      newLinks.set(ref, url);
      linksChanged = true;
    }
  };

  // ----- writing cells -----
  const toX = (v: CellValue, col: Column): XValue => {
    if (v === null || v === "") return null;
    switch (col.type) {
      case "number":
      case "currency": {
        const n = toNumber(v);
        return n !== null ? { n } : { s: String(v) };
      }
      case "select":
        if (col.numeric) {
          const n = toNumber(v);
          if (n !== null) return { n };
        }
        return { s: String(v) };
      case "checkbox":
        return parseFlag(v) ? { b: true } : null;
      case "date":
      case "datetime": {
        const d = parseAppDate(v);
        if (!d) return { s: String(v) };
        const t = col.type === "datetime";
        return { n: toSerial(d.y, d.m, d.d, t ? d.hh : 0, t ? d.mm : 0, date1904) };
      }
      default:
        return typeof v === "number" ? { n: v } : { s: String(v) };
    }
  };

  const writeCell = (row: XRow, idx: number, col: Column, v: CellValue, fallbackStyle: string | null) => {
    const existing = cellAt(row, idx);
    let style = existing ? cellStyle(existing) : fallbackStyle;
    const x = toX(v, col);
    if (x && "n" in x && (col.type === "date" || col.type === "datetime") && parseAppDate(v)) {
      // A date in a cell with no date format shows as 46291. A cell that has one keeps it (the
      // sheet's own "d mmm yyyy"), unless it would hide a meeting's time.
      const ok = book.isDate(style) && (col.type === "date" || /h/i.test(book.formatOf(style)));
      if (!ok) style = book.derive(style, { numFmt: numFmtFor(col.type) });
    }
    putCell(row, idx, makeCell(p, idx, row.num, style, x));
    const ref = cellRef(idx, row.num);
    const url = col.type === "url" && typeof v === "string" ? hrefFor(v) : null;
    if (url || links.has(ref) || newLinks.has(ref)) setLink(ref, url);
  };

  // ----- header row -----
  const header = rowAt(1);
  const headerStyle =
    cellStyle(cellAt(header, meta.lastCol)) ??
    cellStyle([...header.cells].reverse().find((c) => cellStyle(c) !== null)) ??
    null;
  for (const { col, idx, inSheet } of placed) {
    if (inSheet) {
      if (col.importedHeader !== undefined && col.header !== col.importedHeader) {
        putCell(header, idx, makeCell(p, idx, 1, cellStyle(cellAt(header, idx)), { s: col.header }));
      }
    } else {
      putCell(header, idx, makeCell(p, idx, 1, cellStyle(cellAt(header, idx)) ?? headerStyle, { s: col.header }));
    }
  }

  // ----- rows read from the sheet -----
  const anchored = new Map<number, ExportRow>();
  const fresh: ExportRow[] = [];
  for (const r of rows) {
    const n = r.sourceRow;
    if (n && r.sourceSheet === meta.name && n >= 2 && n <= meta.lastDataRow && !anchored.has(n)) anchored.set(n, r);
    else fresh.push(r);
  }
  const dataRows = meta.dataRows ?? Array.from({ length: Math.max(0, meta.lastDataRow - 1) }, (_, i) => i + 2);
  for (const n of dataRows) {
    const r = anchored.get(n);
    if (!r) {
      // Deleted in the app: the row is blanked, its formats kept, nothing below it moves.
      const row = byNum.get(n);
      if (!row) continue;
      for (const c of [...row.cells]) {
        if (c.col > lastCol || !cellHasValue(c)) continue;
        putCell(row, c.col, makeCell(p, c.col, n, cellStyle(c), null));
        const ref = cellRef(c.col, n);
        if (links.has(ref)) setLink(ref, null);
      }
      continue;
    }
    const row = rowAt(n);
    for (const { col, idx, inSheet } of placed) {
      const cur = r.cells[col.key] ?? null;
      if (inSheet) {
        // Unchanged since import: the cell is left exactly as it is (rich text, links, format).
        if (r.orig && sameValue(r.orig[col.key] ?? null, cur)) continue;
        // A row from before Mudd kept import-time values: rewrite what it holds.
        if (!r.orig && cur === null && !cellHasValue(cellAt(row, idx))) continue;
        writeCell(row, idx, col, cur, baseStyle(row, idx));
      } else if (cur !== null) {
        writeCell(row, idx, col, cur, appendedStyle(row, col));
      }
    }
  }

  // ----- new prospects -----
  const start = meta.lastDataRow + 1;
  let shifted: { from: number; by: number } | null = null;
  if (fresh.length && meta.trailer) {
    // The footnote (and the blank row above it) moves down to make room.
    shifted = { from: start, by: fresh.length };
    const moving = [...byNum.values()].filter((r) => r.num >= start).sort((a, b) => b.num - a.num);
    for (const r of moving) byNum.delete(r.num);
    for (const r of moving) {
      renumberRow(r, r.num + fresh.length);
      byNum.set(r.num, r);
    }
    for (const [ref, xml] of [...links]) {
      const rg = parseRange(ref);
      if (!rg || rg.r1 < start) continue;
      links.delete(ref);
      const moved = rangeText({ ...rg, r1: rg.r1 + fresh.length, r2: rg.r2 + fresh.length });
      links.set(moved, withStart(xml, (t) => setAttr(t, "ref", moved)));
      linksChanged = true;
    }
  }
  fresh.forEach((r, i) => {
    const row = rowAt(start + i);
    for (const { col, idx, inSheet } of placed) {
      const cur = r.cells[col.key] ?? null;
      if (cur === null) continue;
      writeCell(row, idx, col, cur, inSheet ? baseStyle(row, idx) : appendedStyle(row, col));
    }
  });
  const lastRow = Math.max(meta.lastDataRow, start + fresh.length - 1);

  doc.rows = [...byNum.values()].sort((a, b) => a.num - b.num);
  let xml = serializeSheet(doc);

  // ----- the blocks around the data -----
  const maxRow = doc.rows.at(-1)?.num ?? lastRow;
  const dim = findBlock(xml, "dimension", p);
  if (dim) {
    const rg = parseRange(getAttr(dim.text, "ref") ?? "");
    const ref = rangeText({ c1: 1, r1: 1, c2: Math.max(rg?.c2 ?? 1, lastCol), r2: Math.max(rg?.r2 ?? 1, maxRow) });
    xml = replaceAt(xml, dim, withStart(dim.text, (t) => setAttr(t, "ref", ref)));
  }

  xml = addColWidths(xml, p, appended.map((a) => ({ index: a.idx, width: pxToChars(a.col.width, a.col.type) })));

  let filter: Range | null = null;
  const af = findBlock(xml, "autoFilter", p);
  if (af) {
    const rg = parseRange(getAttr(startTag(af.text), "ref") ?? "");
    if (rg && rg.r1 === 1) {
      const next: Range = { ...rg, c2: Math.max(rg.c2, lastCol), r2: Math.max(rg.r2, lastRow) };
      if (next.c2 !== rg.c2 || next.r2 !== rg.r2) {
        xml = replaceAt(xml, af, withStart(af.text, (t) => setAttr(t, "ref", rangeText(next))));
        filter = next;
      }
    }
  }

  if (shifted) {
    const merges = findBlock(xml, "mergeCells", p);
    if (merges) {
      const moved = merges.text.replace(/<(?:[\w.-]+:)?mergeCell\b[^>]*>/g, (tag) => {
        const rg = parseRange(getAttr(tag, "ref") ?? "");
        if (!rg || rg.r1 < shifted!.from) return tag;
        return setAttr(tag, "ref", rangeText({ ...rg, r1: rg.r1 + shifted!.by, r2: rg.r2 + shifted!.by }));
      });
      xml = replaceAt(xml, merges, moved);
    }
  }

  const newRels: Rel[] = [];
  if (linksChanged) {
    const ns = relsPrefix(xml, "worksheet");
    xml = ns.xml;
    const nextId = relIds(rels.map((r) => r.id));
    const pieces = [...links.values()];
    for (const [ref, url] of newLinks) {
      const id = nextId();
      newRels.push({ id, type: REL_TYPE.hyperlink, target: url, external: true });
      pieces.push(`<${p}hyperlink ref="${ref}" ${ns.prefix}:id="${id}"/>`);
    }
    const cur = findBlock(xml, "hyperlinks", p);
    const block = pieces.length ? `<${p}hyperlinks>${pieces.join("")}</${p}hyperlinks>` : "";
    xml = cur ? replaceAt(xml, cur, block) : block ? insertBefore(xml, block, followersOf("hyperlinks"), p, "worksheet") : xml;
  }

  xml = syncDropdowns(xml, p, placed, lastRow);
  zip.file(part.path, xml);
  if (newRels.length) zip.file(relsPath, addRels(relsXml, newRels));

  await patchTables(zip, part, rels, meta, placed, appended, lastCol, lastRow);
  return { headerStyle, filter };
}

/** Add <col> widths for appended columns, splitting any original span they land inside. */
function addColWidths(xml: string, p: string, added: { index: number; width: number }[]): string {
  if (!added.length) return xml;
  const cols = findBlock(xml, "cols", p);
  const inner = cols && startTag(cols.text) !== cols.text
    ? cols.text.slice(startTag(cols.text).length, cols.text.lastIndexOf("<"))
    : "";
  const cuts = added.map((c) => c.index).sort((a, b) => a - b);
  const spans: { min: number; tag: string }[] = [];
  const span = (tag: string, min: number, max: number) => ({ min, tag: setAttr(setAttr(tag, "min", String(min)), "max", String(max)) });
  for (const m of inner.matchAll(/<(?:[\w.-]+:)?col\b[^>]*\/>/g)) {
    const tag = m[0];
    const min = Number(getAttr(tag, "min") ?? 0);
    const max = Number(getAttr(tag, "max") ?? 0);
    // Excel wants spans sorted and disjoint; a sheet may style empty columns past its data
    // (T:Z as one span), and appended columns land inside such a span: split it around them.
    let from = min;
    for (const cut of cuts) {
      if (cut < min || cut > max) continue;
      if (cut > from) spans.push(span(tag, from, cut - 1));
      from = cut + 1;
    }
    if (from === min) spans.push({ min, tag });
    else if (from <= max) spans.push(span(tag, from, max));
  }
  for (const c of added) spans.push({ min: c.index, tag: `<${p}col min="${c.index}" max="${c.index}" width="${c.width}" customWidth="1"/>` });
  spans.sort((a, b) => a.min - b.min);
  const block = `<${p}cols>${spans.map((s) => s.tag).join("")}</${p}cols>`;
  return cols ? replaceAt(xml, cols, block) : insertBefore(xml, block, followersOf("cols"), p, "worksheet");
}

/**
 * Dropdowns follow the app's options: a typed list the sheet already has for a column is updated
 * when its options changed, and a Dropdown column without one (new, or retyped) gets one. A list
 * drawn from a range or a name is the sheet's own, and is left alone.
 */
function syncDropdowns(xml: string, p: string, placed: { col: Column; idx: number }[], lastRow: number): string {
  const selects = placed.filter((x) => x.col.type === "select" && x.col.options?.length);
  if (!selects.length) return xml;
  const block = findBlock(xml, "dataValidations", p);
  const items = block
    ? [...block.text.matchAll(/<((?:[\w.-]+:)?)dataValidation\b[^>]*?(?:\/>|>[\s\S]*?<\/\1dataValidation>)/g)].map((m) => m[0])
    : [];
  const all = parseListValidations(xml); // includes the Excel 2010 lists kept in extLst
  let changed = false;
  for (const { col, idx } of selects) {
    const formula = listFormula(col.options!);
    if (formula.length > LIST_FORMULA_MAX) continue;
    const covers = (sqref: string) => rangesOf(sqref).some((rg) => rg.c1 <= idx && idx <= rg.c2 && rg.r2 >= 2);
    const i = items.findIndex((it) => getAttr(startTag(it), "type") === "list" && covers(getAttr(startTag(it), "sqref") ?? ""));
    if (i >= 0) {
      const f = /<((?:[\w.-]+:)?)formula1>([\s\S]*?)<\/\1formula1>/.exec(items[i]!);
      const opts = f ? inlineListOptions(decodeXml(f[2]!)) : null;
      if (!f || !opts || sameList(opts, col.options!)) continue;
      items[i] = items[i]!.replace(f[0], `<${f[1]}formula1>${escapeXml(formula)}</${f[1]}formula1>`);
      changed = true;
    } else if (!all.some((v) => covers(v.sqref))) {
      const L = colLetter(idx);
      items.push(
        `<${p}dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${L}2:${L}${Math.max(VALIDATION_ROWS, lastRow)}"><${p}formula1>${escapeXml(formula)}</${p}formula1></${p}dataValidation>`,
      );
      changed = true;
    }
  }
  if (!changed) return xml;
  const next = `<${p}dataValidations count="${items.length}">${items.join("")}</${p}dataValidations>`;
  return block ? replaceAt(xml, block, next) : insertBefore(xml, next, followersOf("dataValidations"), p, "worksheet");
}

/**
 * An Excel Table over the prospects keeps covering them: it grows over new rows and over the
 * appended columns next to it, and a renamed header renames its table column (Excel repairs a
 * table whose column names don't match the header cells).
 */
async function patchTables(
  zip: JSZip,
  part: SheetPart,
  rels: Rel[],
  meta: SheetMeta,
  placed: { col: Column; idx: number; inSheet: boolean }[],
  appended: { col: Column; idx: number }[],
  lastCol: number,
  lastRow: number,
): Promise<void> {
  for (const rel of rels.filter((r) => r.type.endsWith("/table"))) {
    const path = resolvePart(part.path, rel.target);
    let xml = await readText(zip, path);
    if (!xml) continue;
    const root = /<((?:[\w.-]+:)?)table\b[^>]*>/.exec(xml);
    if (!root) continue;
    const tp = root[1]!;
    const rg = parseRange(getAttr(root[0], "ref") ?? "");
    if (!rg || rg.r1 !== 1 || Number(getAttr(root[0], "totalsRowCount") ?? 0) > 0) continue;
    const colsBlock = findBlock(xml, "tableColumns", tp);
    if (!colsBlock) continue;
    const cols = [...colsBlock.text.matchAll(/<((?:[\w.-]+:)?)tableColumn\b[^>]*?(?:\/>|>[\s\S]*?<\/\1tableColumn>)/g)].map((m) => m[0]);
    const next: Range = { ...rg };
    let changed = false;
    if (lastRow > rg.r2 && rg.r2 >= meta.lastDataRow) {
      next.r2 = lastRow;
      changed = true;
    }
    for (const { col, idx, inSheet } of placed) {
      if (!inSheet || idx < rg.c1 || idx > rg.c2 || col.importedHeader === undefined || col.header === col.importedHeader) continue;
      const i = idx - rg.c1;
      if (cols[i]) {
        cols[i] = withStart(cols[i]!, (t) => setAttr(t, "name", col.header));
        changed = true;
      }
    }
    if (rg.c2 === meta.lastCol && appended.length) {
      let id = Math.max(0, ...cols.map((c) => Number(getAttr(startTag(c), "id")) || 0));
      for (const a of appended) cols.push(`<${tp}tableColumn id="${++id}" name="${escapeXml(a.col.header)}"/>`);
      next.c2 = lastCol;
      changed = true;
    }
    if (!changed) continue;
    xml = xml.replace(root[0], setAttr(root[0], "ref", rangeText(next)));
    const af = findBlock(xml, "autoFilter", tp);
    if (af) xml = replaceAt(xml, af, withStart(af.text, (t) => setAttr(t, "ref", rangeText(next))));
    const cb = findBlock(xml, "tableColumns", tp)!;
    xml = replaceAt(xml, cb, `${setAttr(startTag(cb.text), "count", String(cols.length))}${cols.join("")}</${tp}tableColumns>`);
    zip.file(path, xml);
  }
}

/** The autofilter's hidden defined name must describe the same range. */
function setFilterName(wbXml: string, part: SheetPart, rg: Range): string {
  const abs = `$${colLetter(rg.c1)}$${rg.r1}:$${colLetter(rg.c2)}$${rg.r2}`;
  return wbXml.replace(/<((?:[\w.-]+:)?)definedName\b([^>]*)>([\s\S]*?)<\/\1definedName>/g, (m, pfx: string, attrs: string) => {
    const tag = `<x${attrs}>`;
    if (getAttr(tag, "name") !== "_xlnm._FilterDatabase" || getAttr(tag, "localSheetId") !== String(part.index)) return m;
    return `<${pfx}definedName${attrs}>${escapeXml(`${sheetRefName(part.name)}!${abs}`)}</${pfx}definedName>`;
  });
}

/** Excel recalculates on open, so other tabs' formulas see the new values. */
function forceRecalc(wbXml: string): string {
  const calc = /<((?:[\w.-]+:)?)calcPr\b[^>]*?\/?>/.exec(wbXml);
  if (calc) return wbXml.replace(calc[0], setAttr(calc[0], "fullCalcOnLoad", "1"));
  const p = /<((?:[\w.-]+:)?)workbook\b/.exec(wbXml)?.[1] ?? "";
  const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
  return insertBefore(wbXml, `<${p}calcPr fullCalcOnLoad="1"/>`, after, p, "workbook");
}

// ---------- the Intro templates tab ----------

async function writeTemplatesTab(
  zip: JSZip,
  wbPath: string,
  wbXml: string,
  parts: SheetPart[],
  sheets: SheetMeta[],
  templates: Template[],
  book: StyleBook,
  headerStyle: string | null,
): Promise<string> {
  const meta = sheets.find((s) => s.role === "templates");
  const part = meta ? parts.find((x) => x.name === meta.name) : undefined;
  if (meta && part) {
    // The tab Mudd read the templates from: rewrite its Name and Template cells, row by row.
    const doc: SheetDoc = parseSheet((await readText(zip, part.path))!);
    const p = doc.prefix;
    const byNum = new Map(doc.rows.map((r) => [r.num, r]));
    const typical = typicalStyles(doc.rows, 2, Math.max(2, meta.lastDataRow));
    // Only a cell the tab has no format for yet needs a new (wrapped) one.
    let wrap: string | null | undefined;
    const wrapped = () => (wrap === undefined ? (wrap = book.derive(typical.get(meta.colMap.body!) ?? null, { wrap: true })) : wrap);
    const last = Math.max(meta.lastDataRow, templates.length + 1);
    for (let n = 2; n <= last; n++) {
      const t = templates[n - 2];
      let row = byNum.get(n);
      if (!row && !t) continue;
      if (!row) byNum.set(n, (row = { num: n, attrs: "", cells: [], extra: "", raw: null }));
      for (const [key, value] of [["name", t?.name], ["body", t?.body]] as const) {
        const idx = meta.colMap[key];
        if (!idx) continue;
        const cell = row.cells.find((c) => c.col === idx);
        const style = cell ? cellStyle(cell) : typical.get(idx) ?? wrapped();
        putCell(row, idx, makeCell(p, idx, n, style, value ? { s: value } : null));
      }
    }
    doc.rows = [...byNum.values()].sort((a, b) => a.num - b.num);
    let xml = serializeSheet(doc);
    const dim = findBlock(xml, "dimension", p);
    if (dim) {
      const rg = parseRange(getAttr(dim.text, "ref") ?? "");
      const ref = rangeText({ c1: 1, r1: 1, c2: Math.max(rg?.c2 ?? 2, 2), r2: Math.max(rg?.r2 ?? 1, last) });
      xml = replaceAt(xml, dim, withStart(dim.text, (t) => setAttr(t, "ref", ref)));
    }
    zip.file(part.path, xml);
    return wbXml;
  }
  if (!templates.length) return wbXml;

  const wrap = book.derive(null, { wrap: true });
  const cell = (col: number, row: number, style: string | null, text: string) => makeCell("", col, row, style, { s: text });
  const rows = [
    `<row r="1" ht="21.75" customHeight="1">${cell(1, 1, headerStyle, "Name")}${cell(2, 1, headerStyle, "Template")}</row>`,
    ...templates.map((t, i) => `<row r="${i + 2}">${cell(1, i + 2, wrap, t.name)}${cell(2, i + 2, wrap, t.body)}</row>`),
  ];
  const cols = '<cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="100" customWidth="1"/></cols>';
  return (await appendSheet(zip, wbPath, wbXml, parts, TEMPLATES_SHEET, `A1:B${templates.length + 1}`, cols, rows.join(""))).wbXml;
}

// ---------- the ICP thesis tab ----------

/**
 * The thesis tab (Question | Answer | Filled by): the one import read the thesis from, rewritten
 * row by row, or a new one when the campaign has a thesis with at least one answer.
 */
async function writeThesisTab(
  zip: JSZip,
  wbPath: string,
  wbXml: string,
  parts: SheetPart[],
  sheets: SheetMeta[],
  thesis: Thesis | null,
  book: StyleBook,
  headerStyle: string | null,
): Promise<string> {
  const meta = sheets.find((s) => s.role === "thesis");
  const part = meta ? parts.find((x) => x.name === meta.name) : undefined;
  const lines = thesis ? thesisRows(thesis) : [];
  if (meta && part) {
    const doc: SheetDoc = parseSheet((await readText(zip, part.path))!);
    const p = doc.prefix;
    const byNum = new Map(doc.rows.map((r) => [r.num, r]));
    const typical = typicalStyles(doc.rows, 2, Math.max(2, meta.lastDataRow));
    let wrap: string | null | undefined;
    const wrapped = () => (wrap === undefined ? (wrap = book.derive(typical.get(meta.colMap.answer!) ?? null, { wrap: true })) : wrap);
    const last = Math.max(meta.lastDataRow, lines.length + 1);
    for (let n = 2; n <= last; n++) {
      const line = lines[n - 2];
      let row = byNum.get(n);
      if (!row && !line) continue;
      if (!row) byNum.set(n, (row = { num: n, attrs: "", cells: [], extra: "", raw: null }));
      for (const [key, value] of [["question", line?.question], ["answer", line?.answer], ["filledBy", line?.filledBy]] as const) {
        const idx = meta.colMap[key];
        if (!idx) continue;
        const cell = row.cells.find((c) => c.col === idx);
        const style = cell ? cellStyle(cell) : typical.get(idx) ?? wrapped();
        putCell(row, idx, makeCell(p, idx, n, style, value ? { s: value } : null));
      }
    }
    doc.rows = [...byNum.values()].sort((a, b) => a.num - b.num);
    let xml = serializeSheet(doc);
    const dim = findBlock(xml, "dimension", p);
    if (dim) {
      const rg = parseRange(getAttr(dim.text, "ref") ?? "");
      const ref = rangeText({ c1: 1, r1: 1, c2: Math.max(rg?.c2 ?? 3, 3), r2: Math.max(rg?.r2 ?? 1, last) });
      xml = replaceAt(xml, dim, withStart(dim.text, (t) => setAttr(t, "ref", ref)));
    }
    zip.file(part.path, xml);
    return wbXml;
  }
  if (!hasAnswers(thesis)) return wbXml;

  const wrap = book.derive(null, { wrap: true });
  const cell = (col: number, row: number, style: string | null, text: string) => makeCell("", col, row, style, text ? { s: text } : null);
  const rows = [
    `<row r="1" ht="21.75" customHeight="1">${cell(1, 1, headerStyle, "Question")}${cell(2, 1, headerStyle, "Answer")}${cell(3, 1, headerStyle, "Filled by")}</row>`,
    ...lines.map((l, i) => `<row r="${i + 2}">${cell(1, i + 2, wrap, l.question)}${cell(2, i + 2, wrap, l.answer)}${cell(3, i + 2, wrap, l.filledBy)}</row>`),
  ];
  const cols = '<cols><col min="1" max="1" width="40" customWidth="1"/><col min="2" max="2" width="100" customWidth="1"/><col min="3" max="3" width="14" customWidth="1"/></cols>';
  return (await appendSheet(zip, wbPath, wbXml, parts, THESIS_SHEET, `A1:C${lines.length + 1}`, cols, rows.join(""))).wbXml;
}

// ---------- the Contacts tab ----------

/**
 * The Contacts tab: the one import read the people from, patched in place like the Prospects
 * tab, or, when the workbook has none yet and there are people, a new one.
 */
async function writeContactsTab(
  zip: JSZip,
  wbPath: string,
  wbXml: string,
  parts: SheetPart[],
  campaign: Campaign,
  contacts: ExportRow[],
  book: StyleBook,
  date1904: boolean,
  headerStyle: string | null,
): Promise<string> {
  const schema = contactsTabSchema(campaign.schema);
  const meta = campaign.sheets.find((s) => s.role === "contacts");
  const part = meta ? parts.find((x) => x.name === meta.name) : undefined;
  if (meta && part) {
    const res = await patchSheet(zip, part, meta, schema, contacts, book, date1904);
    return res.filter ? setFilterName(wbXml, part, res.filter) : wbXml;
  }
  if (!contacts.length) return wbXml;
  // An empty tab with the header cells styled; patchSheet then writes every column as one the
  // sheet lacks, which also gives each its width, number format and dropdown.
  const header = `<row r="1" ht="21.75" customHeight="1">${schema.columns.map((c, i) => makeCell("", i + 1, 1, headerStyle, { s: c.header })).join("")}</row>`;
  const added = await appendSheet(zip, wbPath, wbXml, parts, CONTACTS_SHEET, `A1:${colLetter(schema.columns.length)}1`, "", header);
  await patchSheet(zip, added.part, { name: added.part.name, role: "contacts", colMap: {}, lastDataRow: 1, lastCol: 0, dataRows: [] }, schema, contacts, book, date1904);
  return added.wbXml;
}

/**
 * Add a tab after the others. Its name must not clash with any tab, whatever the case (Excel's
 * rule), so "Contacts" may become "Contacts 2".
 */
async function appendSheet(
  zip: JSZip,
  wbPath: string,
  wbXml: string,
  parts: SheetPart[],
  base: string,
  dimension: string,
  cols: string,
  rowsXml: string,
): Promise<{ wbXml: string; part: SheetPart }> {
  const names = new Set(parts.map((x) => x.name.toLowerCase()));
  for (const m of wbXml.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)) names.add((getAttr(m[0], "name") ?? "").toLowerCase());
  let name = base;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  let n = parts.length + 1;
  while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
  const path = `xl/worksheets/sheet${n}.xml`;
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${RELS_NS}">` +
    `<dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${rowsXml}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
  zip.file(path, sheet);

  const wbRelsPath = relsPathOf(wbPath);
  const wbRelsXml = await readText(zip, wbRelsPath);
  const rid = relIds(parseRels(wbRelsXml).map((r) => r.id))();
  const dir = wbPath.slice(0, wbPath.lastIndexOf("/") + 1);
  const target = path.startsWith(dir) ? path.slice(dir.length) : `/${path}`;
  zip.file(wbRelsPath, addRels(wbRelsXml, [{ id: rid, type: REL_TYPE.worksheet, target, external: false }]));

  const ct = (await readText(zip, "[Content_Types].xml"))!;
  zip.file(
    "[Content_Types].xml",
    ct.replace(/<\/((?:[\w.-]+:)?)Types>/, `<$1Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></$1Types>`),
  );

  const ns = relsPrefix(wbXml, "workbook");
  const tags = [...ns.xml.matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*>/g)];
  const ids = tags.map((m) => Number(getAttr(m[0], "sheetId")) || 0);
  return {
    wbXml: ns.xml.replace(
      /<\/((?:[\w.-]+:)?)sheets>/,
      `<$1sheet name="${escapeXml(name)}" sheetId="${Math.max(0, ...ids) + 1}" ${ns.prefix}:id="${rid}"/></$1sheets>`,
    ),
    part: { name, path, index: tags.length },
  };
}

// ---------- a new workbook ----------

/** A workbook in the base-tracker look, for a campaign that has none of its own. */
async function generatedWorkbook(schema: CampaignSchema, rows: ExportRow[], templates: Template[], contacts: ExportRow[], thesis: Thesis | null): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mudd";
  const sheet = (name: string, tabSchema: CampaignSchema, list: ExportRow[]) => {
    const ws = wb.addWorksheet(name);
    const cols = tabSchema.columns;
    styleGeneratedSheet(ws, cols, tabSchema);
    const styles = cols.map((c) => dataStyle(c, tabSchema));
    list.forEach((r, i) => {
      const xrow = ws.getRow(i + 2);
      cols.forEach((col, j) => {
        const cell = xrow.getCell(j + 1);
        cell.style = JSON.parse(JSON.stringify(styles[j]));
        cell.value = toExcelValue(r.cells[col.key] ?? null, col);
      });
    });
    ws.autoFilter = `A1:${colLetter(Math.max(1, cols.length))}${Math.max(1, list.length + 1)}`;
  };
  sheet("Prospects", schema, rows);
  sheet(CONTACTS_SHEET, contactsTabSchema(schema), contacts);
  if (templates.length) {
    const t = wb.addWorksheet(TEMPLATES_SHEET);
    t.getColumn(1).width = 28;
    t.getColumn(2).width = 100;
    const h = t.getRow(1);
    h.height = 21.75;
    ["Name", "Template"].forEach((text, i) => {
      h.getCell(i + 1).value = text;
      h.getCell(i + 1).style = JSON.parse(JSON.stringify(STYLE.header));
    });
    templates.forEach((tpl, i) => {
      const row = t.getRow(i + 2);
      row.getCell(1).value = tpl.name;
      row.getCell(2).value = tpl.body;
      for (const c of [1, 2]) row.getCell(c).style = { ...JSON.parse(JSON.stringify(STYLE.cell)), alignment: { vertical: "top", wrapText: true } };
    });
  }
  if (hasAnswers(thesis)) {
    const t = wb.addWorksheet(THESIS_SHEET);
    [40, 100, 14].forEach((w, i) => (t.getColumn(i + 1).width = w));
    const h = t.getRow(1);
    h.height = 21.75;
    ["Question", "Answer", "Filled by"].forEach((text, i) => {
      h.getCell(i + 1).value = text;
      h.getCell(i + 1).style = JSON.parse(JSON.stringify(STYLE.header));
    });
    thesisRows(thesis).forEach((line, i) => {
      const row = t.getRow(i + 2);
      [line.question, line.answer, line.filledBy].forEach((v, j) => {
        row.getCell(j + 1).value = v || null;
        row.getCell(j + 1).style = { ...JSON.parse(JSON.stringify(STYLE.cell)), alignment: { vertical: "top", wrapText: true } };
      });
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
