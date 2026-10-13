/**
 * Runs a built Mudd and checks the spreadsheets it writes, before a release ships it:
 *
 *   bun run scripts/smoke-release.ts dist/darwin-arm64     what the release workflow runs
 *   bun run build && bun run scripts/smoke-release.ts dist
 *
 * The compiled executable can be wrong where the source and its tests are right. Bun 1.4.0's
 * minifier sometimes joined JSZip's "\x00\x00" + "\x00\x00" into six zero bytes, so one build in
 * several wrote every zip with a broken central directory: a tab with dropdowns imported as no
 * tabs at all, and every save corrupted the file. v0.1.13 shipped like that. Only running the
 * executable catches it.
 *
 * Both zip writers in the bundle are exercised: Mudd's JSZip (an .xlsx with a dropdown, imported
 * and saved in place) and ExcelJS's own copy (a CSV import, saved as a new workbook). The app runs
 * headless with a data folder, home folder and port of its own, so it never touches a real Mudd.
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InspectResult } from "../src/shared/types";

const COMPANIES = ["Acme Freight", "Birch & Co", "Cobalt Labs"];
const SUMMARY_FORMULA = "COUNTA(Prospects!$A$2:$A$100)";
const START_TIMEOUT = 30_000;

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: bun run scripts/smoke-release.ts <folder with the built Mudd>");
  process.exit(1);
}
const exe = ["Mudd.app/Contents/MacOS/Mudd", "Mudd.exe", "Mudd"]
  .map((p) => path.join(dir, p))
  .find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
if (!exe) {
  console.error(`No Mudd executable in ${dir}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-smoke-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });

/** A tracker the way people bring one: a dropdown on Prospects, a formula tab pointing at it. */
async function writeTracker(file: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["Company", "Status"]);
  for (const c of COMPANIES) ws.addRow([c, "Not contacted"]);
  (ws as unknown as { dataValidations: { add(r: string, v: ExcelJS.DataValidation): void } }).dataValidations.add("B2:B100", {
    type: "list", allowBlank: true, formulae: ['"Not contacted,Contacted,Replied"'],
  });
  wb.addWorksheet("Summary").addRow(["Total", { formula: SUMMARY_FORMULA, result: COMPANIES.length }]);
  await wb.xlsx.writeFile(file);
}

/**
 * Null when every central-directory record sits where the end record and the one before it say,
 * which is how Excel and most zip readers find a file's parts. The Bun 1.4.0 build failed this
 * from the second record on.
 */
function zipProblem(buf: Uint8Array): string | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return "no end-of-central-directory record";
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  for (let n = 1; n <= count; n++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) {
      return `central directory record ${n} of ${count} is not where the one before it ends`;
    }
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return null;
}

/** The saved file is a sound zip, and opens with every company in it (and, for a tracker, its formula). */
async function checkSaved(file: string, opts: { formula?: boolean } = {}) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const problem = zipProblem(buf);
  if (problem) throw new Error(`${path.basename(file)} is a broken zip: ${problem}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const text = new Set<string>();
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => text.add(cell.text))));
  const missing = COMPANIES.filter((c) => !text.has(c));
  if (missing.length) throw new Error(`${path.basename(file)} has lost ${missing.join(", ")}`);
  if (opts.formula && wb.getWorksheet("Summary")?.getCell("B1").formula !== SUMMARY_FORMULA) {
    throw new Error(`${path.basename(file)} has lost the Summary formula`);
  }
}

async function waitForUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  const read = (async () => {
    for await (const chunk of stdout) {
      out += decoder.decode(chunk, { stream: true });
      const m = /-> (http:\/\/\S+)/.exec(out);
      if (m) return m[1]!;
    }
    throw new Error(`Mudd exited before it started:\n${out}`);
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Mudd did not start within ${START_TIMEOUT / 1000}s:\n${out}`)), START_TIMEOUT));
  return Promise.race([read, timeout]);
}

const app = Bun.spawn([exe, "--headless"], {
  env: {
    ...process.env,
    MUDD_DATA_DIR: path.join(tmp, "data"),
    // Busy or not, the app prints the port it took.
    MUDD_PORT: String(30_000 + Math.floor(Math.random() * 10_000)),
    // A CSV campaign saves into ~/Downloads.
    HOME: home,
    USERPROFILE: home,
  },
  stdout: "pipe",
  stderr: "inherit",
});

let failed = false;
try {
  const base = await waitForUrl(app.stdout);
  const post = async <T>(route: string, body: unknown): Promise<T> => {
    const res = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${route}: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const importAndSave = async (file: string) => {
    const inspected = await post<InspectResult>("/api/import/inspect", { path: file });
    const tab = inspected.sheets.find((s) => s.name === "Prospects");
    if (tab?.rows !== COMPANIES.length) {
      throw new Error(`${path.basename(file)} read as ${JSON.stringify(inspected.sheets.map((s) => [s.name, s.rows]))}`);
    }
    const campaign = await post<{ id: string }>("/api/import", { token: inspected.token, prospects: tab.name });
    return (await post<{ path: string }>(`/api/campaigns/${campaign.id}/save`, {})).path;
  };

  const tracker = path.join(tmp, "tracker.xlsx");
  await writeTracker(tracker);
  await checkSaved(await importAndSave(tracker), { formula: true });
  console.log("ok  .xlsx with a dropdown: imported, saved in place, reopened");

  const csv = path.join(tmp, "prospects.csv");
  fs.writeFileSync(csv, ["Company,Status", ...COMPANIES.map((c) => `${c},Not contacted`)].join("\n"));
  await checkSaved(await importAndSave(csv));
  console.log("ok  .csv: imported, saved as a new workbook, reopened");
} catch (err) {
  failed = true;
  console.error(`FAIL  ${exe}\n  ${(err as Error).message}`);
} finally {
  app.kill();
  await app.exited;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
