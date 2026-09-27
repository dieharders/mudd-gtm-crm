/**
 * The enrichment job engine.
 *
 * A run is a list of rows worked by a few parallel workers. Each row is one research turn on
 * the user's CLI. Pause lets the in-flight rows finish and starts no more; Stop aborts them.
 * An answer never overwrites a cell on its own: it becomes a SUGGESTION to accept or reject,
 * except with auto-fill on, which fills cells that are EMPTY and nothing else.
 */
import { domainAcceptsMail } from "./mx";
import { enrichRequest, introRequest } from "./prompts";
import * as store from "./store";
import { publish } from "./hub";
import { mergeSources, SOURCES_HEADER, type EnrichRun, type IntroOptions, type RunKind, type Source, type Suggestion } from "../../shared/ai";
import { sameValue } from "../../xlsx/cells";
import type { CampaignSchema, CellEdit, CellValue, Column } from "../../shared/types";
import { AiError, generateStructured } from "../ai";
import { getAiSettings } from "../ai/settings";
import * as db from "../db";

interface Controller {
  run: EnrichRun;
  abort: AbortController;
  resume: (() => void) | null;
}
const active = new Map<string, Controller>();
const MAX_RETRIES = 2;

const emit = (run: EnrichRun) => {
  store.saveRun(run);
  publish(run.campaignId, { type: "run", run: structuredClone(run) });
};

/** The shared "Enrichment sources" column, created the first time anything needs it. */
export function ensureSourcesColumn(campaignId: string): string {
  const c = db.getCampaign(campaignId)!;
  const existing = c.schema.columns.find((col) => col.header === SOURCES_HEADER);
  if (existing) return existing.key;
  const taken = new Set(c.schema.columns.map((col) => col.key));
  let key = "enrichment_sources";
  for (let i = 2; taken.has(key); i++) key = `enrichment_sources_${i}`;
  const schema: CampaignSchema = { ...c.schema, columns: [...c.schema.columns, { key, header: SOURCES_HEADER, type: "longtext", origin: "enrichment", width: 320 }] };
  db.updateCampaign(campaignId, { schema });
  return key;
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
  const ctrl: Controller = { run, abort: new AbortController(), resume: null };
  active.set(run.id, ctrl);
  emit(run);
  void pump(ctrl);
  return run;
}

export function pauseRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "running") return c?.run ?? store.getRun(id);
  c.run.status = "paused";
  emit(c.run);
  return c.run;
}

export function resumeRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c || c.run.status !== "paused") return c?.run ?? store.getRun(id);
  c.run.status = "running";
  emit(c.run);
  c.resume?.();
  c.resume = null;
  return c.run;
}

export function stopRun(id: string): EnrichRun | null {
  const c = active.get(id);
  if (!c) return store.getRun(id);
  c.run.status = "stopping";
  emit(c.run);
  c.abort.abort();
  c.resume?.();
  return c.run;
}

export function stopAllRuns(): void {
  for (const id of active.keys()) stopRun(id);
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
    emit(run);
  }
}

let lastStepEmit = 0;

async function processRow(ctrl: Controller, rowId: string): Promise<void> {
  const { run } = ctrl;
  const state = run.rows[rowId]!;
  const campaign = db.getCampaign(run.campaignId);
  const row = db.listRows(run.campaignId).find((r) => r.id === rowId);
  if (!campaign || !row) {
    state.state = "skipped";
    state.error = "Row was deleted.";
    emit(run);
    return;
  }
  state.state = "running";
  state.step = "Starting";
  emit(run);
  const onStep = (label: string) => {
    state.step = label;
    // Steps arrive in bursts; the page does not need every one.
    if (Date.now() - lastStepEmit > 400) {
      lastStepEmit = Date.now();
      emit(run);
    }
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const found = run.kind === "intro"
        ? await doIntro(run, campaign.schema, row.cells, rowId, ctrl.abort.signal, onStep)
        : await doEnrich(run, campaign.schema, row.cells, rowId, ctrl.abort.signal, onStep);
      state.state = "done";
      state.found = found;
      state.step = undefined;
      run.completed++;
      emit(run);
      return;
    } catch (err) {
      if (ctrl.abort.signal.aborted) {
        state.state = "skipped";
        state.step = undefined;
        emit(run);
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
        emit(run);
        return;
      }
      if (attempt < MAX_RETRIES) {
        state.step = `Retrying (${attempt + 1}/${MAX_RETRIES})`;
        emit(run);
        await Bun.sleep(attempt === 0 ? 3_000 : 8_000);
        continue;
      }
      console.error(`[enrich] row ${rowId} failed:`, err);
      state.state = "error";
      state.error = (err as Error).message;
      state.step = undefined;
      run.failed++;
      emit(run);
      return;
    }
  }
}

