/**
 * Builds the tracker workbook the round-trip test runs against by default:
 *
 *   bun run fixture      → src/xlsx/fixtures/base-tracker.generated.xlsx
 *
 * It has the shape of a real tracker, with the features that trip up a naive save: a Summary
 * tab of formulas over fixed column letters, a Prospects tab with dropdowns, number and date
 * formats, notes, a hyperlink, rich text, a frozen header and an autofilter, a Contacts tab
 * linked by Prospect ID, and SharePoint custom parts. No Intro templates tab: Mudd rewrites that
 * one on every save, and a real tracker starts without it. Every company and person in it is made
 * up. Regenerate it (and commit the result) whenever the layout changes.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(import.meta.dir, "..", "src", "xlsx", "fixtures", "base-tracker.generated.xlsx");

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1B18" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
const STAGES = ["Not contacted", "Contacted", "Replied", "Meeting booked", "Proposal", "Won", "Dead"];
const CONTACT_TYPES = ["Economic Buyer", "Champion", "Technical Buyer", "End User", "Influencer", "Blocker", "Gatekeeper", "Channel"];

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, day, h, min));

function header(ws: ExcelJS.Worksheet, headers: string[], widths: number[]) {
  const row = ws.addRow(headers);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];
}

function listValidation(ws: ExcelJS.Worksheet, range: string, options: string[]) {
  (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(range, {
    type: "list", allowBlank: true, formulae: [`"${options.join(",")}"`],
  });
}

// ---------- Prospects ----------

const PROSPECT_HEADERS = [
  "ID", "Company", "Motion", "Rank", "Type", "Location", "Website", "# Employees", "Status", "Next step",
  "Meeting URL", "Meeting at", "Hook", "Notes", "Source", "Intro message", "Screened out", "Screened reason",
];
const PROSPECT_WIDTHS = [10, 26, 12, 8, 16, 20, 28, 12, 18, 28, 30, 20, 40, 40, 18, 44, 14, 36];

type ProspectRow = (string | number | Date | null | ExcelJS.CellValue)[];
const prospects: ProspectRow[] = [
  ["P-001", "Northwind Fabrication", "Direct", 1, "Manufacturer", "Dayton, OH", { text: "northwindfab.example", hyperlink: "https://northwindfab.example" }, 420, "Contacted", "Follow up on the assessment offer", null, null, "Hiring a security lead", "Plant manager owns IT budget", "Trade list", null, null, null],
  ["P-002", "Harbor Lights Logistics", "Aggregator", 2, "3PL", "Tacoma, WA", "harborlights.example", 1100, "Replied", "Send the one-pager", null, null, "Opened a second warehouse", { richText: [{ text: "Warm. ", font: { bold: true } }, { text: "Asked for pricing by email." }] }, "Referral", null, null, null],
  ["P-003", "Copperline Foods", "Direct", 3, "Food processor", "Fresno, CA", "copperline.example", 260, "Not contacted", null, null, null, "New CFO in August", null, "Association list", null, null, null],
  ["P-004", "Bluestem Dental Group", "Aggregator", 4, "Dental group", "Omaha, NE", "bluestemdental.example", 85, "Meeting booked", "Prep for the call", "https://meet.example/blue-stem", d(2026, 10, 6, 15, 0), "Adding two locations", "Office manager is the champion", "Trade list", "Hi Dana,\nthanks for the time this week.", null, null],
  ["P-005", "Granite Peak Credit Union", "Direct", 5, "Credit union", "Boise, ID", "granitepeakcu.example", 190, "Dead", null, null, null, null, "Chose an incumbent", "Conference", null, "TRUE", "Signed a three-year deal with another vendor"],
  ["P-006", "Saltmarsh Marine Supply", "Aggregator", 6, "Distributor", "Mobile, AL", "saltmarshmarine.example", 60, "Contacted", "Call Thursday", null, null, "Seasonal push before spring", null, "Trade list", null, null, null],
];

function addProspects(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Prospects");
  header(ws, PROSPECT_HEADERS, PROSPECT_WIDTHS);
  for (const r of prospects) ws.addRow(r);
  const last = prospects.length + 1;
  ws.getColumn(12).numFmt = "d mmm yyyy h:mm";
  ws.getColumn(8).numFmt = "#,##0";
  listValidation(ws, `C2:C2000`, ["Direct", "Aggregator"]);
  listValidation(ws, `I2:I2000`, STAGES);
  listValidation(ws, `Q2:Q2000`, ["TRUE", "FALSE"]);
  ws.getCell("B3").note = "Harbor Lights: the warehouse lead is the one to reach.";
  ws.getCell("I6").note = "Marked dead after the vendor announcement.";
  ws.getColumn(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
  for (let r = 2; r <= last; r++) {
    for (const col of [13, 14, 16, 18]) ws.getCell(r, col).alignment = { wrapText: true, vertical: "top" };
  }
  ws.autoFilter = `A1:R${last}`;
  // A footnote under the data, as hand-kept trackers have.
  ws.getCell(last + 2, 2).value = "Paste new rows directly above this line, columns already in this order.";
  ws.getCell(last + 2, 2).font = { italic: true, color: { argb: "FF888888" } };
}

// ---------- Contacts ----------

const CONTACT_HEADERS = ["Prospect ID", "Company", "Name", "Contact type", "Primary", "Title", "Role", "Email", "Phone", "LinkedIn", "Last contacted", "Last reply", "Notes"];
const CONTACT_WIDTHS = [12, 26, 22, 18, 10, 8, 26, 30, 18, 34, 14, 12, 40];
const contacts: ProspectRow[] = [
  ["P-001", "Northwind Fabrication", "Maya Okafor", "Champion", "TRUE", "Ms.", "Plant Manager", "maya.okafor@northwindfab.example", "+1 937 555 0141", "https://linkedin.example/in/maya-okafor", d(2026, 9, 22), null, "Met at the regional show"],
  ["P-001", "Northwind Fabrication", "Tom Reyes", "Technical Buyer", null, "Mr.", "IT Lead", "tom.reyes@northwindfab.example", null, null, null, null, null],
  ["P-002", "Harbor Lights Logistics", "Priya Natarajan", "Economic Buyer", "TRUE", null, "VP Operations", "priya@harborlights.example", "+1 253 555 0177", "https://linkedin.example/in/priya-natarajan", d(2026, 9, 25), d(2026, 9, 26), null],
  ["P-004", "Bluestem Dental Group", "Dana Whitfield", "Champion", "TRUE", null, "Office Manager", "dana@bluestemdental.example", "+1 402 555 0126", null, null, null, "Prefers afternoon calls"],
  ["P-004", "Bluestem Dental Group", "Dr. Elise Marchetti", "Economic Buyer", null, "Dr.", "Owner", null, null, null, null, null, null],
  ["P-005", "Granite Peak Credit Union", "Hank Ostrowski", "Gatekeeper", "TRUE", null, "CIO", "hank@granitepeakcu.example", null, null, null, null, null],
  ["P-006", "Saltmarsh Marine Supply", "Rosa Lindqvist", "End User", "TRUE", null, "Operations Coordinator", "rosa@saltmarshmarine.example", "+1 251 555 0199", null, d(2026, 9, 30), null, null],
];

function addContacts(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Contacts");
  header(ws, CONTACT_HEADERS, CONTACT_WIDTHS);
  for (const r of contacts) ws.addRow(r);
  ws.getColumn(11).numFmt = "d mmm yyyy";
  ws.getColumn(12).numFmt = "d mmm yyyy";
  listValidation(ws, "D2:D2000", CONTACT_TYPES);
  listValidation(ws, "E2:E2000", ["TRUE", "FALSE"]);
  ws.autoFilter = `A1:M${contacts.length + 1}`;
}

// ---------- Summary ----------

function addSummary(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Summary");
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 12;
  ws.mergeCells("A1:C1");
  ws.getCell("A1").value = "Pipeline summary";
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A1").note = "Counts over the Prospects tab by column letter: keep its column order.";
  ws.addRow([]);
  ws.addRow(["Stage", "Direct", "Aggregator"]).font = { bold: true };
  const count = (stage: string, motion: string) => ({
    formula: `SUMPRODUCT((Prospects!$I$2:$I$2000="${stage}")*(Prospects!$C$2:$C$2000="${motion}"))`,
    result: prospects.filter((r) => r[8] === stage && r[2] === motion).length,
  });
  for (const stage of STAGES) ws.addRow([stage, count(stage, "Direct"), count(stage, "Aggregator")]);
  ws.addRow([]);
  ws.addRow(["Total prospects", { formula: "COUNTA(Prospects!$B$2:$B$2000)-1", result: prospects.length }]);
  ws.addRow(["Screened out", { formula: 'COUNTIF(Prospects!$Q$2:$Q$2000,"TRUE")', result: 1 }]);
  ws.addRow(["Contacts", { formula: "COUNTA(Contacts!$C$2:$C$2000)", result: contacts.length }]);
}

// ---------- SharePoint-style parts ----------

async function withCustomParts(buf: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(buf);
  zip.file("docProps/custom.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ContentTypeId"><vt:lpwstr>0x0101003044462CB29FD24EB00A734C0481B8EA</vt:lpwstr></property></Properties>');
  zip.file("customXml/item1.xml", "<root>fixture</root>");
  const rels = await zip.file("_rels/.rels")!.async("string");
  zip.file("_rels/.rels", rels.replace("</Relationships>", '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'));
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", ct.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
  // A fixed timestamp keeps the file byte-identical across runs.
  const date = new Date(Date.UTC(2026, 9, 1));
  for (const f of Object.values(zip.files)) f.date = date;
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const wb = new ExcelJS.Workbook();
wb.creator = "Mudd fixture";
wb.created = new Date(Date.UTC(2026, 9, 1));
wb.modified = wb.created;
addSummary(wb);
addProspects(wb);
addContacts(wb);
const out = await withCustomParts(new Uint8Array(await wb.xlsx.writeBuffer()));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${out.length} bytes)`);
