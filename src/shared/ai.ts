/**
 * AI provider and enrichment types shared by the server and the page.
 *
 * Mudd never holds an API key. It drives the user's own signed-in agent CLI — Claude Code or
 * Codex — so enrichment bills the user's plan.
 */
import { isContactKey } from "./schema";
import type { Candidate, DiscoveryRun } from "./sourcing";
import type { Campaign, CampaignSchema, CellValue, Column, ColumnType, Row, Thesis } from "./types";

export type ProviderId = "claude" | "codex";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex"];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  vendor: string;
  plan: string;
  models: { value: string; label: string }[];
  efforts: string[];
  /** The CLI's own sign-in and sign-out subcommands. */
  loginArgs: string[];
  logoutArgs: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    plan: "Claude Pro or Max",
    models: [
      { value: "sonnet", label: "Sonnet (fast, recommended)" },
      { value: "opus", label: "Opus (deepest research)" },
      { value: "haiku", label: "Haiku (quickest)" },
      { value: "default", label: "Claude Code default" },
    ],
    efforts: ["low", "medium", "high"],
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
  },
  codex: {
    id: "codex",
    label: "Codex",
    vendor: "OpenAI",
    plan: "ChatGPT Plus, Pro or Business",
    models: [{ value: "default", label: "Codex default" }],
    efforts: ["low", "medium", "high"],
    loginArgs: ["login"],
    logoutArgs: ["logout"],
  },
};

export interface ProviderAuth {
  state: "ok" | "logged_out" | "cli_missing" | "unknown";
  plan: string | null;
  account: string | null;
  /** True when a subscription is billed; false for per-token API-key billing. */
  subscription: boolean;
  keySource?: string | null;
}

export interface ProviderStatus {
  id: ProviderId;
  installed: boolean;
  path: string | null;
  version: string | null;
  outdated: string | null;
  auth: ProviderAuth;
}

/**
 * Server → page while installing a CLI or signing in, over the request's own event stream.
 * `url` says the sign-in page can be reopened.
 */
export type SetupEvent =
  | { type: "log"; line: string }
  | { type: "url" }
  | { type: "done"; ok: boolean; message: string };

export interface AiSettings {
  /** Null until the user picks one in AI settings: Mudd doesn't choose a vendor for them. */
  provider: ProviderId | null;
  model: Record<ProviderId, string>;
  effort: Record<ProviderId, string>;
  /** The user has agreed that enrichment sends row data to their provider. */
  consented: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: null,
  model: { claude: "sonnet", codex: "default" },
  effort: { claude: "low", codex: "low" },
  consented: false,
};

// ---------- enrichment ----------

export interface RecipeOutput {
  /** The column this output fills. */
  key: string;
  header: string;
  /** Extra guidance for this one field ("only a published email, never a guess"). */
  hint?: string;
}

/**
 * Who a recipe researches. A recipe that fills in people's details (an email, a LinkedIn) runs
 * once per contact, each finding going on that contact. One that finds a person (it fills the
 * contact name) runs once per prospect: several turns would each find the same person. So does
 * one that fills only the prospect's columns. `contact` marks a new column among the contacts'.
 */
export function recipeMode(outputs: { key?: string; contact?: boolean }[], schema: CampaignSchema): "prospects" | "contacts" {
  const people = outputs.filter((o) => o.contact || (o.key && isContactKey(schema, o.key)));
  if (!people.length || people.some((o) => o.key && o.key === schema.contacts?.nameKey)) return "prospects";
  return "contacts";
}

