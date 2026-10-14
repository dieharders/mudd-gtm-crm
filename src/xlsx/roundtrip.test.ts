/**
 * Import → edit → Save file → re-import, against workbooks built here with the features real
 * trackers have (formulas on another tab, column formats, notes, merges, dropdowns, tables,
 * SharePoint parts), and against a whole made-up tracker, fixtures/base-tracker.generated.xlsx,
 * which `bun run fixture` rebuilds from scripts/make-fixture.ts.
 */
import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import { allColumns, discoverySchema, genericSchema } from "../shared/schema";
import { CHECKED, DEAD, isScreened, STAGES, type Campaign, type Template, type Thesis, type ThesisId } from "../shared/types";
import { exportCampaign, type ExportRow } from "./export";
import { importWorkbook, inspectWorkbook, loadWorkbook } from "./import";
import { YOURS_FILL } from "./layouts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "base-tracker.generated.xlsx");

// ---------- helpers (independent of the code under test) ----------

async function xlsxOf(build: (wb: ExcelJS.Workbook) => void, patch?: (zip: JSZip) => Promise<void>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  let buf: Uint8Array = new Uint8Array(await wb.xlsx.writeBuffer());
  if (patch) {
    const zip = await JSZip.loadAsync(buf);
    await patch(zip);
    buf = await zip.generateAsync({ type: "uint8array" });
  }
  return buf;
}

async function importFrom(buf: Uint8Array, name = "t.xlsx", prospects?: string) {
  const book = await loadWorkbook(buf, name);
  const inspected = inspectWorkbook(book);
  const p = prospects ?? inspected.sheets.find((s) => s.guess === "prospects")!.name;
  const imp = importWorkbook(book, { prospects: p });
  const rows: ExportRow[] = imp.rows.map((r, i) => ({ ...r, id: `r${i}` }));
  const contacts: ExportRow[] = imp.contacts.map(({ parent, ...c }, i) => ({ ...c, id: `k${i}`, parentId: rows[parent]!.id }));
  const campaign: Campaign = {
    id: "c1", name: "test", createdAt: 0, updatedAt: 0, sourceName: name, sourcePath: null,
    hasOriginal: true, schema: imp.schema, sheets: imp.sheets,
  };
  // The prospect's columns first, then its contacts'.
  const key = (header: string) => allColumns(imp.schema).find((c) => c.header === header)!.key;
  return { campaign, rows, contacts, skipped: imp.skippedContacts, mismatched: imp.mismatchedContacts, templates: imp.templates, inspected, key, imported: imp };
}

/** Every part of a package, as text. */
async function partsOf(buf: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files)) if (!zip.files[name]!.dir) out.set(name, await zip.file(name)!.async("string"));
  return out;
}

/** A tab's sheet XML, found through workbook.xml and its rels. */
async function sheetXml(buf: Uint8Array, tab: string): Promise<string> {
  const parts = await partsOf(buf);
  const wb = parts.get("xl/workbook.xml")!;
  const rels = parts.get("xl/_rels/workbook.xml.rels")!;
  const esc = tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&amp;");
  const rid = new RegExp(`<sheet\\b[^>]*name="${esc}"[^>]*r:id="([^"]+)"`).exec(wb)![1];
  const t = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"|<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)!;
  const target = (t[1] ?? t[2])!.replace(/^\/?(xl\/)?/, "");
  return parts.get(`xl/${target}`)!;
}

const cellXml = (xml: string, ref: string) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml)?.[0] ?? null;
const rowXml = (xml: string, n: number) => new RegExp(`<row r="${n}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`).exec(xml)?.[0] ?? null;

