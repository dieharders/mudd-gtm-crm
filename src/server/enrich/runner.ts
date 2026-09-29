/**
 * The enrichment job engine.
 *
 * A run is a list of prospects worked by a few parallel workers. Each is one research turn on
 * the user's CLI, which sees the prospect with its primary contact. Pause lets the in-flight
 * turns finish and starts no more; Stop aborts them.
 * An answer never overwrites a cell on its own: it becomes a SUGGESTION to accept or reject,
 * except with auto-fill on, which fills cells that are EMPTY and nothing else. A finding for a
 * contact column is the primary contact's; a prospect with no contact gets one to hold it.
 *
 * A run document holds every row, so nothing sends or stores it whole per row (that is
 * quadratic in the run's size). The page gets the whole run when it starts, changes status
 * and ends, and just the changed row in between. The stored copy is rewritten on those same
 * status changes and every few seconds while rows change; it only matters after a crash, as
 * everything else reads the live run.
 */
import { domainAcceptsMail } from "./mx";
import { enrichRequest, introRequest } from "./prompts";
import * as store from "./store";
import { publish } from "./hub";
import { mergeSources, SOURCES_HEADER, sourcesColumn, type EnrichRun, type IntroOptions, type RunKind, type Source, type Suggestion } from "../../shared/ai";
import { allColumns, columnOf, isContactKey, makeKey } from "../../shared/schema";
import { CHECKED, isScreened, type CampaignSchema, type CellEdit, type CellValue, type Column, type Row } from "../../shared/types";
import { parseFlag, prospectCells, sameValue, toNumber } from "../../shared/values";
import { AiError, generateStructured } from "../ai";
import { getAiSettings } from "../ai/settings";
import * as db from "../db";

interface Controller {
  run: EnrichRun;
  abort: AbortController;
  resume: (() => void) | null;
  /** When the run was last stored, and the save waiting to follow it. */
  savedAt: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /** When a step last went to the page. */
  stepAt: number;
}
const active = new Map<string, Controller>();
const MAX_RETRIES = 2;

// Every 2 s, and less often for big runs, whose document is big: at 5k rows, every 50 s.
const saveEvery = (run: EnrichRun) => Math.max(2_000, run.total * 10);

function save(ctrl: Controller): void {
  if (ctrl.saveTimer) clearTimeout(ctrl.saveTimer);
  ctrl.saveTimer = null;
  ctrl.savedAt = Date.now();
  store.saveRun(ctrl.run);
}

/** Store the run at most once per `saveEvery`, the last change included. */
function saveSoon(ctrl: Controller): void {
  if (ctrl.saveTimer) return;
  const wait = ctrl.savedAt + saveEvery(ctrl.run) - Date.now();
  if (wait <= 0) return save(ctrl);
  ctrl.saveTimer = setTimeout(() => {
    try {
      save(ctrl);
    } catch (err) {
      console.error("[enrich] could not save run progress:", err);
    }
  }, wait);
}

/** The whole run, stored now and sent to the page: on start, on a status change, at the end. */
function emitRun(ctrl: Controller): void {
  save(ctrl);
  publish(ctrl.run.campaignId, { type: "run", run: ctrl.run });
}

/** One row changed: the page gets that row and the totals, the store gets it soon. */
function emitRow(ctrl: Controller, rowId: string): void {
  const { run } = ctrl;
  const { completed, failed, suggestions, autoFilled, costUsd } = run;
  publish(run.campaignId, { type: "runRow", runId: run.id, rowId, row: run.rows[rowId]!, counts: { completed, failed, suggestions, autoFilled, costUsd } });
  saveSoon(ctrl);
}

/** The shared "Enrichment sources" column, created the first time anything needs it. */
export function ensureSourcesColumn(campaignId: string): string {
  const c = db.getCampaign(campaignId)!;
  const existing = sourcesColumn(c.schema);
  if (existing) return existing.key;
  // Not a key a deleted column left values under: the new column would show them.
  const taken = new Set([...allColumns(c.schema).map((col) => col.key), ...db.allCellKeys(campaignId)]);
  const key = makeKey("enrichment_sources", taken);
  const schema: CampaignSchema = { ...c.schema, columns: [...c.schema.columns, { key, header: SOURCES_HEADER, type: "longtext", origin: "enrichment", width: 320 }] };
  db.updateCampaign(campaignId, { schema });
  return key;
}

/** The campaign's recent runs, a live one as it is now (its stored copy lags). */
export function recentRuns(campaignId: string): EnrichRun[] {
  return store.listRuns(campaignId).map((r) => active.get(r.id)?.run ?? r);
}

