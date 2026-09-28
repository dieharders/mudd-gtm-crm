/**
 * Import → edit → Save file → re-import, against workbooks built here with the features real
 * trackers have (formulas on another tab, column formats, notes, merges, dropdowns, tables,
 * SharePoint parts), and optionally against a real one:
 *
 *   MUDD_FIXTURE="/path/to/base-tracker.xlsx" bun test
 *
 * The fixture is read from wherever it lives rather than copied into the repo, because a tracker
 * is full of real people's contact details.
 */
import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs";
import { genericSchema } from "../shared/schema";
import { CHECKED, isScreened, type Campaign, type Template } from "../shared/types";
import { exportCampaign, type ExportRow } from "./export";
import { importWorkbook, inspectWorkbook, loadWorkbook } from "./import";

const FIXTURE = process.env.MUDD_FIXTURE;
const hasFixture = !!FIXTURE && fs.existsSync(FIXTURE);

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
  const campaign: Campaign = {
    id: "c1", name: "test", createdAt: 0, updatedAt: 0, sourceName: name, sourcePath: null,
    hasOriginal: true, schema: imp.schema, sheets: imp.sheets,
  };
  const key = (header: string) => imp.schema.columns.find((c) => c.header === header)!.key;
  return { campaign, rows, templates: imp.templates, inspected, key };
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