async function read(buf: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** Tags balance and nest: the parts Mudd writes are well-formed XML. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, "").matchAll(/<(\/?)([\w.:-]+)([^>]*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

const tpl = (name: string, body: string, i: number): Template => ({ id: `t${i}`, campaignId: "c1", name, body, position: i, updatedAt: 0 });
const thesisOf = (answers: Partial<Record<ThesisId, string>>, drafted: ThesisId[] = []): Thesis => ({ campaignId: "c1", answers, drafted, updatedAt: 0 });

/** A small tracker: Prospects (formatted, a note, a link, rich text, IDs), Summary with formulas. */
function tracker(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["Company", "Name", "Status", "Last touch", "Score", "Website", "Notes", "ID"]);
  ws.addRow(["Acme", "Ann Lee", "Contacted", new Date(Date.UTC(2026, 6, 15, 14, 30)), 4.5, { text: "acme.com", hyperlink: "https://acme.com" }, "Warm", "P-001"]);
  ws.addRow(["Beta", "Bo Chen", "Not contacted", new Date(Date.UTC(2026, 6, 16, 9, 0)), 3.25, "beta.io", { richText: [{ text: "Bold ", font: { bold: true } }, { text: "plain" }] }, "P-002"]);
  ws.addRow(["Gamma", "Cy Dee", "Replied", new Date(Date.UTC(2026, 6, 17, 10, 15)), 4.75, "gamma.org", "Hot", "P-003"]);
  ws.getColumn(4).numFmt = "d mmm yyyy h:mm";
  ws.getColumn(4).width = 18;
  ws.getColumn(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
  ws.getCell("A4").note = "Gamma: call after 3pm";
  (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("C2:C1000", {
    type: "list", allowBlank: true, formulae: ['"Not contacted,Contacted,Replied,Dead"'],
  });
  ws.autoFilter = "A1:H4";
  const s = wb.addWorksheet("Summary");
  s.addRow(["Contacted", { formula: 'COUNTIF(Prospects!$C$2:$C$2000,"Contacted")', result: 1 }]);
  s.addRow(["Total", { formula: "COUNTA(Prospects!$A$2:$A$2000)", result: 3 }]);
}

/** SharePoint-style parts that ExcelJS alone would drop. */
async function withCustomParts(zip: JSZip) {
  zip.file("docProps/custom.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ContentTypeId"><vt:lpwstr>0x0101003044462CB29FD24EB00A734C0481B8EA</vt:lpwstr></property></Properties>');
  zip.file("customXml/item1.xml", "<root>sharepoint</root>");
  const rels = await zip.file("_rels/.rels")!.async("string");
  zip.file("_rels/.rels", rels.replace("</Relationships>", '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'));
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", ct.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
}

// ---------- saving into the imported workbook ----------

describe("Save file patches the imported workbook", () => {
  test("an unedited save changes nothing but the appended Mudd columns", async () => {
    const original = await xlsxOf(tracker, withCustomParts);
    const { campaign, rows } = await importFrom(original);
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const before = await partsOf(original);
    const after = await partsOf(out);
    const prospectsText = await sheetXml(original, "Prospects");
    const prospectsPath = [...before.entries()].find(([, t]) => t === prospectsText)![0];
    for (const [name, text] of before) {
      if (name === prospectsPath || name === "xl/workbook.xml" || name === "xl/styles.xml") continue;
      expect({ name, same: after.get(name) === text }).toEqual({ name, same: true });
    }
    // Every original cell of the prospects tab is byte-identical.
    const a = before.get(prospectsPath)!;
    const b = after.get(prospectsPath)!;
    for (const m of a.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) expect(cellXml(b, m[1]!)).toBe(m[0]);
    // The original <col> elements (with their styles) are all still there.
    for (const m of (/<cols>([\s\S]*?)<\/cols>/.exec(a)?.[1] ?? "").matchAll(/<col\b[^>]*\/>/g)) expect(b).toContain(m[0]);
    // Original cell formats are never renumbered: new ones are only appended.
    const xfs = (x: string) => /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(x)![1]!;
    expect(xfs(after.get("xl/styles.xml")!).startsWith(xfs(before.get("xl/styles.xml")!))).toBe(true);
    // Mudd's columns are appended after the last used column, headers only.
    const wb = await read(out);
    const header = (wb.getWorksheet("Prospects")!.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(["Company", "Name", "Status", "Last touch", "Score", "Website", "Notes", "ID", "Meeting URL", "Meeting at", "Screened out", "Screened reason"]);
    for (const [name, text] of after) if (name.endsWith(".xml") || name.endsWith(".rels")) expect({ name, ok: wellFormed(text) }).toEqual({ name, ok: true });
    expect(after.get("xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
  });

  test("edits rewrite only the edited cells, in their own format", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    const s = campaign.schema;
    rows[0]!.cells[key("Status")] = "Replied";
    rows[0]!.cells[key("Last touch")] = "2026-08-01T11:45";
    rows[1]!.cells[key("Score")] = 3.5;
    rows[2]!.cells[s.meetingAtKey!] = "2026-10-02T14:30";
    rows[2]!.cells[s.meetingUrlKey!] = "https://meet.google.com/abc-defg-hij";
    const before = await sheetXml(original, "Prospects");
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const after = await sheetXml(out, "Prospects");
    // Untouched cells: identical, rich text and links included.
    for (const ref of ["A2", "B2", "E2", "F2", "G2", "A3", "G3", "A4", "F4"]) expect(cellXml(after, ref)).toBe(cellXml(before, ref));
    // Edited cells keep their style.
    const s0 = (xml: string, ref: string) => /\ss="(\d+)"/.exec(cellXml(xml, ref) ?? "")?.[1];
    expect(s0(after, "C2")).toBe(s0(before, "C2"));
    expect(s0(after, "D2")).toBe(s0(before, "D2"));
    const wb = await read(out);
    const ws = wb.getWorksheet("Prospects")!;
    expect(ws.getCell("C2").value).toBe("Replied");
    expect(ws.getCell("D2").value).toEqual(new Date(Date.UTC(2026, 7, 1, 11, 45)));
    expect(ws.getCell("D2").numFmt).toBe("d mmm yyyy h:mm");
    expect(ws.getCell("E3").value).toBe(3.5);
    const at = ws.getCell(`${String.fromCharCode(64 + 10)}4`);
    expect(at.value).toEqual(new Date(Date.UTC(2026, 9, 2, 14, 30)));
    expect(at.numFmt).toMatch(/h/);
    expect((ws.getCell("I4").value as { hyperlink: string }).hyperlink).toBe("https://meet.google.com/abc-defg-hij");
    // The note is still on Gamma's row.
    expect(ws.getCell("A4").note).toBeTruthy();
  });

  test("a deleted prospect's row is blanked and nothing moves", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows } = await importFrom(original);
    const kept = rows.filter((r) => r.sourceRow !== 3); // delete Beta
    const before = await sheetXml(original, "Prospects");
    const out = await exportCampaign(campaign, original, kept, [], [], null);
    const after = await sheetXml(out, "Prospects");
    expect(rowXml(after, 2)).toBe(rowXml(before, 2));
    expect(rowXml(after, 4)).toBe(rowXml(before, 4));
    const ws = (await read(out)).getWorksheet("Prospects")!;
    expect(ws.getCell("A3").value ?? null).toBeNull();
    expect(ws.getCell("A4").value).toBe("Gamma");
    expect(ws.getCell("A3").style).toEqual((await read(original)).getWorksheet("Prospects")!.getCell("A3").style);
    // Summary's formulas are untouched and recalculated on open.
    const summary = (await read(out)).getWorksheet("Summary")!;
    expect(summary.getCell("B1").formula).toBe('COUNTIF(Prospects!$C$2:$C$2000,"Contacted")');
  });

  test("new prospects go under the data, and a footnote moves down", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Leads");
      ws.addRow(["Company", "Status"]);
      ws.addRow(["Acme", "Contacted"]);
      ws.addRow(["Beta", "Replied"]);
      ws.getCell("A5").value = "From Rob's sheet, 4 Sep";
      ws.mergeCells("A5:B5");
    });
    const { campaign, rows, key, inspected } = await importFrom(original);
    expect(inspected.sheets[0]!.rows).toBe(2);
    expect(campaign.sheets[0]!.trailer).toEqual({ from: 5, to: 5 });
    rows.push({ id: "n1", position: 10, cells: { [key("Company")]: "New Co", [key("Status")]: "Contacted" } });
    rows.push({ id: "n2", position: 11, cells: { [key("Company")]: "Newer Co" } });
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const ws = (await read(out)).getWorksheet("Leads")!;
    expect(ws.getCell("A4").value).toBe("New Co");
    expect(ws.getCell("A5").value).toBe("Newer Co");
    expect(ws.getCell("A7").value).toBe("From Rob's sheet, 4 Sep");
    expect(await sheetXml(out, "Leads")).toContain('<mergeCell ref="A7:B7"/>');
    const again = await importFrom(out);
    expect(again.rows).toHaveLength(4);
  });

  test("data in columns without a header is imported and never written over", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Company", "Contact", "Status"]);
      ws.addRow(["Acme", "Ann", "Contacted", "call back Tue"]);
      ws.addRow(["Beta", "Bo", "Replied", "VIP"]);
      (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("E2:E100", {
        type: "list", allowBlank: true, formulae: ['"Yes,No"'],
      });
    });
    const { campaign, rows } = await importFrom(original);
    expect(campaign.schema.columns.map((c) => c.header).slice(0, 4)).toEqual(["Company", "Contact", "Status", "Column D"]);
    const meta = campaign.sheets.find((s) => s.role === "prospects")!;
    expect(meta.lastCol).toBe(5); // the Yes/No dropdown on E counts as used
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const ws = (await read(out)).getWorksheet("Prospects")!;
    expect(ws.getCell("D2").value).toBe("call back Tue");
    expect(ws.getCell("F1").value).toBe("Meeting URL");
  });

  test("changing a column's type does not rewrite cells nobody edited", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    campaign.schema.columns.find((c) => c.key === key("Last touch"))!.type = "date";
    const before = await sheetXml(original, "Prospects");
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const after = await sheetXml(out, "Prospects");
    for (const ref of ["D2", "D3", "D4"]) expect(cellXml(after, ref)).toBe(cellXml(before, ref));
  });

  test("dropdown options edited in the app reach the file", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    const notes = campaign.schema.columns.find((c) => c.key === key("Notes"))!;
    notes.type = "select";
    notes.options = ["Warm", "Hot", "Cold"];
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    expect(await sheetXml(out, "Prospects")).toMatch(/sqref="G2:G1000"><formula1>&quot;Warm,Hot,Cold&quot;/);
    const again = await importFrom(out);
    expect(again.campaign.schema.columns.find((c) => c.header === "Notes")!.options).toEqual(["Warm", "Hot", "Cold"]);
  });

  test("the columns Mudd relies on are Mudd's, whatever the sheet made them", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["ID", "Company", "STATUS", "Stage", "Screened out"]);
      ws.addRow(["P-001", "Acme", "Nurture", "Early", "TRUE"]);
      ws.addRow(["P-002", "Beta", "Contacted", "Late", null]);
      ws.addRow(["P-003", "Gamma", "Contacted", "Late", "Yes - competitor"]);
      (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("C2:C1000", {
        type: "list", allowBlank: true, formulae: ['"Nurture,Contacted,Dead"'],
      });
    });
    const { campaign, rows } = await importFrom(original);
    const s = campaign.schema;
    const stages = [...STAGES, DEAD];
    expect(s.columns.find((c) => c.key === s.statusKey)).toMatchObject({ header: "Status", type: "select", options: stages });
    // Only the header Mudd writes: "Stage" is the sheet's own column.
    expect(s.columns.find((c) => c.header === "Stage")!.type).toBe("text");
    // A "Screened out" of text is the box all the same: its TRUE a tick, any other text none.
    expect(s.columns.find((c) => c.key === s.screenedKey)).toMatchObject({ header: "Screened out", type: "checkbox" });
    expect(rows.map((r) => isScreened(r, s))).toEqual([true, false, false]);
    expect(s.columns.filter((c) => c.header === "Status" || c.header === "Screened out")).toHaveLength(2);
    // The cells stay the sheet's; the dropdown is Mudd's.
    expect(rows[0]!.cells[s.statusKey!]).toBe("Nurture");
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    expect(await sheetXml(out, "Prospects")).toContain(`&quot;${stages.join(",")}&quot;`);
  });

  test("screening out is a ticked column; the prospect stays in its row", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows } = await importFrom(original);
    const s = campaign.schema;
    rows[1]!.cells[s.screenedKey!] = CHECKED;
    rows[1]!.cells[s.reasonKey!] = "Has an agency of record";
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const ws = (await read(out)).getWorksheet("Prospects")!;
    const headers = ws.getRow(1).values as unknown[];
    const col = headers.indexOf("Screened out");
    expect(ws.getRow(3).getCell(col).value).toBe(true);
    expect(ws.getRow(3).getCell(col + 1).value).toBe("Has an agency of record");
    expect(ws.getCell("A3").value).toBe("Beta");
    const again = await importFrom(out);
    const beta = again.rows.find((r) => r.sourceRow === 3)!;
    expect(isScreened(beta, again.campaign.schema)).toBe(true);
    expect(again.campaign.schema.columns.filter((c) => c.header === "Screened out")).toHaveLength(1);
  });

  test("an old Screened-out tab is never offered for import, and stays untouched", async () => {
    const original = await xlsxOf((wb) => {
      tracker(wb);
      const s = wb.addWorksheet("Screened out");
      s.addRow(["Company", "Why it fails the filter"]);
      s.addRow(["Palantir", "Too big"]);
    });
    const { campaign, rows, inspected } = await importFrom(original);
    expect(inspected.sheets.find((s) => s.name === "Screened out")!.guess).toBe("passthrough");
    expect(rows.every((r) => r.sourceSheet === "Prospects")).toBe(true);
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    expect(await sheetXml(out, "Screened out")).toBe(await sheetXml(original, "Screened out"));
  });

  test("templates: a new tab, then updated in place", async () => {
    const original = await xlsxOf(tracker);
    const first = await importFrom(original);
    const out1 = await exportCampaign(first.campaign, original, first.rows, [tpl("Warm", "Hi {{First name}},\nshort intro.", 0)], [], null);
    const again = await importFrom(out1);
    expect(again.templates).toEqual([{ name: "Warm", body: "Hi {{First name}},\nshort intro." }]);
    const out2 = await exportCampaign(again.campaign, out1, again.rows, [tpl("Cold", "Hello {{Company}}", 0), tpl("Warm", "Hi again", 1)], [], null);
    const third = await importFrom(out2);
    expect(third.templates).toEqual([{ name: "Cold", body: "Hello {{Company}}" }, { name: "Warm", body: "Hi again" }]);
    const out3 = await exportCampaign(third.campaign, out2, third.rows, [], [], null);
    expect((await read(out3)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "Intro templates"]);
    expect((await importFrom(out3)).templates).toEqual([]);
  });

  test("a user's own 'Intro Templates' tab with other headers is not taken over", async () => {
    const original = await xlsxOf((wb) => {
      tracker(wb);
      wb.addWorksheet("INTRO TEMPLATES").addRow(["Subject", "Notes"]);
    });
    const { campaign, rows } = await importFrom(original);
    const out = await exportCampaign(campaign, original, rows, [tpl("One", "Hello", 0)], [], null);
    const names = (await read(out)).worksheets.map((w) => w.name);
    expect(names).toEqual(["Prospects", "Summary", "INTRO TEMPLATES", "Intro templates 2"]);
    expect(await sheetXml(out, "INTRO TEMPLATES")).toBe(await sheetXml(original, "INTRO TEMPLATES"));
    expect((await importFrom(out)).templates).toEqual([{ name: "One", body: "Hello" }]);
  });

  test("the ICP thesis: a new tab, re-imported with its AI drafts, then patched in place", async () => {
    const original = await xlsxOf(tracker);
    const first = await importFrom(original);
    expect(first.inspected.thesis).toBe(0);
    expect(first.imported.thesis).toBeNull();
    const out1 = await exportCampaign(first.campaign, original, first.rows, [], [], thesisOf({ offer: "SOC monitoring", avatar: "Manufacturers", channels: "Association lists" }, ["channels"]));
    expect((await read(out1)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "ICP thesis"]);
    const again = await importFrom(out1);
    expect(again.inspected.thesis).toBe(3);
    expect(again.inspected.sheets.find((s) => s.name === "ICP thesis")!.guess).toBe("thesis");
    expect(again.imported.thesis).toEqual({ answers: { offer: "SOC monitoring", avatar: "Manufacturers", channels: "Association lists" }, drafted: ["channels"] });
    expect(again.campaign.sheets.find((s) => s.role === "thesis")).toMatchObject({ name: "ICP thesis", colMap: { question: 1, answer: 2, filledBy: 3 } });
    // Kept, changed, and one cleared: rewritten row by row in the same tab.
    const out2 = await exportCampaign(again.campaign, out1, again.rows, [], [], thesisOf({ offer: "SOC monitoring", avatar: "US manufacturers", channels: "Association lists" }));
    const third = await importFrom(out2);
    expect((await read(out2)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "ICP thesis"]);
    expect(third.imported.thesis).toEqual({ answers: { offer: "SOC monitoring", avatar: "US manufacturers", channels: "Association lists" }, drafted: [] });
    const ws = (await read(out2)).getWorksheet("ICP thesis")!;
    expect([ws.getCell("A1").value, ws.getCell("B1").value, ws.getCell("C1").value]).toEqual(["Question", "Answer", "Filled by"]);
    expect(ws.getCell("A2").value).toBe("What do you sell?");
    // A campaign without a thesis never gets the tab.
    const none = await exportCampaign(first.campaign, original, first.rows, [], [], null);
    expect((await read(none)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary"]);
  });

  test("a user's own 'ICP Thesis' tab with other headers is not taken over", async () => {
    const original = await xlsxOf((wb) => {
      tracker(wb);
      const mine = wb.addWorksheet("ICP THESIS");
      mine.addRow(["Topic", "Notes"]);
      mine.addRow(["Pricing", "Per site"]);
    });
    const { campaign, rows, inspected } = await importFrom(original);
    expect(inspected.thesis).toBe(0);
    expect(inspected.sheets.find((s) => s.name === "ICP THESIS")!.guess).toBe("passthrough");
    const out = await exportCampaign(campaign, original, rows, [], [], thesisOf({ offer: "SOC", avatar: "Manufacturers" }));
    expect((await read(out)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "ICP THESIS", "ICP thesis 2"]);
    expect(await sheetXml(out, "ICP THESIS")).toBe(await sheetXml(original, "ICP THESIS"));
    expect((await importFrom(out)).imported.thesis).toEqual({ answers: { offer: "SOC", avatar: "Manufacturers" }, drafted: [] });
  });

  test("an edited link cell gets a working hyperlink", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    rows[2]!.cells[key("Website")] = "https://gamma.org/about";
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const ws = (await read(out)).getWorksheet("Prospects")!;
    expect((ws.getCell("F4").value as { hyperlink: string }).hyperlink).toBe("https://gamma.org/about");
    expect((ws.getCell("F2").value as { hyperlink: string }).hyperlink).toBe("https://acme.com");
  });

  test("an Excel Table grows over new rows and appended columns", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Pipeline");
      ws.addTable({
        name: "Leads", ref: "A1", headerRow: true,
        columns: [{ name: "Company" }, { name: "Status" }],
        rows: [["Acme", "Contacted"], ["Beta", "Replied"]],
      });
    });
    const { campaign, rows, key } = await importFrom(original);
    campaign.schema.columns.find((c) => c.key === key("Status"))!.header = "Stage";
    rows.push({ id: "n", position: 9, cells: { [key("Company")]: "Gamma" } });
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const parts = await partsOf(out);
    const table = [...parts.entries()].find(([k]) => k.startsWith("xl/tables/"))![1];
    expect(table).toMatch(/ref="A1:G4"/);
    expect(table).toContain('name="Stage"');
    expect(table).toContain('name="Screened reason"');
    // The prospects had no ID column: one is added, last, with an ID for each.
    expect(table).toContain('name="ID"');
  });

  test("a tab with formulas cannot be imported", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Tracker");
      ws.addRow(["Company", "Deal", "Weighted"]);
      ws.addRow(["Acme", 10, { formula: "B2*2", result: 20 }]);
    });
    const book = await loadWorkbook(original, "t.xlsx");
    expect(inspectWorkbook(book).sheets[0]!.hasFormulas).toBe(true);
    expect(() => importWorkbook(book, { prospects: "Tracker" })).toThrow(/formulas/);
  });

  test("a date written into an unformatted cell gets a date format", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Company", "Next date"]);
      ws.addRow(["Acme", new Date(Date.UTC(2026, 0, 5))]);
      ws.getCell("B2").numFmt = "yyyy-mm-dd";
      ws.addRow(["Beta"]);
    });
    const { campaign, rows, key } = await importFrom(original);
    rows[1]!.cells[key("Next date")] = "2026-02-01";
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    const cell = (await read(out)).getWorksheet("Prospects")!.getCell("B3");
    expect(cell.value).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect(cell.numFmt).toMatch(/y/);
  });
});