/** The campaign's runs still going, as they are now. */
export function liveRuns(campaignId: string): EnrichRun[] {
  return [...active.values()].filter((c) => c.run.campaignId === campaignId).map((c) => c.run);
}

export interface StartRunInput {
  campaignId: string;
  kind: RunKind;
  recipeId?: string | null;
  rowIds: string[];
  test: boolean;
  autoFill: boolean;
  concurrency: number;
  intro?: IntroOptions;
}

export function startRun(input: StartRunInput): EnrichRun {
  const settings = getAiSettings();
  const recipe = input.recipeId ? store.getRecipe(input.recipeId) : null;
  if (input.kind === "enrich" && !recipe) throw new Error("That recipe no longer exists.");
  if (input.kind === "intro" && !db.listTemplates(input.campaignId).length) throw new Error("Add an intro template first: the AI writes from your templates.");
  const rowIds = [...new Set(input.rowIds)];
  if (!rowIds.length) throw new Error("No rows to run on.");
  if (input.kind === "enrich") ensureSourcesColumn(input.campaignId);
  const run: EnrichRun = {
    id: db.newId(),
    campaignId: input.campaignId,
    kind: input.kind,
    recipeId: recipe?.id ?? null,
    label: input.kind === "intro" ? "Intro messages" : recipe!.name,
    status: "running",
    test: input.test,
    provider: settings.provider,
    model: settings.model[settings.provider]!,
    concurrency: Math.max(1, Math.min(4, Math.round(input.concurrency) || 2)),
    autoFill: input.autoFill,
    rowIds,
    rows: Object.fromEntries(rowIds.map((id) => [id, { state: "pending" as const }])),
    total: rowIds.length,
    completed: 0,
    failed: 0,
    suggestions: 0,
    autoFilled: 0,
    intro: input.intro,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    costUsd: null,
  };
  const ctrl: Controller = { run, abort: new AbortController(), resume: null, savedAt: 0, saveTimer: null, stepAt: 0 };
  active.set(run.id, ctrl);
  emitRun(ctrl);
  void pump(ctrl);
  return run;
}

export function pauseRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "running") return c?.run ?? store.getRun(id);
  c.run.status = "paused";
  emitRun(c);
  return c.run;
}

export function resumeRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "paused") return c?.run ?? store.getRun(id);
  c.run.status = "running";
  emitRun(c);
  c.resume?.();
  c.resume = null;
  return c.run;
}

export function stopRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c) return store.getRun(id);
  c.run.status = "stopping";
  emitRun(c);
  c.abort.abort();
  c.resume?.();
  return c.run;
}

export function stopAllRuns(): void {
  for (const id of active.keys()) stopRun(id);
}

/** Stop a campaign's live runs: before it is removed, so no turn files findings into nothing. */
export function stopCampaignRuns(campaignId: string): void {
  for (const c of active.values()) if (c.run.campaignId === campaignId) stopRun(c.run.id);
}

async function pump(ctrl: Controller): Promise<void> {
  const { run } = ctrl;
  const queue = [...run.rowIds];
  const worker = async () => {
    for (;;) {
      while (run.status === "paused") await new Promise<void>((r) => (ctrl.resume = r));
      if (ctrl.abort.signal.aborted || run.status === "failed") return;
      const rowId = queue.shift();
      if (!rowId) return;
      await processRow(ctrl, rowId);
    }
  };
  try {
    await Promise.all(Array.from({ length: run.concurrency }, worker));
  } finally {
    for (const r of Object.values(run.rows)) if (r.state === "pending" || r.state === "running") r.state = "skipped";
    if (run.status !== "failed") run.status = ctrl.abort.signal.aborted ? "stopped" : "done";
    run.finishedAt = Date.now();
    active.delete(run.id);
    emitRun(ctrl);
  }
}

