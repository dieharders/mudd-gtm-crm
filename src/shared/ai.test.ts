import { describe, expect, test } from "bun:test";
import { applyRunRow, type EnrichRun, type RunRowEvent } from "./ai";

const run = (id: string): EnrichRun => ({
  id, campaignId: "c", kind: "enrich", recipeId: "r", label: "Find", status: "running", test: false, provider: "claude",
  model: "sonnet", concurrency: 2, autoFill: false, rowIds: ["a", "b"], rows: { a: { state: "running", step: "Starting" }, b: { state: "pending" } },
  total: 2, completed: 0, failed: 0, suggestions: 0, autoFilled: 0, startedAt: 0, finishedAt: null, error: null, costUsd: null,
});

const done: RunRowEvent = {
  type: "runRow", runId: "y", rowId: "a", row: { state: "done", found: 2 },
  counts: { completed: 1, failed: 0, suggestions: 2, autoFilled: 0, costUsd: 0.02 },
};

describe("run row updates", () => {
  test("replace the one row and the totals, and copy only that run", () => {
    const runs = [run("x"), run("y")];
    const next = applyRunRow(runs, done);
    expect(next).not.toBe(runs);
    expect(next[0]).toBe(runs[0]!);
    expect(next[1]!.rows).toEqual({ a: { state: "done", found: 2 }, b: { state: "pending" } });
    expect(next[1]).toMatchObject({ status: "running", completed: 1, suggestions: 2, costUsd: 0.02 });
    // The state it came from is left as it was.
    expect(runs[1]!.rows.a).toEqual({ state: "running", step: "Starting" });
    expect(runs[1]!.completed).toBe(0);
  });
  test("a run the page doesn't have is ignored", () => {
    const runs = [run("x")];
    expect(applyRunRow(runs, done)).toBe(runs);
  });
});
