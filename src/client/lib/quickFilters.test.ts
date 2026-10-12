import { describe, expect, test } from "bun:test";
import { ensureAppColumns, makeKey } from "../../shared/schema";
import { CHECKED, stagesOf, type CampaignSchema, type CellValue, type ColumnType, type Row } from "../../shared/types";
import { contactFilters, prospectFilters, type QuickFilterId } from "./quickFilters";

function sheet(...cols: [string, ColumnType?][]): CampaignSchema {
  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: cols.map(([header, type = "text"]) => ({ key: makeKey(header, taken), header, type, origin: "sheet" })) };
  ensureAppColumns(schema);
  return schema;
}
const keyOf = (schema: CampaignSchema, header: string) => schema.columns.find((c) => c.header === header)!.key;
let n = 0;
const row = (cells: Record<string, CellValue>, parentId?: string): Row => ({ id: `r${++n}`, position: n, cells, ...(parentId ? { parentId } : {}) });
const NOW = new Date(2026, 9, 11);

function filterOf(schema: CampaignSchema, id: QuickFilterId, contacts: Row[] = []) {
  const f = prospectFilters(schema, stagesOf(schema), (pid) => contacts.filter((c) => c.parentId === pid), NOW).find((x) => x.id === id);
  return f;
}

describe("needs follow-up", () => {
  const schema = sheet(["Company"], ["Status"], ["Sent", "date"], ["Replied", "date"], ["Last touch", "date"]);
  const f = filterOf(schema, "followUp")!;
  const s = schema.statusKey!;
  const sent = keyOf(schema, "Sent");
  const replied = keyOf(schema, "Replied");
  const lasttouch = keyOf(schema, "Last touch");

  test("contacted a week or more ago, with no reply", () => {
    expect(f.test(row({ [s]: "Contacted", [sent]: "2026-10-04" }))).toBe(true);
    expect(f.test(row({ [s]: "contacted", [sent]: "2026-09-01" }))).toBe(true);
    expect(f.test(row({ [s]: "Contacted", [sent]: "2026-10-05" }))).toBe(false);
  });

  test("the latest of Sent and Last touch counts", () => {
    expect(f.test(row({ [s]: "Contacted", [sent]: "2026-09-01", [lasttouch]: "2026-10-10" }))).toBe(false);
  });

  test("a reply, another stage, or a screened-out prospect is no follow-up", () => {
    expect(f.test(row({ [s]: "Contacted", [sent]: "2026-09-01", [replied]: "2026-09-03" }))).toBe(false);
    expect(f.test(row({ [s]: "Replied", [sent]: "2026-09-01" }))).toBe(false);
    expect(f.test(row({ [s]: "Contacted", [sent]: "2026-09-01", [schema.screenedKey!]: CHECKED }))).toBe(false);
  });

  test("contacted but never dated is chased", () => {
    expect(f.test(row({ [s]: "Contacted" }))).toBe(true);
  });

  test("not offered without a Sent or Last touch column", () => {
    expect(filterOf(sheet(["Company"], ["Status"]), "followUp")).toBeUndefined();
  });
});

describe("not ready to send", () => {
  const schema = sheet(["Company"], ["Status"], ["Intro", "longtext"]);
  const f = (contacts: Row[]) => filterOf(schema, "notReady", contacts)!;
  const s = schema.statusKey!;
  const intro = schema.introKey!;
  const primary = schema.contacts!.primaryKey!;

  test("a prospect not yet contacted that lacks an intro or a primary contact", () => {
    const ready = row({ [s]: "Not contacted", [intro]: "Hi" });
    const noPrimary = row({ [s]: "Not contacted", [intro]: "Hi" });
    const noIntro = row({});
    const contacts = [row({ [primary]: CHECKED }, ready.id), row({ [primary]: CHECKED }, noIntro.id), row({}, noPrimary.id)];
    expect(f(contacts).test(ready)).toBe(false);
    expect(f(contacts).test(noPrimary)).toBe(true);
    expect(f(contacts).test(noIntro)).toBe(true);
  });

  test("once contacted, or dead, it is past sending", () => {
    expect(f([]).test(row({ [s]: "Contacted" }))).toBe(false);
    expect(f([]).test(row({ [s]: "Dead" }))).toBe(false);
  });
});

describe("missing enrichment", () => {
  test("a blank in an enrichment column, sources aside", () => {
    const schema = sheet(["Company"], ["Status"]);
    schema.columns.push({ key: "size", header: "Size", type: "text", origin: "enrichment" });
    schema.columns.push({ key: "src", header: "Enrichment sources", type: "longtext", origin: "enrichment" });
    const f = filterOf(schema, "unenriched")!;
    expect(f.test(row({ size: "50" }))).toBe(false);
    expect(f.test(row({}))).toBe(true);
    expect(f.test(row({ [schema.statusKey!]: "Dead" }))).toBe(false);
  });

  test("not offered before anything was enriched", () => {
    expect(filterOf(sheet(["Company"]), "unenriched")).toBeUndefined();
  });
});

describe("economic buyer", () => {
  test("contacts typed Economic Buyer, in any case", () => {
    const schema = sheet(["Company"]);
    const [f] = contactFilters(schema);
    const type = schema.contacts!.typeKey!;
    expect(f!.test(row({ [type]: "Economic Buyer" }))).toBe(true);
    expect(f!.test(row({ [type]: "economic buyer" }))).toBe(true);
    expect(f!.test(row({ [type]: "Champion" }))).toBe(false);
  });
});