async function processRow(ctrl: Controller, rowId: string): Promise<void> {
  const { run } = ctrl;
  const state = run.rows[rowId]!;
  const campaign = db.getCampaign(run.campaignId);
  const found = campaign ? db.getRow(run.campaignId, rowId) : null;
  // Runs are on prospects; a contact is researched as part of its prospect.
  const row = found?.parentId ? null : found;
  if (!campaign || !row || isScreened(row, campaign.schema)) {
    state.state = "skipped";
    state.error = found?.parentId ? "Not a prospect." : row ? "Screened out" : "Row was deleted.";
    emitRow(ctrl, rowId);
    // Nothing above waits, so a long stretch of such rows would hold the event loop (no
    // request answered, no event sent) until it ends. Let everything else in between each.
    await Bun.sleep(0);
    return;
  }
  state.state = "running";
  state.step = "Starting";
  emitRow(ctrl, rowId);
  const onStep = (label: string) => {
    state.step = label;
    // Steps arrive in bursts; the page does not need every one.
    if (Date.now() - ctrl.stepAt > 400) {
      ctrl.stepAt = Date.now();
      emitRow(ctrl, rowId);
    }
  };

  // The prospect as the turn sees it: with its primary contact, whom intros address.
  const cells = prospectCells(row, db.primaryContact(run.campaignId, rowId, campaign.schema));
  for (let attempt = 0; ; attempt++) {
    try {
      const found = run.kind === "intro"
        ? await doIntro(run, campaign.schema, cells, rowId, ctrl.abort.signal, onStep)
        : await doEnrich(run, campaign.schema, cells, rowId, ctrl.abort.signal, onStep);
      state.step = undefined;
      if (found === null) {
        // Deleted while the turn ran: its findings have nowhere to go.
        state.state = "skipped";
        state.error = "Row was deleted.";
      } else {
        state.state = "done";
        state.found = found;
        run.completed++;
      }
      emitRow(ctrl, rowId);
      return;
    } catch (err) {
      if (ctrl.abort.signal.aborted) {
        state.state = "skipped";
        state.step = undefined;
        emitRow(ctrl, rowId);
        return;
      }
      const code = err instanceof AiError ? err.code : "cli_failed";
      // No point retrying a missing or signed-out CLI: every other row would fail the same way.
      if (code === "cli_missing" || code === "not_authenticated") {
        state.state = "error";
        state.error = (err as Error).message;
        run.failed++;
        run.status = "failed";
        run.error = (err as Error).message;
        ctrl.abort.abort();
        emitRun(ctrl);
        return;
      }
      if (attempt < MAX_RETRIES) {
        state.step = `Retrying (${attempt + 1}/${MAX_RETRIES})`;
        emitRow(ctrl, rowId);
        await Bun.sleep(attempt === 0 ? 3_000 : 8_000);
        continue;
      }
      console.error(`[enrich] row ${rowId} failed:`, err);
      state.state = "error";
      state.error = (err as Error).message;
      state.step = undefined;
      run.failed++;
      emitRow(ctrl, rowId);
      return;
    }
  }
}

const EMPTY = /^(n\/?a|none|null|unknown|not found|-|—)$/i;

/** A found value as the column stores it; null when it amounts to "nothing found". */
export function normaliseValue(col: Pick<Column, "type" | "options">, raw: string | null): CellValue {
  if (raw === null) return null;
  const v = raw.trim();
  if (!v || EMPTY.test(v)) return null;
  if (col.type === "checkbox") return parseFlag(v) ? CHECKED : null;
  // No letter or digit at all ("," or "?") is no answer either.
  if (!/[\p{L}\p{N}]/u.test(v)) return null;
  if (col.type === "select" && col.options?.length) {
    const match = col.options.find((o) => o.toLowerCase() === v.toLowerCase());
    return match ?? null;
  }
  // Read as the grid and export read numbers: "$1,200" and "1 200" are 1200.
  if (col.type === "number" || col.type === "currency") return toNumber(v) ?? v;
  return v;
}

/**
 * File one prospect's findings. It is read again first, with its primary contact: the turn took
 * seconds, in which the user may have typed into a cell auto-fill would fill, or another run
 * may have added its own sources. A contact column's finding goes on the primary contact, which
 * is created (ticked Primary) when the prospect has none; the sources always go on the
 * prospect. Null when the prospect is gone.
 */