// ---------- reading ----------

describe("import", () => {
  test("decimal columns are numbers, not links", async () => {
    const { campaign } = await importFrom(await xlsxOf(tracker));
    expect(campaign.schema.columns.find((c) => c.header === "Score")!.type).toBe("number");
    expect(campaign.schema.columns.find((c) => c.header === "Website")!.type).toBe("url");
  });

  test("names that look like domains are names, not links", async () => {
    const { campaign } = await importFrom(await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Organization", "Contact name", "Site"]);
      ws.addRow(["notion.so", "ann.lee", "notion.so"]);
      ws.addRow(["linear.app", "al.ng", "linear.app"]);
    }));
    const type = (h: string) => campaign.schema.columns.find((c) => c.header === h)!.type;
    expect([type("Organization"), type("Contact name"), type("Site")]).toEqual(["text", "text", "url"]);
  });

  test("dropdowns: whole columns, other tabs (x14) and named ranges", async () => {
    const original = await xlsxOf(
      (wb) => {
        const ws = wb.addWorksheet("Prospects");
        ws.addRow(["Company", "Stage", "Tier", "Region"]);
        ws.addRow(["Acme", "Warm", "1", "EU"]);
        const lists = wb.addWorksheet("Lists");
        ["Cold", "Warm", "Hot"].forEach((v, i) => (lists.getCell(i + 1, 1).value = v));
        ["EU", "US"].forEach((v, i) => (lists.getCell(i + 1, 2).value = v));
        wb.definedNames.add("Lists!$B$1:$B$2", "Regions");
      },
      async (zip) => {
        const path = "xl/worksheets/sheet1.xml";
        let xml = await zip.file(path)!.async("string");
        const dv = '<dataValidations count="2"><dataValidation type="list" allowBlank="1" sqref="C2:C1048576"><formula1>"1,2,3"</formula1></dataValidation><dataValidation type="list" allowBlank="1" sqref="D2:D100"><formula1>Regions</formula1></dataValidation></dataValidations>';
        const x14 = '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>Lists!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>B2:B500</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>';
        xml = xml.replace(/<pageMargins/, `${dv}<pageMargins`).replace("</worksheet>", `${x14}</worksheet>`);
        zip.file(path, xml);
      },
    );
    const started = performance.now();
    const { campaign, rows } = await importFrom(original, "t.xlsx", "Prospects");
    expect(performance.now() - started).toBeLessThan(5_000);
    const opts = (h: string) => campaign.schema.columns.find((c) => c.header === h)!.options;
    expect(opts("Stage")).toEqual(["Cold", "Warm", "Hot"]);
    expect(opts("Tier")).toEqual(["1", "2", "3"]);
    expect(opts("Region")).toEqual(["EU", "US"]);
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    expect(await sheetXml(out, "Prospects")).toContain("<xm:f>Lists!$A$1:$A$3</xm:f>");
  });

  test("merged cells: a merged footnote is one note, a merged label is not repeated", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Company", "Name", "Status", "Email"]);
      ws.addRow(["Acme", "Ann", "Contacted", "ann@acme.io"]);
      ws.addRow(["Beta", "Bo", "Replied"]);
      ws.getCell("B3").value = "Bo (merged)";
      ws.mergeCells("B3:C3");
      ws.getCell("A6").value = "Source: Rob's sheet";
      ws.mergeCells("A6:D6");
    });
    const { campaign, rows, key } = await importFrom(original);
    expect(rows).toHaveLength(2);
    expect(campaign.sheets[0]!.trailer).toEqual({ from: 6, to: 6 });
    expect(rows[1]!.cells[key("Status")]).toBeUndefined();
  });

  test("CSV: semicolons, UTF-16, long IDs and trailing zeros", async () => {
    const semi = await loadWorkbook(new TextEncoder().encode("Name;Company;Price\nAnn;Acme, Inc.;19.90\nBo;Beta;5\n"), "list.csv");
    const imp = importWorkbook(semi, { prospects: "Prospects" });
    expect(imp.rows[0]!.cells[imp.schema.companyKey!]).toBe("Acme, Inc.");
    expect(imp.rows[0]!.cells.price).toBe(19.9);

    const ids = await loadWorkbook(new TextEncoder().encode("Name,LinkedIn ID,Zip\nAnn,1234567890123456789,02134\n"), "ids.csv");
    const imp2 = importWorkbook(ids, { prospects: "Prospects" });
    expect(imp2.rows[0]!.cells.linkedin_id).toBe("1234567890123456789");
    expect(imp2.rows[0]!.cells.zip).toBe("02134");

    const text = "Name\tCompany\nÅsa\tMalmö AB\n";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) new DataView(utf16.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true);
    const u = importWorkbook(await loadWorkbook(utf16, "unicode.txt"), { prospects: "Prospects" });
    expect(u.rows[0]!.cells[u.schema.companyKey!]).toBe("Malmö AB");
  });

  test("a tab named History imports", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Leads");
      ws.addRow(["Company", "Status"]);
      ws.addRow(["Acme", "Contacted"]);
    }, async (zip) => {
      const xml = await zip.file("xl/workbook.xml")!.async("string");
      zip.file("xl/workbook.xml", xml.replace('name="Leads"', 'name="History"'));
    });
    const { campaign, rows } = await importFrom(original, "t.xlsx", "History");
    expect(rows).toHaveLength(1);
    const out = await exportCampaign(campaign, original, rows, [], [], null);
    expect((await partsOf(out)).get("xl/workbook.xml")).toContain('name="History"');
  });

  test("a Constructor header gets a key that cannot collide with Object's", async () => {
    const { campaign, rows } = await importFrom(await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Company", "Constructor", "Status"]);
      ws.addRow(["Acme", null, "Contacted"]);
    }));
    const col = campaign.schema.columns.find((c) => c.header === "Constructor")!;
    expect(col.key).toBe("constructor_col");
    expect(rows[0]!.cells[col.key]).toBeUndefined();
  });

  test("a label linking elsewhere imports as its link in a Link column", async () => {
    const { campaign, rows } = await importFrom(await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["Company", "LinkedIn"]);
      ws.addRow(["Acme", { text: "Profile", hyperlink: "https://linkedin.com/in/ann" }]);
    }));
    const key = campaign.schema.columns.find((c) => c.header === "LinkedIn")!.key;
    expect(rows[0]!.cells[key]).toBe("https://linkedin.com/in/ann");
  });
});

