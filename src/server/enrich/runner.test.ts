/**
 * The enrichment engine against a real SQLite file in a temp directory. Research turns are
 * faked where a test needs one; nothing here starts a CLI.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CampaignEvent, Suggestion } from "../../shared/ai";
import { genericSchema } from "../../shared/schema";
import { CHECKED, type CellValue } from "../../shared/types";
import * as ai from "../ai";
import * as db from "../db";
import { eventStream } from "./hub";
import { ensureSourcesColumn, liveRuns, normaliseValue, recentRuns, startRun } from "./runner";
import * as store from "./store";

// Module mocks outlive this file, so anything that isn't one of these tests gets the real turn.
const realAi = { ...ai };
let fakeTurn: ((req: ai.StructuredRequest<unknown>) => Promise<{ data: unknown; costUsd: number | null }>) | null = null;
void mock.module("../ai", () => ({
  ...realAi,
  generateStructured: (req: ai.StructuredRequest<unknown>) => (fakeTurn ? fakeTurn(req) : realAi.generateStructured(req)),
}));

let dir = "";
const prevDir = process.env.MUDD_DATA_DIR;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-runner-"));
  db.closeDb();
  process.env.MUDD_DATA_DIR = dir;
});
afterAll(() => {
  fakeTurn = null;
  db.closeDb();
  if (prevDir === undefined) delete process.env.MUDD_DATA_DIR;
  else process.env.MUDD_DATA_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const schema = genericSchema();
const k = (header: string) => schema.columns.find((c) => c.header === header)!.key;

function campaign(rows: { id: string; cells: Record<string, CellValue> }[]): string {
  const c = db.createCampaign({ name: "Test", schema, sheets: [] });
  db.insertRows(c.id, rows);
  return c.id;
}

const recipeFor = (campaignId: string) =>
  store.saveRecipe({ campaignId, name: "Find", instructions: "Find it.", inputKeys: [], webSearch: false, outputs: [{ key: k("Title"), header: "Title" }, { key: k("Location"), header: "Location" }] });

/** Read a campaign's event stream as the page would. */
function listen(campaignId: string, snapshot?: () => CampaignEvent[]) {
  const events: CampaignEvent[] = [];
  const reader = eventStream(campaignId, snapshot).body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as CampaignEvent);
      }
    }
  })();
  return { events, close: () => reader.cancel() };
}

async function until(check: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(2);
  }
}

describe("normaliseValue", () => {
  test("numbers are read the way the grid and export read them", () => {
    expect(normaliseValue({ type: "number" }, "1 200")).toBe(1200);
    expect(normaliseValue({ type: "currency" }, "$1,200.50")).toBe(1200.5);
    expect(normaliseValue({ type: "number" }, "-3")).toBe(-3);
    expect(normaliseValue({ type: "number" }, "about 40")).toBe("about 40");
  });
  test("an answer that says nothing is no answer", () => {
    for (const v of [null, "", "  ", "N/A", "unknown", "—", ",", "?"]) expect(normaliseValue({ type: "number" }, v)).toBeNull();
  });
  test("dropdowns take only their options; checkboxes are ticked or left alone", () => {
    expect(normaliseValue({ type: "select", options: ["Tier 1", "Tier 2"] }, "tier 2")).toBe("Tier 2");
    expect(normaliseValue({ type: "select", options: ["Tier 1"] }, "Tier 9")).toBeNull();
    expect(normaliseValue({ type: "checkbox" }, "Yes")).toBe(CHECKED);
    expect(normaliseValue({ type: "checkbox" }, "✓")).toBe(CHECKED);
    expect(normaliseValue({ type: "checkbox" }, "no")).toBeNull();
  });
});