function recordResults(
  run: EnrichRun,
  rowId: string,
  results: { col: Column; value: CellValue; sources: Source[]; confidence: Suggestion["confidence"]; note: string | null }[],
): number | null {
  const schema = db.getCampaign(run.campaignId)?.schema;
  const row = schema ? db.getRow(run.campaignId, rowId) : null;
  if (!schema || !row) return null;
  const { cells } = row;
  let primary = db.primaryContact(run.campaignId, rowId, schema);
  const created: Row[] = [];
  const sourcesKey = sourcesColumn(schema)?.key;
  const suggestions: Suggestion[] = [];
  const edits: CellEdit[] = [];
  const sourcesBefore = sourcesKey ? cells[sourcesKey] ?? null : null;
  let sourcesCell = sourcesBefore === null ? null : String(sourcesBefore);
  for (const r of results) {
    // The column as it is now: it may have been deleted or renamed during the turn.
    const col = columnOf(schema, r.col.key);
    if (!col || r.value === null) continue;
    const forContact = isContactKey(schema, col.key);
    if (forContact && !primary) {
      const primaryKey = schema.contacts?.primaryKey;
      primary = db.insertRows(run.campaignId, [{ parentId: rowId, cells: primaryKey ? { [primaryKey]: CHECKED } : {} }])[0]!;
      created.push(primary);
    }
    const target = forContact ? primary! : row;
    const current = target.cells[col.key] ?? null;
    if (sameValue(current, r.value)) continue;
    store.supersedePending(run.campaignId, target.id, col.key);
    const auto = run.autoFill && (current === null || current === "");
    suggestions.push({
      id: db.newId(),
      campaignId: run.campaignId,
      runId: run.id,
      rowId: target.id,
      key: col.key,
      value: r.value,
      previous: current,
      sources: r.sources,
      confidence: r.confidence,
      note: r.note,
      status: auto ? "auto" : "pending",
      createdAt: Date.now(),
    });
    if (auto) {
      edits.push({ rowId: target.id, key: col.key, value: r.value });
      if (sourcesKey && r.sources.length) sourcesCell = mergeSources(sourcesCell, col.header, r.sources);
    }
  }
  // Before the cells and suggestions that point at it.
  if (created.length) publish(run.campaignId, { type: "rows", rows: created });
  if (edits.length) {
    if (sourcesKey && !sameValue(sourcesCell, sourcesBefore)) edits.push({ rowId, key: sourcesKey, value: sourcesCell });
    db.applyEdits(run.campaignId, edits);
    run.autoFilled += suggestions.filter((s) => s.status === "auto").length;
    publish(run.campaignId, { type: "cells", edits });
  }
  if (suggestions.length) {
    store.insertSuggestions(suggestions);
    run.suggestions += suggestions.filter((s) => s.status === "pending").length;
    publish(run.campaignId, { type: "suggestions", suggestions });
  }
  return suggestions.length;
}

async function doEnrich(run: EnrichRun, schema: CampaignSchema, cells: Record<string, CellValue>, rowId: string, signal: AbortSignal, onStep: (s: string) => void): Promise<number | null> {
  const recipe = store.getRecipe(run.recipeId!);
  if (!recipe) throw new Error("That recipe no longer exists.");
  const req = enrichRequest(recipe, schema, cells);
  if (!req.columns.length) throw new Error("This recipe's output columns were deleted.");
  const { data, costUsd } = await generateStructured({ ...req, webSearch: recipe.webSearch, signal, onStep });
  if (costUsd !== null) run.costUsd = (run.costUsd ?? 0) + costUsd;
  const results = [];
  for (const col of req.columns) {
    const f = data.fields[col.key];
    if (!f) continue;
    const value = normaliseValue(col, f.value);
    if (value === null) continue;
    let note: string | null = null;
    if (col.type === "email" && typeof value === "string") {
      onStep("Checking the email domain");
      const ok = await domainAcceptsMail(value);
      note = ok === false ? "The email's domain has no mail server: probably wrong." : ok ? "Domain accepts email." : null;
    }
    results.push({ col, value, sources: f.source ? [{ url: f.source }] : [], confidence: f.confidence, note });
  }
  // The model's general remark about the row goes on one suggestion, not repeated on all.
  if (data.notes && results[0]) results[0].note = [results[0].note, data.notes].filter(Boolean).join(" · ");
  return recordResults(run, rowId, results);
}

async function doIntro(run: EnrichRun, schema: CampaignSchema, cells: Record<string, CellValue>, rowId: string, signal: AbortSignal, onStep: (s: string) => void): Promise<number | null> {
  if (!schema.introKey) throw new Error("This campaign has no Intro message column.");
  const templates = db.listTemplates(run.campaignId);
  const choice = run.intro?.templateId ?? "auto";
  const sourceOf = (key: string) => store.sourceOfValue(run.campaignId, rowId, key, cells[key] ?? null);
  const req = introRequest(templates, choice, run.intro?.guidance, schema, cells, true, sourceOf);
  if (!req.templates.length) throw new Error("That template no longer exists.");
  const { data, costUsd } = await generateStructured({ ...req, webSearch: true, signal, onStep });
  if (costUsd !== null) run.costUsd = (run.costUsd ?? 0) + costUsd;
  const used = req.templates.find((t) => t.id === data.templateId) ?? req.templates[0]!;
  const col = schema.columns.find((c) => c.key === schema.introKey)!;
  // One line each: the note lists them by line, and the page matches each to its source by text.
  const hooks = data.hooks.map((h) => ({ ...h, text: h.text.replace(/\s+/g, " ").trim() })).filter((h) => h.text);
  const note = [`Template: ${used.name}`, ...hooks.map((h) => `Hook: ${h.text}`)].join("\n");
  return recordResults(run, rowId, [{
    col,
    value: data.message.trim(),
    sources: hooks.filter((h) => h.source).map((h) => ({ url: h.source!, title: h.text })),
    confidence: null,
    note,
  }]);
}