// ---------- campaigns with no workbook of their own ----------

describe("campaigns created in Mudd", () => {
  test("export in the base-tracker look, contacts on their own tab, and re-import losslessly", async () => {
    const schema = genericSchema();
    const k = (h: string) => allColumns(schema).find((c) => c.header === h)!.key;
    const rows: ExportRow[] = [
      { id: "a", position: 0, cells: { [k("ID")]: "P-001", [k("Company")]: "Acme", [k("Status")]: "Replied", [k("Meeting at")]: "2026-10-03T09:15" } },
      { id: "b", position: 1, cells: { [k("ID")]: "P-002", [k("Company")]: "Beta", [k("Status")]: "Not contacted" } },
      { id: "c", position: 2, cells: { [k("ID")]: "P-003", [k("Company")]: "Gamma", [k("Screened out")]: CHECKED, [k("Screened reason")]: "Too big" } },
    ];
    // Al first, but Ann is Acme's primary contact: she is listed first.
    const contacts: ExportRow[] = [
      { id: "x", position: 3, parentId: "a", cells: { [k("Name")]: "Al Ng", [k("Email")]: "al@acme.io" } },
      { id: "y", position: 4, parentId: "a", cells: { [k("Name")]: "Ann Lee", [k("Contact type")]: "Economic Buyer", [k("Primary")]: CHECKED, [k("Last contacted")]: "2026-09-28", [k("Last reply")]: "2026-10-01" } },
      { id: "z", position: 5, parentId: "b", cells: { [k("Name")]: "Bo Chen", [k("Email")]: "bo@beta.io", [k("Primary")]: CHECKED } },
    ];
    const campaign: Campaign = { id: "c", name: "Fresh", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema, sheets: [] };
    const out = await exportCampaign(campaign, null, rows, [tpl("One", "Hello {{Company}}", 0)], contacts, null);
    const wb = await read(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Prospects", "Contacts", "Intro templates"]);
    const ws = wb.getWorksheet("Prospects")!;
    expect(ws.getCell("A1").value).toBe("ID");
    expect(ws.getCell("B1").value).toBe("Company");
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF1C1B18" } });
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: 1 });
    const people = wb.getWorksheet("Contacts")!;
    expect((people.getRow(1).values as unknown[]).slice(1, 6)).toEqual(["Prospect ID", "Company", "Name", "Contact type", "Primary"]);
    expect([2, 3, 4].map((r) => [people.getCell(r, 1).value, people.getCell(r, 2).value, people.getCell(r, 3).value]))
      .toEqual([["P-001", "Acme", "Ann Lee"], ["P-001", "Acme", "Al Ng"], ["P-002", "Beta", "Bo Chen"]]);

    const again = await importFrom(out, "fresh.xlsx", "Prospects");
    const s2 = again.campaign.schema;
    const byCompany = (name: string) => again.rows.find((r) => r.cells[s2.companyKey!] === name)!;
    expect(byCompany("Acme").cells[s2.meetingAtKey!]).toBe("2026-10-03T09:15");
    expect(byCompany("Acme").cells[s2.statusKey!]).toBe("Replied");
    expect(isScreened(byCompany("Gamma"), s2)).toBe(true);
    expect(byCompany("Gamma").cells[s2.reasonKey!]).toBe("Too big");
    expect(s2.columns.find((c) => c.key === s2.statusKey)!.options).toContain("Dead");
    expect(again.templates).toEqual([{ name: "One", body: "Hello {{Company}}" }]);
    // The people are back with their prospects, typed and ticked as they were.
    const cs = s2.contacts!;
    const ann = again.contacts.find((c) => c.cells[cs.nameKey!] === "Ann Lee")!;
    expect(ann.parentId).toBe(byCompany("Acme").id);
    expect(ann.cells[cs.typeKey!]).toBe("Economic Buyer");
    expect(ann.cells[cs.primaryKey!]).toBe(CHECKED);
    expect([ann.cells[cs.lastContactedKey!], ann.cells[cs.lastReplyKey!]]).toEqual(["2026-09-28", "2026-10-01"]);
    expect(again.contacts.find((c) => c.cells[cs.nameKey!] === "Bo Chen")!.parentId).toBe(byCompany("Beta").id);
    expect(again.skipped).toBe(0);
  });

  test("the contacts' own record keeps the hand-kept fill", async () => {
    const schema = genericSchema();
    const k = (h: string) => allColumns(schema).find((c) => c.header === h)!.key;
    const rows: ExportRow[] = [{ id: "a", position: 0, cells: { [k("ID")]: "P-001", [k("Company")]: "Acme" } }];
    const contacts: ExportRow[] = [{ id: "x", position: 1, parentId: "a", cells: { [k("Name")]: "Al Ng" } }];
    const campaign: Campaign = { id: "c", name: "Fresh", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema, sheets: [] };
    const people = (await read(await exportCampaign(campaign, null, rows, [], contacts, null))).getWorksheet("Contacts")!;
    const fillOf = (header: string) => (people.getCell(2, (people.getRow(1).values as unknown[]).indexOf(header)).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fillOf("Primary")).toBe(YOURS_FILL);
    expect(fillOf("Last contacted")).toBe(YOURS_FILL);
    expect(fillOf("Last reply")).toBe(YOURS_FILL);
    expect(fillOf("Email")).not.toBe(YOURS_FILL);
  });

  test("a Discovery campaign's workbook carries its thesis, intel columns and the Champion type", async () => {
    const schema = discoverySchema();
    const k = (h: string) => allColumns(schema).find((c) => c.header === h)!.key;
    const rows: ExportRow[] = [{ id: "a", position: 0, cells: { [k("ID")]: "P-001", [k("Company")]: "Acme Metal", [k("Fit")]: "High", [k("Why they fit")]: "Two plants", [k("Source")]: "Discovery" } }];
    const contacts: ExportRow[] = [{ id: "x", position: 1, parentId: "a", cells: { [k("Name")]: "Ann Lee", [k("Contact type")]: "Champion", [k("Role in deal")]: "Starts it", [k("Primary")]: CHECKED } }];
    const campaign: Campaign = { id: "c", name: "Disco", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema, sheets: [] };
    const out = await exportCampaign(campaign, null, rows, [], contacts, thesisOf({ offer: "SOC", avatar: "Manufacturers", pains: "Audits" }, ["pains"]));
    const wb = await read(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Prospects", "Contacts", "ICP thesis"]);
    const t = wb.getWorksheet("ICP thesis")!;
    expect([t.getCell("A2").value, t.getCell("B2").value, t.getCell("C2").value]).toEqual(["What do you sell?", "SOC", null]);
    expect([t.getCell("A4").value, t.getCell("B4").value, t.getCell("C4").value]).toEqual(["Their pain points", "Audits", "AI draft"]);

    const again = await importFrom(out, "disco.xlsx", "Prospects");
    expect(again.imported.thesis).toEqual({ answers: { offer: "SOC", avatar: "Manufacturers", pains: "Audits" }, drafted: ["pains"] });
    const s2 = again.campaign.schema;
    expect(s2.columns.find((c) => c.header === "Fit")).toMatchObject({ type: "select", options: ["High", "Medium", "Low"] });
    expect(s2.columns.map((c) => c.header)).toEqual(expect.arrayContaining(["Why they fit", "Why now", "Budget source", "Buying clock"]));
    expect(again.rows[0]!.cells[again.key("Why they fit")]).toBe("Two plants");
    const cs = s2.contacts!;
    expect(cs.columns.map((c) => c.header)).toEqual(expect.arrayContaining(["Role in deal", "What they gain", "Angle"]));
    expect(cs.columns.find((c) => c.key === cs.typeKey)!.options).toContain("Champion");
    expect(again.contacts[0]!.cells[cs.typeKey!]).toBe("Champion");
    expect(again.contacts[0]!.cells[again.key("Role in deal")]).toBe("Starts it");
  });

  test("CSV imports gain Status, an ID and the Mudd columns", async () => {
    const csv = new TextEncoder().encode('Name,Company,Email\n"Lee, Ann",Acme,ann@acme.io\nBo,Beta,\n');
    const imp = importWorkbook(await loadWorkbook(csv, "list.csv"), { prospects: "Prospects" });
    expect(imp.rows).toHaveLength(2);
    const name = imp.schema.columns.find((c) => c.header === "Name")!.key;
    expect(imp.rows[0]!.cells[name]).toBe("Lee, Ann");
    expect(imp.rows.map((r) => r.cells[imp.schema.idKey!])).toEqual(["P-001", "P-002"]);
    expect(imp.schema.columns.map((c) => c.header)).toEqual(
      expect.arrayContaining(["Status", "Meeting URL", "Meeting at", "Screened out", "Screened reason", "ID"]),
    );
    // The intro is written to a person: it is one of the contacts' columns.
    expect(imp.schema.columns.map((c) => c.header)).not.toContain("Intro message");
    expect(imp.schema.contacts!.columns.map((c) => c.header)).toContain("Intro message");
  });

  test("Staff, Headcount or Size imports as one number column, # Employees", async () => {
    const csv = new TextEncoder().encode("Company,Staff,Headcount\nAcme,40,45\n");
    const imp = importWorkbook(await loadWorkbook(csv, "list.csv"), { prospects: "Prospects" });
    const employees = imp.schema.columns.filter((c) => c.header === "# Employees");
    expect(employees).toMatchObject([{ key: "staff", type: "number", importedHeader: "Staff" }]);
    // A second one keeps its own name: two columns can't share a header.
    expect(imp.schema.columns.find((c) => c.key === "headcount")).toMatchObject({ header: "Headcount", type: "number" });
  });
});

