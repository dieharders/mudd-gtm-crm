/**
 * Import → edit → export → re-import, against a real workbook.
 *
 *   MUDD_FIXTURE="C:\Users\you\Downloads\base-tracker.xlsx" bun test
 *
 * The workbook is read from wherever it lives rather than copied into the repo, because a
 * tracker is full of real people's contact details. Without MUDD_FIXTURE the fixture tests are
 * skipped and only the generated-workbook tests run.
 */
import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs";
import type { Campaign, Row, Template } from "../shared/types";
import { exportCampaign } from "./export";
import { importWorkbook, inspectWorkbook, loadWorkbook } from "./import";
import { genericSchema } from "./layouts";

const FIXTURE = process.env.MUDD_FIXTURE;
const hasFixture = !!FIXTURE && fs.existsSync(FIXTURE);

async function importFrom(buf: Uint8Array, name: string, prospects?: string, screened?: string | null) {
  const wb = await loadWorkbook(buf, name);
  const { sheets } = inspectWorkbook(wb);
  const p = prospects ?? sheets.find((s) => s.guess === "prospects")!.name;
  const s = screened === undefined ? sheets.find((x) => x.guess === "screened")?.name ?? null : screened;
  const imp = importWorkbook(wb, { prospects: p, screened: s });
  const rows: Row[] = imp.rows.map((r, i) => ({ ...r, id: `r${i}` }));
  const campaign: Campaign = {
    id: "c1", name: "test", createdAt: 0, updatedAt: 0, sourceName: name, sourcePath: null,
    hasOriginal: true, schema: imp.schema, sheets: imp.sheets,
  };
  return { campaign, rows, templates: imp.templates, wb };
}

