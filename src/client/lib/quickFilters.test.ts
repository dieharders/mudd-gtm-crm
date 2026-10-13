import { describe, expect, test } from "bun:test";
import type { EnrichRun, Recipe } from "../../shared/ai";
import { ensureAppColumns, makeKey } from "../../shared/schema";
import { CHECKED, stagesOf, type CampaignSchema, type CellValue, type ColumnType, type Row } from "../../shared/types";
import { contactFilters, prospectFilters, runsThrough, type FilterContext, type QuickFilterId } from "./quickFilters";

function sheet(...cols: [string, ColumnType?][]): CampaignSchema {
  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: cols.map(([header, type = "text"]) => ({ key: makeKey(header, taken), header, type, origin: "sheet" })) };
  ensureAppColumns(schema);
  return schema;
}
let n = 0;
const row = (cells: Record<string, CellValue>, parentId?: string): Row => ({ id: `r${++n}`, position: n, cells, ...(parentId ? { parentId } : {}) });
const TODAY = "2026-10-11";

function filterOf(schema: CampaignSchema, id: QuickFilterId, { contacts = [], recipes = [], ran = () => false, today = TODAY }: {
  contacts?: Row[]; recipes?: Recipe[]; ran?: FilterContext["ran"]; today?: string;
} = {}) {
  const f = prospectFilters(schema, stagesOf(schema), recipes, today).find((x) => x.id === id);
  const ctx: FilterContext = { contactsOf: (pid) => contacts.filter((c) => c.parentId === pid), ran };
  return f && { ...f, test: (r: Row) => f.test(r, ctx) };
}

const recipe = (id: string, ...keys: string[]): Recipe => ({
  id, campaignId: "c", name: id, instructions: "", inputKeys: [], outputs: keys.map((key) => ({ key, header: key })), webSearch: false, createdAt: 0, updatedAt: 0,
});

describe("needs follow-up", () => {
  const schema = sheet(["Company"], ["Status"]);
  const sent = schema.contacts!.lastContactedKey!;
  const reply = schema.contacts!.lastReplyKey!;
  /** A prospect at `status` with a contact for each set of cells, and the filter's verdict. */
  const check = (status: string, people: Record<string, CellValue>[], opts: { today?: string; cells?: Record<string, CellValue>; of?: CampaignSchema } = {}) => {
    const of = opts.of ?? schema;
    const org = row({ [of.statusKey!]: status, ...opts.cells });
    return filterOf(of, "followUp", { contacts: people.map((c) => row(c, org.id)), today: opts.today })!.test(org);
  };

  test("contacted a week or more ago, with no reply", () => {
    expect(check("Contacted", [{ [sent]: "2026-10-04" }])).toBe(true);
    expect(check("contacted", [{ [sent]: "2026-09-01" }])).toBe(true);
    expect(check("Contacted", [{ [sent]: "2026-10-05" }])).toBe(false);
  });

  test("the latest contact across the people counts", () => {
    expect(check("Contacted", [{ [sent]: "2026-09-01" }, { [sent]: "2026-10-10" }])).toBe(false);
  });

  test("a reply since the last contact, another stage, or a screened-out prospect is no follow-up", () => {
    expect(check("Contacted", [{ [sent]: "2026-09-01", [reply]: "2026-09-03" }])).toBe(false);
    expect(check("Contacted", [{ [sent]: "2026-09-01" }, { [reply]: "2026-09-01" }])).toBe(false);
    expect(check("Replied", [{ [sent]: "2026-09-01" }])).toBe(false);
    expect(check("Contacted", [{ [sent]: "2026-09-01" }], { cells: { [schema.screenedKey!]: CHECKED } })).toBe(false);
  });

  test("a reply older than the last contact is chased again", () => {
    expect(check("Contacted", [{ [sent]: "2026-09-10", [reply]: "2026-09-03" }])).toBe(true);
  });

  test("contacted but never dated is chased, with or without people", () => {
    expect(check("Contacted", [])).toBe(true);
    expect(check("Contacted", [{}])).toBe(true);
  });

  test("a date it can't read is not taken for never dated", () => {
    expect(check("Contacted", [{ [sent]: "10/10/2026" }])).toBe(false);
  });

  test("a datetime counts by its day, not its hour", () => {
    expect(check("Contacted", [{ [sent]: "2026-10-04T15:00" }])).toBe(true);
    expect(check("Contacted", [{ [sent]: "2026-10-05T09:00" }])).toBe(false);
  });

  test("the week counts back from the day given", () => {
    expect(check("Contacted", [{ [sent]: "2026-10-05" }], { today: "2026-10-12" })).toBe(true);
  });

  test("not offered without a Status column", () => {
    const none: CampaignSchema = { columns: [], contacts: { columns: [], lastContactedKey: "x" } };
    expect(prospectFilters(none, ["Not contacted", "Contacted"], [], TODAY).find((f) => f.id === "followUp")).toBeUndefined();
  });
});