// ---------- the Contacts tab ----------

/** Prospects (with IDs) and a Contacts tab naming each person's prospect, as Mudd lays them out. */
function withContacts(wb: ExcelJS.Workbook, people: (string | boolean | null)[][]) {
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["ID", "Company", "Status"]);
  ws.addRow(["P-001", "Acme", "Contacted"]);
  ws.addRow(["P-002", "Beta", "Replied"]);
  const c = wb.addWorksheet("Contacts");
  c.addRow(["Prospect ID", "Company", "Name", "Contact type", "Primary", "Email", "Last contacted", "Last reply", "Intro message"]);
  for (const p of people) c.addRow(p);
  (c as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("D2:D1000", {
    type: "list", allowBlank: true, formulae: ['"Economic Buyer,Champion,Technical Buyer,End User,Influencer,Blocker,Gatekeeper,Channel"'],
  });
}

describe("the Contacts tab", () => {
  const people = [
    ["P-001", "Acme", "Ann Lee", "Economic Buyer", true, "ann@acme.io"],
    ["P-001", "Acme", "Al Ng", "End User", null, null],
    ["P-002", "Beta", "Bo Chen", null, true, "bo@beta.io"],
  ];

  test("links each person to their prospect by ID: a stale company name, a missing ID, an unknown one", async () => {
    const original = await xlsxOf((wb) => withContacts(wb, [
      ["P-001", "Acme Inc (renamed since)", "Ann Lee", "Economic Buyer", true, null],
      [null, "beta", "Bo Chen", null, null, null],
      ["P-099", "Acme", "Nobody Here", null, null, null],
    ]));
    const { campaign, rows, contacts, skipped, inspected } = await importFrom(original);
    expect(inspected.sheets.map((s) => s.guess)).toEqual(["prospects", "contacts"]);
    const cs = campaign.schema.contacts!;
    expect(contacts.map((c) => [c.cells[cs.nameKey!], c.parentId])).toEqual([["Ann Lee", rows[0]!.id], ["Bo Chen", rows[1]!.id]]);
    expect(skipped).toBe(1);
    expect(cs.columns.find((c) => c.key === cs.primaryKey)!.type).toBe("checkbox");
    expect(contacts[0]!.cells[cs.primaryKey!]).toBe(CHECKED);
    // The two link columns are the tab's, not the contacts'; the prospect's ID is hidden in the app.
    expect(cs.columns.map((c) => c.header)).toEqual(["Name", "Contact type", "Primary", "Email", "Last contacted", "Last reply", "Intro message"]);
    expect(cs.columns.find((c) => c.key === cs.lastContactedKey)).toMatchObject({ header: "Last contacted", type: "date" });
    expect(cs.columns.find((c) => c.key === cs.lastReplyKey)).toMatchObject({ header: "Last reply", type: "date" });
    expect(campaign.schema.columns.find((c) => c.key === campaign.schema.idKey)).toMatchObject({ header: "ID", hidden: true });
    const tab = campaign.sheets.find((s) => s.role === "contacts")!;
    expect(tab.dataRows).toEqual([2, 3]);
  });

  test("is never the prospects tab", async () => {
    const book = await loadWorkbook(await xlsxOf((wb) => withContacts(wb, people)), "t.xlsx");
    expect(() => importWorkbook(book, { prospects: "Contacts" })).toThrow(/Contacts tab/);
  });

  test("an unedited save leaves the Contacts tab exactly as it was", async () => {
    const original = await xlsxOf((wb) => withContacts(wb, people));
    const { campaign, rows, contacts } = await importFrom(original);
    const out = await exportCampaign(campaign, original, rows, [], contacts, null);
    expect(await sheetXml(out, "Contacts")).toBe(await sheetXml(original, "Contacts"));
    expect((await read(out)).getWorksheet("Prospects")!.getCell("A3").value).toBe("P-002");
  });

  test("a save patches it in place: one edited cell, a renamed company, a deleted and a new contact, the skipped row untouched", async () => {
    const original = await xlsxOf((wb) => withContacts(wb, [...people, ["P-777", "Elsewhere", "Zed", null, null, null]]));
    const { campaign, rows, contacts, key } = await importFrom(original);
    rows[1]!.cells[key("Company")] = "Beta Labs";
    contacts[0]!.cells[key("Email")] = "ann@acme.com";
    const kept = contacts.filter((c) => c.cells[key("Name")] !== "Al Ng");
    kept.push({ id: "new", position: 99, parentId: rows[1]!.id, cells: { [key("Name")]: "Bea Moss", [key("Contact type")]: "Gatekeeper" } });
    const before = await sheetXml(original, "Contacts");
    const out = await exportCampaign(campaign, original, rows, [], kept, null);
    const after = await sheetXml(out, "Contacts");
    for (const ref of ["A2", "B2", "C2", "D2", "E2", "A4", "C4", "A5", "B5", "C5"]) expect(cellXml(after, ref)).toBe(cellXml(before, ref));
    const ws = (await read(out)).getWorksheet("Contacts")!;
    expect(ws.getCell("F2").value).toBe("ann@acme.com");
    expect(ws.getCell("C3").value ?? null).toBeNull();
    expect(ws.getCell("B4").value).toBe("Beta Labs");
    expect([ws.getCell("A6").value, ws.getCell("B6").value, ws.getCell("C6").value, ws.getCell("D6").value]).toEqual(["P-002", "Beta Labs", "Bea Moss", "Gatekeeper"]);
    // Re-imported: the rename is everywhere and every link still holds.
    const again = await importFrom(out);
    const cs = again.campaign.schema.contacts!;
    const beta = again.rows.find((r) => r.cells[again.key("Company")] === "Beta Labs")!;
    expect(again.contacts.filter((c) => c.parentId === beta.id).map((c) => c.cells[cs.nameKey!])).toEqual(["Bo Chen", "Bea Moss"]);
    expect(again.skipped).toBe(1);
  });

  test("a workbook without one gets a Contacts tab once there are people", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows } = await importFrom(original);
    const none = await exportCampaign(campaign, original, rows, [], [], null);
    expect((await read(none)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary"]);
    // This tracker's prospects have a Name column of their own: the contact's is another.
    const cs = campaign.schema.contacts!;
    const contacts: ExportRow[] = [{ id: "k", position: 9, parentId: rows[2]!.id, cells: { [cs.nameKey!]: "Cy Dee", [cs.typeKey!]: "Influencer", [cs.primaryKey!]: CHECKED } }];
    const out = await exportCampaign(campaign, original, rows, [tpl("One", "Hi", 0)], contacts, null);
    const wb = await read(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "Contacts", "Intro templates"]);
    const ws = wb.getWorksheet("Contacts")!;
    expect([ws.getCell("A1").value, ws.getCell("B1").value, ws.getCell("C1").value]).toEqual(["Prospect ID", "Company", "Name"]);
    expect([ws.getCell("A2").value, ws.getCell("B2").value, ws.getCell("C2").value]).toEqual(["P-003", "Gamma", "Cy Dee"]);
    // The Contact type column is a dropdown there too.
    expect(await sheetXml(out, "Contacts")).toContain("Economic Buyer,Champion,Technical Buyer");
    for (const [name, text] of await partsOf(out)) if (name.endsWith(".xml") || name.endsWith(".rels")) expect({ name, ok: wellFormed(text) }).toEqual({ name, ok: true });
    const again = await importFrom(out);
    const cs2 = again.campaign.schema.contacts!;
    expect(again.contacts.map((c) => [c.cells[cs2.nameKey!], c.cells[cs2.typeKey!], c.parentId])).toEqual([["Cy Dee", "Influencer", again.rows[2]!.id]]);
  });

  test("a missing or repeated prospect ID gets the next one, and the next save writes it in", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["ID", "Company"]);
      ws.addRow(["P-004", "Acme"]);
      ws.addRow([null, "Beta"]);
      ws.addRow(["P-004", "Gamma"]);
    });
    const { campaign, rows } = await importFrom(original);
    const id = campaign.schema.idKey!;
    expect(rows.map((r) => r.cells[id])).toEqual(["P-004", "P-005", "P-006"]);
    const ws = (await read(await exportCampaign(campaign, original, rows, [], [], null))).getWorksheet("Prospects")!;
    expect([ws.getCell("A2").value, ws.getCell("A3").value, ws.getCell("A4").value]).toEqual(["P-004", "P-005", "P-006"]);
  });

  test("an ID the Contacts tab uses for a prospect no longer here is never given to a new one", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["ID", "Company"]);
      ws.addRow(["P-001", "Acme"]);
      ws.addRow([null, "Newco"]);
      const c = wb.addWorksheet("Contacts");
      c.addRow(["Prospect ID", "Company", "Name"]);
      c.addRow(["P-001", "Acme", "Ann Lee"]);
      // Oldco's row was deleted in Excel; its person stays.
      c.addRow(["P-002", "Oldco", "Zed Ray"]);
      // Linked by ID to Acme, but named for another company: linked, and reported.
      c.addRow(["P-001", "Globex", "Gil Tan"]);
      // No ID: matched by company, punctuation aside.
      c.addRow([null, "ACME.", "Al Ng"]);
    });
    const { campaign, rows, contacts, skipped, mismatched, key } = await importFrom(original);
    expect(rows.map((r) => r.cells[campaign.schema.idKey!])).toEqual(["P-001", "P-003"]);
    expect(contacts.map((c) => [c.cells[key("Name")], c.parentId])).toEqual([["Ann Lee", "r0"], ["Gil Tan", "r0"], ["Al Ng", "r0"]]);
    expect(skipped).toBe(1);
    expect(mismatched).toBe(1);
    // …nor by the app, to a prospect added there.
    expect(campaign.schema.reservedIds).toEqual(["P-002"]);
  });

  test("the Contacts tab read is the first one Mudd can read, as the import dialog says", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["ID", "Company", "Status"]);
      ws.addRow(["P-001", "Acme", "Contacted"]);
      ws.addRow(["P-002", "Beta", "Replied"]);
      // The user's own "Contacts" (no link column) comes before the one Mudd added on a save.
      const mine = wb.addWorksheet("Contacts");
      mine.addRow(["Name", "Agency", "Email"]);
      mine.addRow(["Someone", "Somewhere", null]);
      const added = wb.addWorksheet("Contacts 2");
      added.addRow(["Prospect ID", "Company", "Name"]);
      added.addRow(["P-002", "Beta", "Bo Chen"]);
    });
    const { campaign, contacts, inspected, key } = await importFrom(original);
    expect(inspected.sheets.map((s) => [s.name, s.guess])).toEqual([["Prospects", "prospects"], ["Contacts", "passthrough"], ["Contacts 2", "contacts"]]);
    expect(contacts.map((c) => [c.cells[key("Name")], c.parentId])).toEqual([["Bo Chen", "r1"]]);
    expect(campaign.sheets.map((s) => [s.name, s.role])).toEqual([["Prospects", "prospects"], ["Contacts", "passthrough"], ["Contacts 2", "contacts"]]);
  });

  test("prospects without a Company column: a save leaves the Contacts tab's own Company cells be", async () => {
    const original = await xlsxOf((wb) => {
      const ws = wb.addWorksheet("Prospects");
      ws.addRow(["ID", "Firm", "Status"]);
      ws.addRow(["P-001", "Acme", "Contacted"]);
      const c = wb.addWorksheet("Contacts");
      c.addRow(["Prospect ID", "Company", "Name"]);
      c.addRow(["P-001", "Acme", "Ann Lee"]);
    });
    const { campaign, rows, contacts } = await importFrom(original);
    expect(campaign.schema.companyKey).toBeUndefined();
    const out = await exportCampaign(campaign, original, rows, [], contacts, null);
    expect(cellXml(await sheetXml(out, "Contacts"), "B2")).toBe(cellXml(await sheetXml(original, "Contacts"), "B2"));
    expect((await read(out)).getWorksheet("Contacts")!.getCell("B2").value).toBe("Acme");
  });
});