async function sheetXml(buf: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const out = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels);
    const t = (target?.[1] ?? target?.[2])!.replace(/^\/?(xl\/)?/, "");
    out.set(m[1]!, await zip.file(`xl/${t}`)!.async("string"));
  }
  return out;
}
/** Style minus explicit defaults: `shrinkToFit: false` and an absent flag mean the same to Excel. */
function normStyle(style: Partial<ExcelJS.Style>): unknown {
  const s = JSON.parse(JSON.stringify(style ?? {}));
  if (s.alignment) for (const k of Object.keys(s.alignment)) if (s.alignment[k] === false) delete s.alignment[k];
  return s;
}
// The optional `count` attribute is ignored: postprocess.ts always writes it, originals may not.
const block = (xml: string, tag: string) =>
  (new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`).exec(xml)?.[0] ?? "").replace(/^(<\w+) count="\d+"/, "$1");

function colWidths(cols: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of cols.matchAll(/<col[^>]*\/>/g)) {
    const min = +/min="(\d+)"/.exec(m[0])![1]!;
    const max = +/max="(\d+)"/.exec(m[0])![1]!;
    const w = +/width="([\d.]+)"/.exec(m[0])![1]!;
    for (let i = min; i <= max; i++) out.set(i, w);
  }
  return out;
}

async function read(buf: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

const template = (name: string, body: string, i: number): Template => ({ id: `t${i}`, campaignId: "c1", name, body, position: i, updatedAt: 0 });

describe.skipIf(!hasFixture)("round trip with MUDD_FIXTURE", () => {
  const original = hasFixture ? new Uint8Array(fs.readFileSync(FIXTURE!)) : new Uint8Array();

  test("an unedited export matches the original cell for cell", async () => {
    const { campaign, rows } = await importFrom(original, "fixture.xlsx");
    const out = await exportCampaign(campaign, original, rows, []);
    const a = await read(original);
    const b = await read(out);
    expect(b.worksheets.map((w) => w.name)).toEqual(a.worksheets.map((w) => w.name));
    for (const wa of a.worksheets) {
      const wbs = b.getWorksheet(wa.name)!;
      const prospects = campaign.sheets.find((s) => s.name === wa.name && s.role === "prospects");
      // The Prospects sheet gains Mudd's appended columns; everything up to its old last column
      // must be untouched.
      const lastCol = prospects ? prospects.lastCol : wa.columnCount;
      for (let r = 1; r <= wa.rowCount; r++) {
        for (let c = 1; c <= lastCol; c++) {
          const ca = wa.getRow(r).getCell(c);
          const cb = wbs.getRow(r).getCell(c);
          expect({ at: `${wa.name}!${ca.address}`, v: cb.value ?? null }).toEqual({ at: `${wa.name}!${ca.address}`, v: ca.value ?? null });
          expect({ at: `${wa.name}!${ca.address}`, s: normStyle(cb.style) }).toEqual({ at: `${wa.name}!${ca.address}`, s: normStyle(ca.style) });
        }
      }
      expect(JSON.stringify(wbs.views)).toBe(JSON.stringify(wa.views));
    }
    // Dropdown ranges and column widths come back byte-for-byte (see postprocess.ts).
    const xa = await sheetXml(original);
    const xb = await sheetXml(out);
    for (const [name, xml] of xa) {
      expect(block(xb.get(name)!, "dataValidations")).toBe(block(xml, "dataValidations"));
      const meta = campaign.sheets.find((s) => s.name === name && s.role === "prospects");
      if (!meta) {
        expect(block(xb.get(name)!, "cols")).toBe(block(xml, "cols"));
        continue;
      }
      // Prospects: every original column keeps its width; spans stay sorted and disjoint.
      const before = colWidths(block(xml, "cols"));
      const after = colWidths(block(xb.get(name)!, "cols"));
      for (const [i, w] of before) if (i <= meta.lastCol) expect({ i, w: after.get(i) }).toEqual({ i, w });
      const mins = [...block(xb.get(name)!, "cols").matchAll(/min="(\d+)" max="(\d+)"|max="(\d+)"[^>]*min="(\d+)"/g)];
      let last = 0;
      for (const m of block(xb.get(name)!, "cols").matchAll(/<col[^>]*\/>/g)) {
        const min = +/min="(\d+)"/.exec(m[0])![1]!;
        const max = +/max="(\d+)"/.exec(m[0])![1]!;
        expect(min).toBeGreaterThan(last);
        last = max;
      }
      expect(mins.length).toBeGreaterThan(0);
    }
  });

  test("edits, new rows, deletes, meetings and screening survive export and re-import", async () => {
    const { campaign, rows } = await importFrom(original, "fixture.xlsx");
    const s = campaign.schema;
    const prospects = rows.filter((r) => r.bucket === "prospects");
    const [first, second, third] = prospects;
    first!.cells[s.statusKey!] = "Meeting booked";
    first!.cells[s.meetingAtKey!] = "2026-10-02T14:30";
    first!.cells[s.meetingUrlKey!] = "https://meet.google.com/abc-defg-hij";
    first!.cells[s.introKey!] = "Hi there,\nshort intro.";
    // Screen one out (to the end of the screened list), delete another.
    third!.bucket = "screened";
    third!.position = 10_000;
    third!.cells[s.reasonKey!] = "Has an agency of record";
    const kept = rows.filter((r) => r.id !== second!.id);
    const added: Row = { id: "new", bucket: "prospects", position: 9_999, cells: { [s.companyKey!]: "New Co", [s.statusKey!]: "Contacted" } };
    kept.push(added);

    const out = await exportCampaign(campaign, original, kept, [template("Warm", "Hi {{First name}}", 0)]);
    const wb = await read(out);
    const pSheet = campaign.sheets.find((x) => x.role === "prospects")!;
    const ws = wb.getWorksheet(pSheet.name)!;
    const meetingCol = ws.getRow(1).values as unknown[];
    const atIdx = meetingCol.findIndex((v) => v === "Meeting at");
    const urlIdx = meetingCol.findIndex((v) => v === "Meeting URL");
    expect(atIdx).toBeGreaterThan(pSheet.lastCol);
    const at = ws.getRow(2).getCell(atIdx);
    expect(at.value).toBeInstanceOf(Date);
    expect(at.numFmt).toBe("yyyy-mm-dd hh:mm");
    expect((ws.getRow(2).getCell(urlIdx).value as { hyperlink: string }).hyperlink).toBe("https://meet.google.com/abc-defg-hij");
    // Rows written back in order, the new one last, and nothing left over from the deleted one.
    const written = kept.filter((r) => r.bucket === "prospects").length;
    const companyIdx = pSheet.colMap[s.companyKey!]!;
    expect(ws.getRow(written + 1).getCell(companyIdx).value).toBe("New Co");
    expect(ws.getRow(written + 2).getCell(companyIdx).value ?? null).toBeNull();
    expect(wb.getWorksheet("Intro templates")).toBeTruthy();

    // Formulas on untouched tabs are still formulas.
    for (const sheet of campaign.sheets.filter((x) => x.role === "passthrough")) {
      const a = (await read(original)).getWorksheet(sheet.name)!;
      const b = wb.getWorksheet(sheet.name)!;
      a.eachRow((row, r) => row.eachCell((cell, c) => {
        if (cell.formula) expect(b.getRow(r).getCell(c).formula).toBe(cell.formula);
      }));
    }

    // Re-import: the same buckets, values and templates come back.
    const again = await importFrom(out, "fixture.xlsx", pSheet.name, campaign.sheets.find((x) => x.role === "screened")?.name ?? null);
    const s2 = again.campaign.schema;
    const back = again.rows.find((r) => r.cells[s2.companyKey!] === first!.cells[s.companyKey!])!;
    expect(back.cells[s2.meetingAtKey!]).toBe("2026-10-02T14:30");
    expect(back.cells[s2.meetingUrlKey!]).toBe("https://meet.google.com/abc-defg-hij");
    expect(back.cells[s2.introKey!]).toBe("Hi there,\nshort intro.");
    const screenedBack = again.rows.find((r) => r.cells[s2.companyKey!] === third!.cells[s.companyKey!])!;
    expect(screenedBack.bucket).toBe("screened");
    expect(screenedBack.cells[s2.reasonKey!]).toBe("Has an agency of record");
    expect(again.rows.some((r) => r.cells[s2.companyKey!] === second!.cells[s.companyKey!])).toBe(false);
    expect(again.templates).toEqual([{ name: "Warm", body: "Hi {{First name}}" }]);
  });

  test("a second export of a re-imported file is stable", async () => {
    const first = await importFrom(original, "fixture.xlsx");
    const out1 = await exportCampaign(first.campaign, original, first.rows, []);
    const second = await importFrom(out1, "fixture.xlsx", first.campaign.sheets.find((s) => s.role === "prospects")!.name);
    const out2 = await exportCampaign(second.campaign, out1, second.rows, []);
    const a = await read(out1);
    const b = await read(out2);
    for (const wa of a.worksheets) {
      const wbs = b.getWorksheet(wa.name)!;
      for (let r = 1; r <= Math.min(wa.rowCount, 60); r++) {
        for (let c = 1; c <= wa.columnCount; c++) {
          expect(wbs.getRow(r).getCell(c).value ?? null).toEqual(wa.getRow(r).getCell(c).value ?? null);
        }
      }
    }
  });
});

describe("campaigns created in Mudd", () => {
  test("export in the base-tracker look and re-import losslessly", async () => {
    const schema = genericSchema();
    const k = (h: string) => schema.columns.find((c) => c.header === h)!.key;
    const rows: Row[] = [
      { id: "a", bucket: "prospects", position: 0, cells: { [k("Name")]: "Ann Lee", [k("Company")]: "Acme", [k("Status")]: "Replied", [k("Next date")]: "2026-10-01", [k("Meeting at")]: "2026-10-03T09:15" } },
      { id: "b", bucket: "prospects", position: 1, cells: { [k("Name")]: "Bo Chen", [k("Company")]: "Beta", [k("Status")]: "Not contacted", [k("Email")]: "bo@beta.io" } },
      { id: "c", bucket: "screened", position: 2, cells: { [k("Name")]: "Cy Dee", [k("Company")]: "Gamma", [k("Screened reason")]: "Too big", [k("Title")]: "CEO" } },
    ];
    const campaign: Campaign = { id: "c", name: "Fresh", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema, sheets: [] };
    const out = await exportCampaign(campaign, null, rows, [template("One", "Hello {{Company}}", 0)]);
    const wb = await read(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Prospects", "Screened out", "Intro templates"]);
    const ws = wb.getWorksheet("Prospects")!;
    expect(ws.getCell("A1").value).toBe("Name");
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF1C1B18" } });
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: 1 });
    const statusIdx = (ws.getRow(1).values as unknown[]).indexOf("Status");
    expect(ws.getRow(2).getCell(statusIdx).value).toBe("Replied");
    const xml = (await sheetXml(out)).get("Prospects")!;
    expect(xml).toContain('sqref="I2:I1000"');
    expect(xml).toContain("<conditionalFormatting");
    const scr = wb.getWorksheet("Screened out")!;
    expect(scr.getRow(1).values).toEqual(expect.arrayContaining(["Company", "Name", "Screened reason", "Title"]));

    const again = await importFrom(out, "fresh.xlsx", "Prospects", "Screened out");
    const s2 = again.campaign.schema;
    const ann = again.rows.find((r) => r.cells[s2.nameKey!] === "Ann Lee")!;
    expect(ann.cells[s2.meetingAtKey!]).toBe("2026-10-03T09:15");
    expect(ann.cells[s2.statusKey!]).toBe("Replied");
    const cy = again.rows.find((r) => r.cells[s2.nameKey!] === "Cy Dee")!;
    expect(cy.bucket).toBe("screened");
    expect(cy.cells[s2.reasonKey!]).toBe("Too big");
    expect(s2.columns.find((c) => c.key === s2.statusKey)!.options).toContain("Dead");
    expect(again.templates).toEqual([{ name: "One", body: "Hello {{Company}}" }]);
  });

  test("CSV imports gain Status and the Mudd columns", async () => {
    const csv = new TextEncoder().encode('Name,Company,Email\n"Lee, Ann",Acme,ann@acme.io\nBo,Beta,\n');
    const wb = await loadWorkbook(csv, "list.csv");
    const imp = importWorkbook(wb, { prospects: "Prospects", screened: null });
    expect(imp.rows).toHaveLength(2);
    expect(imp.rows[0]!.cells[imp.schema.nameKey!]).toBe("Lee, Ann");
    expect(imp.schema.columns.map((c) => c.header)).toEqual(
      expect.arrayContaining(["Status", "Meeting URL", "Meeting at", "Intro message", "Screened reason"]),
    );
  });
});
