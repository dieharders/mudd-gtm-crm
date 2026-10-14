/**
 * Save file end to end through the REST API: in place with backups, the "changed outside Mudd"
 * check, copies, the Downloads fallback, refused macro workbooks, and prospects and their contacts.
 * Also that the API refuses requests from other sites.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Campaign, CampaignBundle, CampaignSummary, InspectResult, Row } from "../shared/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-save-"));
const saved = Object.fromEntries(["MUDD_DATA_DIR", "HOME", "USERPROFILE"].map((k) => [k, process.env[k]]));
let handler: (req: Request) => Promise<Response>;
let db: typeof import("./db");

beforeAll(async () => {
  process.env.MUDD_DATA_DIR = path.join(tmp, "data");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  db = await import("./db");
  db.closeDb();
  handler = (await import("./index")).createFetchHandler();
});

afterAll(() => {
  db.closeDb();
  // One that was unset is unset again: assigned undefined, it would read "undefined", and a later
  // test's database would land in ./undefined.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async <T,>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handler(new Request(`http://127.0.0.1${url}`, init));
  return { status: res.status, json: (await res.json()) as T };
};

async function trackerFile(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prospects");
  ws.addRow(["Company", "Name", "Status"]);
  ws.addRow(["Acme", "Ann", "Contacted"]);
  ws.addRow(["Beta", "Bo", "Replied"]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));
}

async function importPath(file: string): Promise<{ campaign: Campaign; rows: Row[] }> {
  const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
  expect(inspected.status).toBe(200);
  const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Test" });
  expect(imp.status).toBe(200);
  const bundle = await call<{ campaign: Campaign; rows: Row[] }>("GET", `/api/campaigns/${imp.json.id}`);
  return bundle.json;
}

async function statusOf(file: string, row: number): Promise<unknown> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(fs.readFileSync(file)) as unknown as ArrayBuffer);
  return wb.getWorksheet("Prospects")!.getCell(`C${row}`).value;
}

describe("Save file", () => {
  test("writes over the imported file, keeping a .bak and a dated backup", async () => {
    const file = path.join(tmp, "docs", "tracker.xlsx");
    await trackerFile(file);
    const { campaign, rows } = await importPath(file);
    expect(campaign.sourcePath).toBe(file);
    const status = campaign.schema.statusKey!;
    await call("PATCH", `/api/campaigns/${campaign.id}/rows`, { edits: [{ rowId: rows[0]!.id, key: status, value: "Replied" }] });
    const r = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${campaign.id}/save`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: file, linked: true });
    expect(await statusOf(file, 2)).toBe("Replied");
    expect(fs.existsSync(path.join(tmp, "docs", "tracker.bak.xlsx"))).toBe(true);
    expect(fs.readdirSync(path.join(tmp, "data", "backups", campaign.id))).toHaveLength(1);

    // Changed in Excel since: Mudd asks first; forcing replaces it.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const conflict = await call<{ code: string }>("POST", `/api/campaigns/${campaign.id}/save`, {});
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("changed");
    expect((await call("POST", `/api/campaigns/${campaign.id}/save`, { force: true })).status).toBe(200);

    // A copy goes to Downloads and changes no link.
    const copy = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${campaign.id}/save`, { copy: true });
    expect(copy.json.linked).toBe(false);
    expect(path.dirname(copy.json.path)).toBe(path.join(tmp, "Downloads"));
    expect((await call<{ campaign: Campaign }>("GET", `/api/campaigns/${campaign.id}`)).json.campaign.sourcePath).toBe(file);
  });

  test("a dropped-in file saves to Downloads, then keeps saving there", async () => {
    const file = path.join(tmp, "elsewhere", "dropped.xlsx");
    await trackerFile(file);
    const fd = new FormData();
    fd.append("file", new File([fs.readFileSync(file)], "dropped.xlsx"));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", fd);
    const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Dropped" });
    const first = await call<{ path: string; linked: boolean }>("POST", `/api/campaigns/${imp.json.id}/save`, {});
    expect(first.json.linked).toBe(true);
    expect(first.json.path).toBe(path.join(tmp, "Downloads", "dropped.xlsx"));
    const second = await call<{ path: string }>("POST", `/api/campaigns/${imp.json.id}/save`, {});
    expect(second.json.path).toBe(first.json.path);
  });

  test("removing a campaign takes it out of Mudd and leaves its file and backups alone", async () => {
    const file = path.join(tmp, "docs", "keep-me.xlsx");
    await trackerFile(file);
    const { campaign } = await importPath(file);
    expect((await call("POST", `/api/campaigns/${campaign.id}/save`, {})).status).toBe(200);
    const bytes = fs.readFileSync(file);
    const backups = path.join(tmp, "data", "backups", campaign.id);
    const kept = fs.readdirSync(backups);
    expect((await call("DELETE", `/api/campaigns/${campaign.id}`)).status).toBe(200);
    expect((await call("GET", `/api/campaigns/${campaign.id}`)).status).toBe(404);
    expect((await call<CampaignSummary[]>("GET", "/api/campaigns")).json.some((c) => c.id === campaign.id)).toBe(false);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "docs", "keep-me.bak.xlsx"))).toBe(true);
    expect(fs.readdirSync(backups)).toEqual(kept);
    // Imported again, it's all there as it was saved.
    const again = await importPath(file);
    expect(again.rows).toHaveLength(2);
  });

  test("a macro workbook is refused at import", async () => {
    const file = path.join(tmp, "docs", "macros.xlsm");
    await trackerFile(file);
    const r = await call<{ error: string }>("POST", "/api/import/inspect", { path: file });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/macros/);
  });
});

describe("prospects and their contacts", () => {
  test("import links them, the API keeps them apart, and deleting a prospect takes its contacts", async () => {
    const file = path.join(tmp, "docs", "people.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prospects");
    ws.addRow(["ID", "Company", "Status"]);
    ws.addRow(["P-001", "Acme", "Contacted"]);
    ws.addRow(["P-002", "Beta", "Replied"]);
    const people = wb.addWorksheet("Contacts");
    people.addRow(["Prospect ID", "Company", "Name", "Contact type", "Primary"]);
    people.addRow(["P-001", "Acme", "Ann Lee", "Economic Buyer", true]);
    people.addRow(["P-001", "Acme", "Al Ng", "End User", null]);
    people.addRow(["P-002", "Beta", "Bo Chen", "Gatekeeper", true]);
    fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));

    const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
    expect(inspected.json.sheets.map((x) => x.guess)).toEqual(["prospects", "contacts"]);
    const imp = await call<Campaign & { skippedContacts: number }>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "People" });
    expect(imp.json.skippedContacts).toBe(0);
    const id = imp.json.id;
    const bundle = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    expect(bundle.rows).toHaveLength(2);
    const acme = bundle.rows.find((r) => r.cells[bundle.campaign.schema.companyKey!] === "Acme")!;
    const nameKey = bundle.campaign.schema.contacts!.nameKey!;
    expect(bundle.contacts.filter((c) => c.parentId === acme.id).map((c) => c.cells[nameKey])).toEqual(["Ann Lee", "Al Ng"]);
    // The home page counts prospects, not people.
    const summary = (await call<CampaignSummary[]>("GET", "/api/campaigns")).json.find((c) => c.id === id)!;
    expect(summary.prospects).toBe(2);

    // A new contact, and an edit to one, saved into the Contacts tab in place.
    await call("POST", `/api/campaigns/${id}/rows`, { rows: [{ id: "newperson", parentId: acme.id, cells: { [nameKey]: "Amy Poe" } }] });
    const bo = bundle.contacts.find((c) => c.cells[nameKey] === "Bo Chen")!;
    await call("PATCH", `/api/campaigns/${id}/rows`, { edits: [{ rowId: bo.id, key: nameKey, value: "Bo Chen-Li" }] });
    expect((await call("POST", `/api/campaigns/${id}/save`, {})).status).toBe(200);
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.load(new Uint8Array(fs.readFileSync(file)) as unknown as ArrayBuffer);
    const tab = saved.getWorksheet("Contacts")!;
    expect([2, 3, 4, 5].map((r) => tab.getCell(`C${r}`).value)).toEqual(["Ann Lee", "Al Ng", "Bo Chen-Li", "Amy Poe"]);
    expect(tab.getCell("A5").value).toBe("P-001");

    // Deleting Acme deletes its three people with it.
    await call("DELETE", `/api/campaigns/${id}/rows`, { ids: [acme.id] });
    const after = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    expect(after.rows).toHaveLength(1);
    expect(after.contacts.map((c) => c.cells[nameKey])).toEqual(["Bo Chen-Li"]);
  });
});

describe("Export CSV", () => {
  test("writes each tab to Downloads, guards formulas, and imports back as it was", async () => {
    const file = path.join(tmp, "docs", "csv.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prospects");
    ws.addRow(["ID", "Company", "Status", "Notes"]);
    ws.addRow(["P-001", "Acme, Inc.", "Contacted", 'Said "maybe"\nCall back']);
    ws.addRow(["P-002", "Beta", "Replied", "=HYPERLINK(\"x\")"]);
    ws.addRow(["P-003", "Theta", "Replied", "+1 (555) 123-4567"]);
    ws.addRow(["P-004", "Delta", "Replied", "- call Tue"]);
    ws.addRow(["P-005", "Eps", "Replied", "'=SUM is literal"]);
    ws.addRow(["P-006", "Zeta", "Replied", "-2+3+cmd|' /C calc'!A0"]);
    const people = wb.addWorksheet("Contacts");
    people.addRow(["Prospect ID", "Company", "Name", "Contact type", "Primary"]);
    people.addRow(["P-001", "Acme, Inc.", "Ann Lee", "Economic Buyer", true]);
    people.addRow(["P-002", "Beta", "Bo Chen", "Gatekeeper", true]);
    fs.writeFileSync(file, new Uint8Array(await wb.xlsx.writeBuffer()));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", { path: file });
    const imp = await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: "Prospects", name: "Leads" });
    const id = imp.json.id;

    const prospects = await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "prospects" });
    expect(prospects.json.path).toBe(path.join(tmp, "Downloads", "Leads prospects.csv"));
    const text = fs.readFileSync(prospects.json.path, "utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain('"Acme, Inc."');
    expect(text).toContain('"Said ""maybe""\nCall back"');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(",'-2+3+cmd|' /C calc'!A0,");
    // Text that runs nothing goes as it is; text that looks guarded already gets one more.
    expect(text).toContain(",+1 (555) 123-4567,");
    expect(text).toContain(",- call Tue,");
    expect(text).toContain(",''=SUM is literal,");
    // Exporting again never replaces the first file.
    expect((await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "prospects" })).json.path).toBe(path.join(tmp, "Downloads", "Leads prospects (2).csv"));
    // Save file still has no link to change: the campaign is linked to its workbook as before.
    expect((await call<{ campaign: Campaign }>("GET", `/api/campaigns/${id}`)).json.campaign.sourcePath).toBe(file);

    const contacts = await call<{ path: string }>("POST", `/api/campaigns/${id}/csv`, { kind: "contacts" });
    const lines = fs.readFileSync(contacts.json.path, "utf8").replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]!.startsWith("Prospect ID,Company,Name,")).toBe(true);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["P-001", "P-002"]);

    // The prospects CSV imported again gives the same cells, the guard taken off.
    const before = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    const fd = new FormData();
    fd.append("file", new File([fs.readFileSync(prospects.json.path)], "Leads prospects.csv"));
    const again = await call<InspectResult>("POST", "/api/import/inspect", fd);
    const back = await call<Campaign>("POST", "/api/import", { token: again.json.token, prospects: again.json.sheets[0]!.name, name: "Back" });
    const after = (await call<CampaignBundle>("GET", `/api/campaigns/${back.json.id}`)).json;
    const byHeader = (b: CampaignBundle) => b.rows.map((r) => Object.fromEntries(b.campaign.schema.columns.map((c) => [c.header, r.cells[c.key] ?? null])));
    expect(byHeader(after)).toEqual(byHeader(before));
  });

  test("a campaign from the prospects CSV takes the contacts CSV back, each person on their prospect", async () => {
    const file = path.join(tmp, "docs", "csv.xlsx");
    const { campaign: source } = await importPath(file);
    const upload = (p: string, name = path.basename(p)) => {
      const fd = new FormData();
      fd.append("file", new File([fs.readFileSync(p)], name));
      return fd;
    };
    const prospectsCsv = (await call<{ path: string }>("POST", `/api/campaigns/${source.id}/csv`, { kind: "prospects" })).json.path;
    const contactsCsv = (await call<{ path: string }>("POST", `/api/campaigns/${source.id}/csv`, { kind: "contacts" })).json.path;

    const inspected = await call<InspectResult>("POST", "/api/import/inspect", upload(prospectsCsv));
    const id = (await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: inspected.json.sheets[0]!.name, name: "From CSV" })).json.id;
    expect((await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json.contacts).toHaveLength(0);

    type Result = { campaign: Campaign; contacts: Row[]; skipped: number; duplicates: number; mismatched: number };
    const first = await call<Result>("POST", `/api/campaigns/${id}/contacts/import`, upload(contactsCsv));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ skipped: 0, duplicates: 0, mismatched: 0 });
    expect(first.json.contacts).toHaveLength(2);
    const b = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    const { companyKey } = b.campaign.schema;
    const { nameKey, primaryKey } = b.campaign.schema.contacts!;
    const companyOf = (c: Row) => b.rows.find((r) => r.id === c.parentId)!.cells[companyKey!];
    expect(b.contacts.map((c) => [companyOf(c), c.cells[nameKey!], c.cells[primaryKey!]])).toEqual([["Acme, Inc.", "Ann Lee", "TRUE"], ["Beta", "Bo Chen", "TRUE"]]);

    // The same file again adds no one.
    const again = await call<Result>("POST", `/api/campaigns/${id}/contacts/import`, upload(contactsCsv));
    expect(again.json).toMatchObject({ contacts: [], duplicates: 2 });

    // By Company when there is no Prospect ID; someone at no prospect is skipped; a new column joins the contacts'.
    const loose = path.join(tmp, "docs", "loose.csv");
    fs.writeFileSync(loose, "Company,Name,Twitter\nbeta,Bea Ray,@bea\nGamma,Gus Moe,@gus\n");
    const third = await call<Result>("POST", `/api/campaigns/${id}/contacts/import`, upload(loose));
    expect(third.json).toMatchObject({ skipped: 1, duplicates: 0 });
    const after = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    const twitter = after.campaign.schema.contacts!.columns.find((c) => c.header === "Twitter")!;
    const bea = after.contacts.find((c) => c.cells[nameKey!] === "Bea Ray")!;
    expect(after.rows.find((r) => r.id === bea.parentId)!.cells[companyKey!]).toBe("Beta");
    expect(bea.cells[twitter.key]).toBe("@bea");
    // The response is the campaign and rows as stored: the app takes them without fetching again.
    expect(third.json.campaign.schema).toEqual(after.campaign.schema);
    expect(third.json.contacts.map((c) => c.id)).toEqual([bea.id]);
  });

  test("contacts from another campaign go to their own Company, whatever P-### they carry, with one Primary each", async () => {
    const send = (campaignId: string, text: string) => {
      const fd = new FormData();
      fd.append("file", new File([text], "people.csv"));
      return call<{ contacts: Row[]; skipped: number; duplicates: number; mismatched: number }>("POST", `/api/campaigns/${campaignId}/contacts/import`, fd);
    };
    const fd = new FormData();
    fd.append("file", new File(["ID,Company\nP-001,Beta\nP-007,Acme\n"], "other.csv"));
    const inspected = await call<InspectResult>("POST", "/api/import/inspect", fd);
    const id = (await call<Campaign>("POST", "/api/import", { token: inspected.json.token, prospects: inspected.json.sheets[0]!.name, name: "Other" })).json.id;

    const r = await send(id, [
      "Prospect ID,Company,Name,Primary",
      "P-001,\"Acme\",Ann Lee,TRUE", // P-001 is Beta here: Acme's own prospect takes her
      "P-999,Acme,Al Moe,", // no P-999 here: by Company
      "P-001,Old Name,Bo Chen,TRUE", // a Company no prospect has: the ID, flagged
      "P-007,Acme,Cy Dee,TRUE", // Acme's Primary is Ann already
    ].join("\n"));
    expect(r.json).toMatchObject({ skipped: 0, duplicates: 0, mismatched: 1 });
    const b = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    const { companyKey } = b.campaign.schema;
    const { nameKey, primaryKey } = b.campaign.schema.contacts!;
    const at = (company: string) => {
      const p = b.rows.find((x) => x.cells[companyKey!] === company)!;
      return b.contacts.filter((c) => c.parentId === p.id).map((c) => `${c.cells[nameKey!]}${c.cells[primaryKey!] === "TRUE" ? " *" : ""}`);
    };
    expect(at("Acme")).toEqual(["Ann Lee *", "Al Moe", "Cy Dee"]);
    expect(at("Beta")).toEqual(["Bo Chen *"]);

    // A tick for a prospect that has its Primary is dropped in a later file too.
    await send(id, "Company,Name,Primary\nBeta,Dee Fox,TRUE\n");
    const later = (await call<CampaignBundle>("GET", `/api/campaigns/${id}`)).json;
    expect(later.contacts.filter((c) => c.cells[primaryKey!] === "TRUE").map((c) => c.cells[nameKey!])).toEqual(["Ann Lee", "Bo Chen"]);
  });

  test("a contact is a duplicate by name and details, or a channel by its details or its own cells", async () => {
    const { campaign } = await importPath(path.join(tmp, "docs", "csv.xlsx"));
    const send = (text: string) => {
      const fd = new FormData();
      fd.append("file", new File([text], "people.csv"));
      return call<{ contacts: Row[]; duplicates: number }>("POST", `/api/campaigns/${campaign.id}/contacts/import`, fd);
    };
    // Two people of one name, told apart by their email; the second line of one of them adds no one.
    const smiths = await send("Company,Name,Email\nBeta,J. Smith,j1@beta.com\nBeta,J. Smith,j2@beta.com\nBeta,J. Smith,j1@beta.com\n");
    expect(smiths.json).toMatchObject({ duplicates: 1 });
    expect(smiths.json.contacts).toHaveLength(2);

    // A channel, by its phone, though the one here holds more.
    expect((await send("Company,Phone,Notes\nBeta,+1 555 0100,main line\n")).json.contacts).toHaveLength(1);
    expect((await send("Company,Phone\nBeta,+1 555 0100\nBeta,+1 555 0199\n")).json).toMatchObject({ duplicates: 1 });

    // A channel with nothing but a note, given an intro, then exported and imported back: still one.
    const added = (await send("Company,Notes\nBeta,front desk\n")).json.contacts[0]!;
    const b = (await call<CampaignBundle>("GET", `/api/campaigns/${campaign.id}`)).json;
    const { introKey } = b.campaign.schema.contacts!;
    await call("PATCH", `/api/campaigns/${campaign.id}/rows`, { edits: [{ rowId: added.id, key: introKey!, value: "Hello there" }] });
    const csv = (await call<{ path: string }>("POST", `/api/campaigns/${campaign.id}/csv`, { kind: "contacts" })).json.path;
    const again = await send(fs.readFileSync(csv, "utf8"));
    expect(again.json.contacts).toHaveLength(0);
  });

  test("contacts import refuses a file it can't link, or one that isn't a CSV", async () => {
    const { campaign } = await importPath(path.join(tmp, "docs", "csv.xlsx"));
    const send = (name: string, text: string) => {
      const fd = new FormData();
      fd.append("file", new File([text], name));
      return call<{ error: string }>("POST", `/api/campaigns/${campaign.id}/contacts/import`, fd);
    };
    const unlinked = await send("people.csv", "Name,Email\nAnn,ann@acme.com\n");
    expect(unlinked.status).toBe(400);
    expect(unlinked.json.error).toMatch(/Prospect ID or Company/);
    expect((await send("people.xlsx", "x")).status).toBe(400);
  });

  test("refuses anything but prospects or contacts", async () => {
    const { campaign } = await importPath(path.join(tmp, "docs", "csv.xlsx"));
    expect((await call("POST", `/api/campaigns/${campaign.id}/csv`, { kind: "templates" })).status).toBe(400);
  });
});

describe("requests from other sites", () => {
  const send = (url: string, init: RequestInit = {}) => handler(new Request(url, init));

  test("are refused, and change nothing", async () => {
    const before = (await call<CampaignSummary[]>("GET", "/api/campaigns")).json.length;
    // A page on another site posting to the API: text/plain, so the browser sends it without asking.
    const forged = await send("http://127.0.0.1:24871/api/campaigns", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: JSON.stringify({ name: "Forged" }) });
    expect(forged.status).toBe(403);
    // A sandboxed frame or a file:// page sends Origin "null".
    expect((await send("http://127.0.0.1:24871/api/campaigns", { method: "POST", headers: { Origin: "null" }, body: "{}" })).status).toBe(403);
    // DNS rebinding: evil.example resolves to 127.0.0.1, so the page is "same-origin" with the API.
    expect((await send("http://evil.example:24871/api/campaigns")).status).toBe(403);
    expect((await send("http://evil.example:24871/api/campaigns", { method: "POST", headers: { Origin: "http://evil.example:24871" }, body: "{}" })).status).toBe(403);
    // An <img> or <script> on another site: a GET without an Origin.
    for (const site of ["cross-site", "same-site"]) {
      expect((await send("http://127.0.0.1:24871/api/update", { headers: { "Sec-Fetch-Site": site } })).status).toBe(403);
    }
    expect((await call<CampaignSummary[]>("GET", "/api/campaigns")).json).toHaveLength(before);
  });

  test("Mudd's own page still gets through, on 127.0.0.1 or localhost", async () => {
    for (const origin of ["http://127.0.0.1:24871", "http://localhost:24871"]) {
      const res = await send(`${origin}/api/campaigns`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Mine" }) });
      expect(res.status).toBe(200);
    }
    // The URL typed into the address bar.
    expect((await send("http://127.0.0.1:24871/api/campaigns", { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(200);
    // The same host on another port is another site.
    expect((await send("http://127.0.0.1:24871/api/campaigns", { headers: { Origin: "http://127.0.0.1:3000" } })).status).toBe(403);
  });
});