describe("store", () => {
  test("a new finding replaces only the pending suggestion for the same cell", () => {
    const id = campaign([{ id: "r1", cells: {} }]);
    const s = (sid: string, key: string, status: Suggestion["status"]): Suggestion => ({
      id: sid, campaignId: id, runId: "x", rowId: "r1", key, value: "v", previous: null, sources: [], confidence: null, note: null, status, createdAt: 0,
    });
    store.insertSuggestions([s("a", "title", "pending"), s("b", "location", "pending"), s("c", "title", "accepted")]);
    store.supersedePending(id, "r1", "title");
    expect(store.listSuggestions(id).map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  test("the sources column never takes a key a deleted column left values under", () => {
    const id = campaign([{ id: "r1", cells: { enrichment_sources: "left by a deleted column" } }]);
    expect(ensureSourcesColumn(id)).toBe("enrichment_sources_2");
    expect(ensureSourcesColumn(id)).toBe("enrichment_sources_2");
  });
});

describe("runs", () => {
  test("deleted and screened-out rows are skipped without holding the event loop", async () => {
    const id = campaign([{ id: "out", cells: { [k("Company")]: "Acme", [schema.screenedKey!]: CHECKED } }]);
    const rowIds = ["out", ...Array.from({ length: 300 }, (_, i) => `gone${i}`)];
    const sse = listen(id);
    const saves = spyOn(store, "saveRun");
    const run = startRun({ campaignId: id, kind: "enrich", recipeId: recipeFor(id).id, rowIds, test: false, autoFill: false, concurrency: 2 });
    let midRun = null as boolean | null;
    setTimeout(() => (midRun = run.status === "running"), 0);
    await until(() => run.status === "done");
    expect(midRun).toBe(true);
    expect(run.rows.out).toEqual({ state: "skipped", error: "Screened out" });
    expect(run.rows.gone0).toEqual({ state: "skipped", error: "Row was deleted." });

    // Stored when it started and when it ended, not once per row; the end state in full.
    expect(saves.mock.calls.length).toBeLessThan(5);
    saves.mockRestore();
    expect(store.getRun(run.id)).toEqual(run);

    // The page: the whole run, then one event per row, then the whole run again.
    await until(() => sse.events.some((e) => e.type === "run" && e.run.status === "done"));
    void sse.close();
    const events = sse.events.filter((e) => e.type !== "ping");
    expect(events[0]).toMatchObject({ type: "run", run: { id: run.id, status: "running" } });
    expect(events.at(-1)).toMatchObject({ type: "run", run: { id: run.id, status: "done" } });
    const rows = events.slice(1, -1);
    expect(rows.every((e) => e.type === "runRow" && e.runId === run.id)).toBe(true);
    expect(rows).toHaveLength(rowIds.length);
  });

  test("findings are filed against the row as it is after the turn, not before it", async () => {
    const id = campaign([{ id: "r1", cells: { [k("Company")]: "Acme" } }]);
    const sourcesKey = ensureSourcesColumn(id);
    let joined: CampaignEvent[] = [];
    let listed: { live: string | undefined; stored: string | undefined } | null = null;
    fakeTurn = async () => {
      await Bun.sleep(0);
      // During the turn, the user types a title and another run files a source of its own.
      db.applyEdits(id, [{ rowId: "r1", key: k("Title"), value: "CEO" }, { rowId: "r1", key: sourcesKey, value: "Website: https://other.io" }]);
      // A page connecting now starts from the live run, this row mid-turn.
      const sse = listen(id, () => liveRuns(id).map((run): CampaignEvent => ({ type: "run", run })));
      await until(() => sse.events.length > 0);
      void sse.close();
      joined = sse.events;
      const runId = liveRuns(id)[0]!.id;
      listed = { live: recentRuns(id).find((r) => r.id === runId)?.rows.r1?.state, stored: store.getRun(runId)?.rows.r1?.state };
      return {
        data: { fields: { [k("Title")]: { value: "Founder", source: "https://a.io", confidence: "high" }, [k("Location")]: { value: "Austin", source: "https://b.io", confidence: "medium" } }, notes: null },
        costUsd: 0.01,
      };
    };
    const run = startRun({ campaignId: id, kind: "enrich", recipeId: recipeFor(id).id, rowIds: ["r1"], test: false, autoFill: true, concurrency: 1 });
    await until(() => run.status === "done");
    fakeTurn = null;

    expect(joined[0]).toMatchObject({ type: "run", run: { id: run.id, rows: { r1: { state: "running" } } } });
    // The run list shows the live run; its stored copy is only rewritten every few seconds.
    expect(listed!).toEqual({ live: "running", stored: "pending" });

    const cells = db.getRow(id, "r1")!.cells;
    expect(cells[k("Title")]).toBe("CEO");
    expect(cells[k("Location")]).toBe("Austin");
    expect(cells[sourcesKey]).toBe("Website: https://other.io\nLocation: https://b.io");
    const pending = store.listSuggestions(id, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ key: k("Title"), value: "Founder", previous: "CEO" });
    expect(run).toMatchObject({ completed: 1, suggestions: 1, autoFilled: 1, costUsd: 0.01 });
  });

  test("a row deleted during its turn is skipped, its findings dropped", async () => {
    const id = campaign([{ id: "r1", cells: { [k("Company")]: "Acme" } }]);
    fakeTurn = async () => {
      db.deleteRows(id, ["r1"]);
      return { data: { fields: { [k("Title")]: { value: "Founder", source: null, confidence: "low" } }, notes: null }, costUsd: null };
    };
    const run = startRun({ campaignId: id, kind: "enrich", recipeId: recipeFor(id).id, rowIds: ["r1"], test: false, autoFill: true, concurrency: 1 });
    await until(() => run.status === "done");
    fakeTurn = null;
    expect(run.rows.r1).toEqual({ state: "skipped", error: "Row was deleted." });
    expect(run.completed).toBe(0);
    expect(store.listSuggestions(id)).toHaveLength(0);
  });
});