describe("not ready to send", () => {
  const schema = sheet(["Company"], ["Status"], ["Intro", "longtext"]);
  const s = schema.statusKey!;
  const intro = schema.introKey!;

  test("a prospect not yet contacted that lacks an intro or anyone to address", () => {
    const ready = row({ [s]: "Not contacted", [intro]: "Hi" });
    const nobody = row({ [s]: "Not contacted", [intro]: "Hi" });
    const noIntro = row({});
    const contacts = [row({}, ready.id), row({}, noIntro.id)];
    const f = filterOf(schema, "notReady", { contacts })!;
    expect(f.test(ready)).toBe(false);
    expect(f.test(nobody)).toBe(true);
    expect(f.test(noIntro)).toBe(true);
  });

  test("a contact without the Primary tick is still someone to address", () => {
    const p = row({ [s]: "Not contacted", [intro]: "Hi" });
    expect(filterOf(schema, "notReady", { contacts: [row({ [schema.contacts!.primaryKey!]: null }, p.id)] })!.test(p)).toBe(false);
  });

  test("once contacted, or dead, it is past sending", () => {
    const f = filterOf(schema, "notReady")!;
    expect(f.test(row({ [s]: "Contacted" }))).toBe(false);
    expect(f.test(row({ [s]: "Dead" }))).toBe(false);
  });
});

describe("missing enrichment", () => {
  const schema = sheet(["Company"], ["Status"]);
  schema.columns.push({ key: "size", header: "Size", type: "text", origin: "enrichment" });
  schema.columns.push({ key: "hiring", header: "Hiring?", type: "checkbox", origin: "enrichment" });
  schema.columns.push({ key: "src", header: "Enrichment sources", type: "longtext", origin: "enrichment" });
  const recipes = [recipe("firmo", "size", "hiring", "src")];

  test("a recipe with none of its columns filled", () => {
    const f = filterOf(schema, "unenriched", { recipes })!;
    expect(f.test(row({}))).toBe(true);
    expect(f.test(row({ src: "Size: https://example.com" }))).toBe(true);
    expect(f.test(row({ size: "50" }))).toBe(false);
    expect(f.test(row({ hiring: CHECKED }))).toBe(false);
    expect(f.test(row({ [schema.statusKey!]: "Dead" }))).toBe(false);
  });

  test("a row a run of the recipe finished is done, blanks and unticked boxes included", () => {
    const done = row({});
    const f = filterOf(schema, "unenriched", { recipes, ran: (recipeId, rowId) => recipeId === "firmo" && rowId === done.id })!;
    expect(f.test(done)).toBe(false);
    expect(f.test(row({}))).toBe(true);
  });

  test("not offered without a recipe filling a prospect column", () => {
    expect(filterOf(schema, "unenriched")).toBeUndefined();
    expect(filterOf(schema, "unenriched", { recipes: [recipe("people", "nowhere")] })).toBeUndefined();
  });
});

describe("runsThrough", () => {
  test("the rows each recipe's runs finished", () => {
    const run = (recipeId: string | null, kind: "enrich" | "intro", rows: EnrichRun["rows"]) => ({ recipeId, kind, rows }) as EnrichRun;
    const ran = runsThrough([
      run("a", "enrich", { r1: { state: "done" }, r2: { state: "error" }, r3: { state: "pending" } }),
      run("a", "enrich", { r2: { state: "done" } }),
      run(null, "intro", { r4: { state: "done" } }),
    ]);
    expect(ran("a", "r1")).toBe(true);
    expect(ran("a", "r2")).toBe(true);
    expect(ran("a", "r3")).toBe(false);
    expect(ran("b", "r1")).toBe(false);
  });

  test("and those of older runs the server kept, no longer among the runs listed", () => {
    const ran = runsThrough([], new Map([["a", new Set(["r1"])]]));
    expect(ran("a", "r1")).toBe(true);
    expect(ran("a", "r2")).toBe(false);
    expect(ran("b", "r1")).toBe(false);
  });
});

describe("economic buyer", () => {
  test("contacts typed Economic Buyer, in any case", () => {
    const schema = sheet(["Company"]);
    const [f] = contactFilters(schema);
    const type = schema.contacts!.typeKey!;
    const ctx: FilterContext = { contactsOf: () => [], ran: () => false };
    expect(f!.test(row({ [type]: "Economic Buyer" }), ctx)).toBe(true);
    expect(f!.test(row({ [type]: "economic buyer" }), ctx)).toBe(true);
    expect(f!.test(row({ [type]: "Champion" }), ctx)).toBe(false);
  });
});