const EMPTY = /^(n\/?a|none|null|unknown|not found|-|—)$/i;

function normaliseValue(col: Column, raw: string | null): CellValue {
  if (raw === null) return null;
  const v = raw.trim();
  if (!v || EMPTY.test(v)) return null;
  if (col.type === "select" && col.options?.length) {
    const match = col.options.find((o) => o.toLowerCase() === v.toLowerCase());
    return match ?? null;
  }
  if (col.type === "number" || col.type === "currency") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && /^\D*[\d.,]+\D*$/.test(v) ? n : v;
  }
  return v;
}

function recordResults(
  run: EnrichRun,
  rowId: string,
  cells: Record<string, CellValue>,
  results: { col: Column; value: CellValue; sources: Source[]; confidence: Suggestion["confidence"]; note: string | null }[],
): number {
  const schema = db.getCampaign(run.campaignId)!.schema;
  const sourcesKey = schema.columns.find((c) => c.header === SOURCES_HEADER)?.key;
  const suggestions: Suggestion[] = [];
  const edits: CellEdit[] = [];
  let sourcesCell = sourcesKey ? (cells[sourcesKey] as string | null | undefined) ?? null : null;
  for (const r of results) {
    const current = cells[r.col.key] ?? null;
    if (r.value === null || sameValue(current, r.value)) continue;
    store.supersedePending(run.campaignId, rowId, r.col.key);
    const auto = run.autoFill && (current === null || current === "");
    suggestions.push({
      id: db.newId(),
      campaignId: run.campaignId,
      runId: run.id,
      rowId,
      key: r.col.key,
      value: r.value,
      previous: current,
      sources: r.sources,
      confidence: r.confidence,
      note: r.note,
      status: auto ? "auto" : "pending",
      createdAt: Date.now(),
    });
    if (auto) {
      edits.push({ rowId, key: r.col.key, value: r.value });
      if (sourcesKey && r.sources.length) sourcesCell = mergeSources(sourcesCell, r.col.header, r.sources);
    }
  }
  if (edits.length) {
    if (sourcesKey && sourcesCell !== (cells[sourcesKey] ?? null)) edits.push({ rowId, key: sourcesKey, value: sourcesCell });
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

async function doEnrich(run: EnrichRun, schema: CampaignSchema, cells: Record<string, CellValue>, rowId: string, signal: AbortSignal, onStep: (s: string) => void): Promise<number> {
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
  return recordResults(run, rowId, cells, results);
}

async function doIntro(run: EnrichRun, schema: CampaignSchema, cells: Record<string, CellValue>, rowId: string, signal: AbortSignal, onStep: (s: string) => void): Promise<number> {
  if (!schema.introKey) throw new Error("This campaign has no Intro message column.");
  const templates = db.listTemplates(run.campaignId);
  const choice = run.intro?.templateId ?? "auto";
  const req = introRequest(templates, choice, run.intro?.guidance, schema, cells, true);
  if (!req.templates.length) throw new Error("That template no longer exists.");
  const { data, costUsd } = await generateStructured({ ...req, webSearch: true, signal, onStep });
  if (costUsd !== null) run.costUsd = (run.costUsd ?? 0) + costUsd;
  const used = req.templates.find((t) => t.id === data.templateId) ?? req.templates[0]!;
  const col = schema.columns.find((c) => c.key === schema.introKey)!;
  const hooks = data.hooks.filter((h) => h.text);
  const note = [`Template: ${used.name}`, ...hooks.map((h) => `Hook: ${h.text}`)].join("\n");
  return recordResults(run, rowId, cells, [{
    col,
    value: data.message.trim(),
    sources: hooks.filter((h) => h.source).map((h) => ({ url: h.source!, title: h.text })),
    confidence: null,
    note,
  }]);
}