/** A small tracker: Prospects (formatted, a note, a link, rich text), Summary with formulas. */
function tracker(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["Company", "Name", "Status", "Last touch", "Score", "Website", "Notes"]);
  ws.addRow(["Acme", "Ann Lee", "Contacted", new Date(Date.UTC(2026, 6, 15, 14, 30)), 4.5, { text: "acme.com", hyperlink: "https://acme.com" }, "Warm"]);
  ws.addRow(["Beta", "Bo Chen", "Not contacted", new Date(Date.UTC(2026, 6, 16, 9, 0)), 3.25, "beta.io", { richText: [{ text: "Bold ", font: { bold: true } }, { text: "plain" }] }]);
  ws.addRow(["Gamma", "Cy Dee", "Replied", new Date(Date.UTC(2026, 6, 17, 10, 15)), 4.75, "gamma.org", "Hot"]);
  ws.getColumn(4).numFmt = "d mmm yyyy h:mm";
  ws.getColumn(4).width = 18;
  ws.getColumn(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
  ws.getCell("A4").note = "Gamma: call after 3pm";
  (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("C2:C1000", {
    type: "list", allowBlank: true, formulae: ['"Not contacted,Contacted,Replied,Dead"'],
  });
  ws.autoFilter = "A1:G4";
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
    const out = await exportCampaign(campaign, original, rows, []);
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
    expect(header).toEqual(["Company", "Name", "Status", "Last touch", "Score", "Website", "Notes", "Meeting URL", "Meeting at", "Intro message", "Screened out", "Screened reason"]);
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
    const out = await exportCampaign(campaign, original, rows, []);
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
    const at = ws.getCell(`${String.fromCharCode(64 + 9)}4`);
    expect(at.value).toEqual(new Date(Date.UTC(2026, 9, 2, 14, 30)));
    expect(at.numFmt).toMatch(/h/);
    expect((ws.getCell("H4").value as { hyperlink: string }).hyperlink).toBe("https://meet.google.com/abc-defg-hij");
    // The note is still on Gamma's row.
    expect(ws.getCell("A4").note).toBeTruthy();
  });

  test("a deleted prospect's row is blanked and nothing moves", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows } = await importFrom(original);
    const kept = rows.filter((r) => r.sourceRow !== 3); // delete Beta
    const before = await sheetXml(original, "Prospects");
    const out = await exportCampaign(campaign, original, kept, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
    const ws = (await read(out)).getWorksheet("Prospects")!;
    expect(ws.getCell("D2").value).toBe("call back Tue");
    expect(ws.getCell("F1").value).toBe("Meeting URL");
  });

  test("changing a column's type does not rewrite cells nobody edited", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    campaign.schema.columns.find((c) => c.key === key("Last touch"))!.type = "date";
    const before = await sheetXml(original, "Prospects");
    const out = await exportCampaign(campaign, original, rows, []);
    const after = await sheetXml(out, "Prospects");
    for (const ref of ["D2", "D3", "D4"]) expect(cellXml(after, ref)).toBe(cellXml(before, ref));
  });

  test("dropdown options edited in the app reach the file", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    const status = campaign.schema.columns.find((c) => c.key === key("Status"))!;
    status.options = ["Not contacted", "Contacted", "Nurture", "Replied", "Dead"];
    const notes = campaign.schema.columns.find((c) => c.key === key("Notes"))!;
    notes.type = "select";
    notes.options = ["Warm", "Hot", "Cold"];
    const out = await exportCampaign(campaign, original, rows, []);
    const xml = await sheetXml(out, "Prospects");
    expect(xml).toContain("&quot;Not contacted,Contacted,Nurture,Replied,Dead&quot;");
    expect(xml).toMatch(/sqref="G2:G1000"><formula1>&quot;Warm,Hot,Cold&quot;/);
    const again = await importFrom(out);
    expect(again.campaign.schema.columns.find((c) => c.header === "Status")!.options).toContain("Nurture");
  });

  test("screening out is a ticked column; the prospect stays in its row", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows } = await importFrom(original);
    const s = campaign.schema;
    rows[1]!.cells[s.screenedKey!] = CHECKED;
    rows[1]!.cells[s.reasonKey!] = "Has an agency of record";
    const out = await exportCampaign(campaign, original, rows, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
    expect(await sheetXml(out, "Screened out")).toBe(await sheetXml(original, "Screened out"));
  });

  test("templates: a new tab, then updated in place", async () => {
    const original = await xlsxOf(tracker);
    const first = await importFrom(original);
    const out1 = await exportCampaign(first.campaign, original, first.rows, [tpl("Warm", "Hi {{First name}},\nshort intro.", 0)]);
    const again = await importFrom(out1);
    expect(again.templates).toEqual([{ name: "Warm", body: "Hi {{First name}},\nshort intro." }]);
    const out2 = await exportCampaign(again.campaign, out1, again.rows, [tpl("Cold", "Hello {{Company}}", 0), tpl("Warm", "Hi again", 1)]);
    const third = await importFrom(out2);
    expect(third.templates).toEqual([{ name: "Cold", body: "Hello {{Company}}" }, { name: "Warm", body: "Hi again" }]);
    const out3 = await exportCampaign(third.campaign, out2, third.rows, []);
    expect((await read(out3)).worksheets.map((w) => w.name)).toEqual(["Prospects", "Summary", "Intro templates"]);
    expect((await importFrom(out3)).templates).toEqual([]);
  });

  test("a user's own 'Intro Templates' tab with other headers is not taken over", async () => {
    const original = await xlsxOf((wb) => {
      tracker(wb);
      wb.addWorksheet("INTRO TEMPLATES").addRow(["Subject", "Notes"]);
    });
    const { campaign, rows } = await importFrom(original);
    const out = await exportCampaign(campaign, original, rows, [tpl("One", "Hello", 0)]);
    const names = (await read(out)).worksheets.map((w) => w.name);
    expect(names).toEqual(["Prospects", "Summary", "INTRO TEMPLATES", "Intro templates 2"]);
    expect(await sheetXml(out, "INTRO TEMPLATES")).toBe(await sheetXml(original, "INTRO TEMPLATES"));
    expect((await importFrom(out)).templates).toEqual([{ name: "One", body: "Hello" }]);
  });

  test("an edited link cell gets a working hyperlink", async () => {
    const original = await xlsxOf(tracker);
    const { campaign, rows, key } = await importFrom(original);
    rows[2]!.cells[key("Website")] = "https://gamma.org/about";
    const out = await exportCampaign(campaign, original, rows, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
    const parts = await partsOf(out);
    const table = [...parts.entries()].find(([k]) => k.startsWith("xl/tables/"))![1];
    expect(table).toMatch(/ref="A1:G4"/);
    expect(table).toContain('name="Stage"');
    expect(table).toContain('name="Screened reason"');
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
    const out = await exportCampaign(campaign, original, rows, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
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
    const out = await exportCampaign(campaign, original, rows, []);
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
  test("export in the base-tracker look and re-import losslessly", async () => {
    const schema = genericSchema();
    const k = (h: string) => schema.columns.find((c) => c.header === h)!.key;
    const rows: ExportRow[] = [
      { id: "a", position: 0, cells: { [k("Name")]: "Ann Lee", [k("Company")]: "Acme", [k("Status")]: "Replied", [k("Next date")]: "2026-10-01", [k("Meeting at")]: "2026-10-03T09:15" } },
      { id: "b", position: 1, cells: { [k("Name")]: "Bo Chen", [k("Company")]: "Beta", [k("Status")]: "Not contacted", [k("Email")]: "bo@beta.io" } },
      { id: "c", position: 2, cells: { [k("Name")]: "Cy Dee", [k("Company")]: "Gamma", [k("Screened out")]: CHECKED, [k("Screened reason")]: "Too big" } },
    ];
    const campaign: Campaign = { id: "c", name: "Fresh", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema, sheets: [] };
    const out = await exportCampaign(campaign, null, rows, [tpl("One", "Hello {{Company}}", 0)]);
    const wb = await read(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Prospects", "Intro templates"]);
    const ws = wb.getWorksheet("Prospects")!;
    expect(ws.getCell("A1").value).toBe("Name");
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF1C1B18" } });
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: 1 });

    const again = await importFrom(out, "fresh.xlsx", "Prospects");
    const s2 = again.campaign.schema;
    const ann = again.rows.find((r) => r.cells[s2.nameKey!] === "Ann Lee")!;
    expect(ann.cells[s2.meetingAtKey!]).toBe("2026-10-03T09:15");
    expect(ann.cells[s2.statusKey!]).toBe("Replied");
    const cy = again.rows.find((r) => r.cells[s2.nameKey!] === "Cy Dee")!;
    expect(isScreened(cy, s2)).toBe(true);
    expect(cy.cells[s2.reasonKey!]).toBe("Too big");
    expect(s2.columns.find((c) => c.key === s2.statusKey)!.options).toContain("Dead");
    expect(again.templates).toEqual([{ name: "One", body: "Hello {{Company}}" }]);
  });

  test("CSV imports gain Status and the Mudd columns", async () => {
    const csv = new TextEncoder().encode('Name,Company,Email\n"Lee, Ann",Acme,ann@acme.io\nBo,Beta,\n');
    const imp = importWorkbook(await loadWorkbook(csv, "list.csv"), { prospects: "Prospects" });
    expect(imp.rows).toHaveLength(2);
    expect(imp.rows[0]!.cells[imp.schema.nameKey!]).toBe("Lee, Ann");
    expect(imp.schema.columns.map((c) => c.header)).toEqual(
      expect.arrayContaining(["Status", "Meeting URL", "Meeting at", "Intro message", "Screened out", "Screened reason"]),
    );
  });
});

// ---------- a real tracker ----------

describe.skipIf(!hasFixture)("round trip with MUDD_FIXTURE", () => {
  const original = hasFixture ? new Uint8Array(fs.readFileSync(FIXTURE!)) : new Uint8Array();

  test("an unedited save keeps every other part and every original cell", async () => {
    const { campaign, rows } = await importFrom(original);
    const meta = campaign.sheets.find((s) => s.role === "prospects")!;
    const out = await exportCampaign(campaign, original, rows, []);
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
    const { campaign, rows } = await importFrom(original);
    const s = campaign.schema;
    const [first, second, third] = rows;
    first!.cells[s.statusKey!] = "Meeting booked";
    first!.cells[s.meetingAtKey!] = "2026-10-02T14:30";
    first!.cells[s.meetingUrlKey!] = "https://meet.google.com/abc-defg-hij";
    first!.cells[s.introKey!] = "Hi there,\nshort intro.";
    third!.cells[s.screenedKey!] = CHECKED;
    third!.cells[s.reasonKey!] = "Has an agency of record";
    const kept = rows.filter((r) => r.id !== second!.id);
    kept.push({ id: "new", position: 9_999, cells: { [s.companyKey!]: "New Co", [s.statusKey!]: "Contacted" } });
    const out = await exportCampaign(campaign, original, kept, [tpl("Warm", "Hi {{First name}}", 0)]);
    const meta = campaign.sheets.find((x) => x.role === "prospects")!;
    const again = await importFrom(out, "fixture.xlsx", meta.name);
    const s2 = again.campaign.schema;
    const back = again.rows.find((r) => r.sourceRow === first!.sourceRow)!;
    expect(back.cells[s2.meetingAtKey!]).toBe("2026-10-02T14:30");
    expect(back.cells[s2.introKey!]).toBe("Hi there,\nshort intro.");
    expect(isScreened(again.rows.find((r) => r.sourceRow === third!.sourceRow)!, s2)).toBe(true);
    expect(again.rows.some((r) => r.sourceRow === second!.sourceRow)).toBe(false);
    expect(again.rows.some((r) => r.cells[s2.companyKey!] === "New Co")).toBe(true);
    expect(again.templates).toEqual([{ name: "Warm", body: "Hi {{First name}}" }]);
  });
});
