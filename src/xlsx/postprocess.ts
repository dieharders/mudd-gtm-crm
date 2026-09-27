/**
 * Put back the two sheet-XML blocks ExcelJS rewrites wrongly.
 *
 *   <cols>             ExcelJS drops a column width that equals its own default (9), so
 *                      base-tracker's column A came back 13 wide.
 *   <dataValidations>  ExcelJS expands every validation to one entry per cell and squeezes them
 *                      back with a string sort, so "I2:I1000" returns as the overlapping pair
 *                      "I2:I1000" + "I10:I1000".
 *
 * Both are safe to restore verbatim BECAUSE export never moves an existing column: the original
 * blocks describe exactly the same letters. Columns export appended are added after them.
 */
import JSZip from "jszip";

export interface SheetPatch {
  sheet: string;
  newCols: { index: number; width: number }[];
  newValidations: { sqref: string; formula: string }[];
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Sheet name → its XML path inside the package, from workbook.xml and its rels. */
async function sheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const wbXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) {
      const t = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      rels.set(id, t);
    }
  }
  const out = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? /\bid="([^"]+)"/.exec(m[0])?.[1];
    if (name && rid && rels.has(rid)) out.set(decode(name), rels.get(rid)!);
  }
  return out;
}

const block = (xml: string, tag: string) => {
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`);
  const m = re.exec(xml);
  return m ? { text: m[0], index: m.index } : null;
};

// Element order inside <worksheet> (ECMA-376 CT_Worksheet), for inserting a block that the
// output lacks: it must go before the first element that follows it in this list.
const AFTER_COLS = ["sheetData"];
const AFTER_DV = [
  "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks",
  "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing",
  "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
];

function insertBefore(xml: string, piece: string, followers: string[]): string {
  for (const tag of followers) {
    const i = xml.search(new RegExp(`<${tag}\\b`));
    if (i >= 0) return xml.slice(0, i) + piece + xml.slice(i);
  }
  const end = xml.lastIndexOf("</worksheet>");
  return xml.slice(0, end) + piece + xml.slice(end);
}

function patchSheet(out: string, orig: string, patch: SheetPatch | undefined): string {
  // <cols>
  const origCols = block(orig, "cols");
  if (origCols || patch?.newCols.length) {
    const inner = origCols ? origCols.text.replace(/^<cols\b[^>]*?>|<\/cols>$/g, "").replace(/^<cols\b[^>]*\/>$/, "") : "";
    // Excel requires <col> spans in ascending order and non-overlapping. An original sheet may
    // declare widths for EMPTY columns past its data (Aggregators styles T:Z as one span), and
    // appended columns land inside such a span — so split every original span around them.
    const appended = new Set((patch?.newCols ?? []).map((c) => c.index));
    const spans: { min: number; tag: string }[] = [];
    for (const m of inner.matchAll(/<col\b[^>]*\/>/g)) {
      const tag = m[0];
      const min = +(/\bmin="(\d+)"/.exec(tag)?.[1] ?? 0);
      const max = +(/\bmax="(\d+)"/.exec(tag)?.[1] ?? 0);
      let start = min;
      for (let i = min; i <= max + 1; i++) {
        if (i === max + 1 || appended.has(i)) {
          if (i > start) {
            spans.push({ min: start, tag: tag.replace(/\bmin="\d+"/, `min="${start}"`).replace(/\bmax="\d+"/, `max="${i - 1}"`) });
          }
          start = i + 1;
        }
      }
    }
    for (const c of patch?.newCols ?? []) {
      spans.push({ min: c.index, tag: `<col min="${c.index}" max="${c.index}" width="${c.width}" customWidth="1"/>` });
    }
    spans.sort((a, b) => a.min - b.min);
    const replacement = `<cols>${spans.map((s) => s.tag).join("")}</cols>`;
    const cur = block(out, "cols");
    out = cur ? out.slice(0, cur.index) + replacement + out.slice(cur.index + cur.text.length) : insertBefore(out, replacement, AFTER_COLS);
  }

  // <dataValidations>
  const origDv = block(orig, "dataValidations");
  const extra = (patch?.newValidations ?? [])
    .map((v) => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${v.sqref}"><formula1>${escapeXml(v.formula)}</formula1></dataValidation>`)
    .join("");
  const cur = block(out, "dataValidations");
  if (origDv || extra) {
    const inner = origDv ? origDv.text.replace(/^<dataValidations\b[^>]*?>|<\/dataValidations>$/g, "").replace(/^<dataValidations\b[^>]*\/>$/, "") : "";
    const all = inner + extra;
    const count = (all.match(/<dataValidation\b/g) ?? []).length;
    const replacement = `<dataValidations count="${count}">${all}</dataValidations>`;
    out = cur ? out.slice(0, cur.index) + replacement + out.slice(cur.index + cur.text.length) : insertBefore(out, replacement, AFTER_DV);
  } else if (cur) {
    out = out.slice(0, cur.index) + out.slice(cur.index + cur.text.length);
  }
  return out;
}

export async function restoreSheetXml(output: Uint8Array, original: Uint8Array, patches: SheetPatch[]): Promise<Uint8Array> {
  const outZip = await JSZip.loadAsync(output);
  const origZip = await JSZip.loadAsync(original);
  const outPaths = await sheetPaths(outZip);
  const origPaths = await sheetPaths(origZip);
  const byName = new Map(patches.map((p) => [p.sheet, p]));

  for (const [name, origPath] of origPaths) {
    const outPath = outPaths.get(name);
    if (!outPath) continue;
    const orig = await origZip.file(origPath)?.async("string");
    const out = await outZip.file(outPath)?.async("string");
    if (!orig || !out) continue;
    outZip.file(outPath, patchSheet(out, orig, byName.get(name)));
  }
  return outZip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