export interface Recipe {
  id: string;
  campaignId: string;
  name: string;
  instructions: string;
  inputKeys: string[];
  outputs: RecipeOutput[];
  webSearch: boolean;
  /** The preset this recipe was made from, so Discovery can reuse it rather than make another. */
  presetId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A recipe as the page sends it to be created or updated. */
export interface RecipeDraft {
  name: string;
  instructions: string;
  inputKeys: string[];
  /** `contact`: a new column is created among the contact columns (a person's detail). */
  outputs: (Partial<RecipeOutput> & { header: string; type?: ColumnType; options?: string[]; contact?: boolean })[];
  webSearch: boolean;
  presetId?: string;
}

export type RunKind = "enrich" | "intro";
export type RunStatus = "running" | "paused" | "stopping" | "stopped" | "done" | "failed";
export type RowRunState = "pending" | "running" | "done" | "error" | "skipped";

/** A run still going: one the page shows as live and offers to pause or stop. */
export const isLiveStatus = (s: RunStatus): boolean => s === "running" || s === "paused" || s === "stopping";

/** The run list's order: the newest first. */
export const newestFirst = <T extends { startedAt: number }>(a: T, b: T): number => b.startedAt - a.startedAt;

/**
 * Take a run a request returned, unless it is live and the stream already brought it: the
 * stream's copy of a live run is the newest the page has (see the module comment in
 * useEnrichment), and replacing it would undo the updates that arrived in between.
 */
export function withRun<T extends { id: string; status: RunStatus; startedAt: number }>(runs: T[], run: T): T[] {
  if (isLiveStatus(run.status) && runs.some((r) => r.id === run.id)) return runs;
  return [run, ...runs.filter((r) => r.id !== run.id)].sort(newestFirst);
}

export interface RunRow {
  state: RowRunState;
  error?: string;
  /** What the agent is doing right now, e.g. "Searching the web". */
  step?: string;
  found?: number;
}

export interface IntroOptions {
  /** A template id, or "auto" to let the model pick the best fit. */
  templateId: string;
  /** Anything extra to steer the draft ("mention our Atlanta visit"). */
  guidance?: string;
}

export interface EnrichRun {
  id: string;
  campaignId: string;
  kind: RunKind;
  recipeId: string | null;
  label: string;
  status: RunStatus;
  test: boolean;
  provider: ProviderId;
  model: string;
  concurrency: number;
  autoFill: boolean;
  rowIds: string[];
  rows: Record<string, RunRow>;
  total: number;
  completed: number;
  failed: number;
  suggestions: number;
  autoFilled: number;
  intro?: IntroOptions;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  costUsd: number | null;
}

export interface Source {
  url: string;
  title?: string;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected" | "auto";

export interface Suggestion {
  id: string;
  campaignId: string;
  runId: string;
  rowId: string;
  key: string;
  value: CellValue;
  previous: CellValue;
  sources: Source[];
  confidence: "high" | "medium" | "low" | null;
  note: string | null;
  status: SuggestionStatus;
  createdAt: number;
}

/** A run's totals, sent with every row update. */
export type RunCounts = Pick<EnrichRun, "completed" | "failed" | "suggestions" | "autoFilled" | "costUsd">;

/** One row of a live run changed state or step. Carries the totals, which that may have moved. */
export interface RunRowEvent {
  type: "runRow";
  runId: string;
  rowId: string;
  row: RunRow;
  counts: RunCounts;
}

/**
 * Server → page, over the campaign's event stream. A run goes whole (`run`) when the page
 * connects, when the run starts, when its status changes and when it ends; in between, only
 * the row that changed (`runRow`). Sending the whole run per row was quadratic in its size.
 */
export type CampaignEvent =
  | { type: "run"; run: EnrichRun }
  | RunRowEvent
  | { type: "suggestions"; suggestions: Suggestion[] }
  | { type: "cells"; edits: { rowId: string; key: string; value: CellValue }[] }
  /** Rows the server added (a run's first contact for a prospect that had none). */
  | { type: "rows"; rows: Row[] }
  /** The campaign changed on the server (a recipe or Discovery added columns): take it as it is. */
  | { type: "campaign"; campaign: Campaign }
  /** The campaign's recipes, whole, after the server made, changed or removed one. */
  | { type: "recipes"; recipes: Recipe[] }
  /** A Discovery run, whole: it is small (angles and per-company steps), so it goes whole, at most one every 400 ms. */
  | { type: "discovery"; run: DiscoveryRun }
  /** Candidates made or changed by a Discovery run, or by accepting and dismissing. */
  | { type: "candidates"; candidates: Candidate[] }
  /** The thesis changed on the server (the AI drafted answers). */
  | { type: "thesis"; thesis: Thesis };

/** The runs with one row update applied. The same array when the run isn't among them. */
export function applyRunRow(runs: EnrichRun[], ev: RunRowEvent): EnrichRun[] {
  const i = runs.findIndex((r) => r.id === ev.runId);
  if (i < 0) return runs;
  const run = runs[i]!;
  const next = [...runs];
  next[i] = { ...run, ...ev.counts, rows: { ...run.rows, [ev.rowId]: ev.row } };
  return next;
}

/** The column that collects source links for accepted suggestions. */
export const SOURCES_HEADER = "Enrichment sources";

export const isSourcesColumn = (c: Pick<Column, "header">) => c.header === SOURCES_HEADER;
export const sourcesColumn = (schema: CampaignSchema): Column | undefined => schema.columns.find(isSourcesColumn);

/**
 * Add "Header: url" lines to the sources cell, keeping what is there and skipping duplicates.
 * Plain text on purpose: it survives export to Excel as a readable, clickable-enough list.
 */
export function mergeSources(existing: string | null | undefined, header: string, sources: Source[]): string {
  const lines = (existing ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const s of sources) {
    if (!s.url) continue;
    const line = `${header}: ${s.url}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.join("\n");
}