// ---------- a real tracker ----------

describe("round trip with the whole tracker fixture", () => {
  const original = new Uint8Array(fs.readFileSync(FIXTURE));

  test("an unedited save keeps every other part and every original cell", async () => {
    const { campaign, rows, contacts } = await importFrom(original);
    const meta = campaign.sheets.find((s) => s.role === "prospects")!;
    const out = await exportCampaign(campaign, original, rows, [], contacts, null);
    const before = await partsOf(original);
    const after = await partsOf(out);
    const prospects = await sheetXml(original, meta.name);
    for (const [name, text] of before) {
      if (text === prospects || name.endsWith("workbook.xml") || name.endsWith("styles.xml")) continue;
      expect({ name, same: after.get(name) === text }).toEqual({ name, same: true });
    }
    const patched = await sheetXml(out, meta.name);
    for (const m of prospects.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) expect(cellXml(patched, m[1]!)).toBe(m[0]);
    expect(wellFormed(patched)).toBe(true);
  });

  test("edits, new rows, deletes and screening survive a save and re-import", async () => {
    const { campaign, rows, contacts } = await importFrom(original);
    const s = campaign.schema;
    const [first, second, third] = rows;
    first!.cells[s.statusKey!] = "Meeting booked";
    first!.cells[s.meetingAtKey!] = "2026-10-02T14:30";
    first!.cells[s.meetingUrlKey!] = "https://meet.google.com/abc-defg-hij";
    third!.cells[s.screenedKey!] = CHECKED;
    third!.cells[s.reasonKey!] = "Has an agency of record";
    const kept = rows.filter((r) => r.id !== second!.id);
    kept.push({ id: "new", position: 9_999, cells: { [s.companyKey!]: "New Co", [s.statusKey!]: "Contacted" } });
    const out = await exportCampaign(campaign, original, kept, [tpl("Warm", "Hi {{First name}}", 0)], contacts, null);
    const meta = campaign.sheets.find((x) => x.role === "prospects")!;
    const again = await importFrom(out, "fixture.xlsx", meta.name);
    const s2 = again.campaign.schema;
    const back = again.rows.find((r) => r.sourceRow === first!.sourceRow)!;
    expect(back.cells[s2.meetingAtKey!]).toBe("2026-10-02T14:30");
    expect(isScreened(again.rows.find((r) => r.sourceRow === third!.sourceRow)!, s2)).toBe(true);
    expect(again.rows.some((r) => r.sourceRow === second!.sourceRow)).toBe(false);
    expect(again.rows.some((r) => r.cells[s2.companyKey!] === "New Co")).toBe(true);
    expect(again.templates).toEqual([{ name: "Warm", body: "Hi {{First name}}" }]);
  });
});
