/**
 * AI provider and enrichment types shared by the server and the page.
 *
 * Mudd never holds an API key. It drives the user's own signed-in agent CLI — Claude Code or
 * Codex — the way motionbuff-native-app does, so enrichment bills the user's plan.
 */
import type { CellValue } from "./types";

export type ProviderId = "claude" | "codex";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex"];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  vendor: string;
  plan: string;
  models: { value: string; label: string }[];
  efforts: string[];
  install: string;
  loginHint: string;
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
    install: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude auth login",
  },
  codex: {
    id: "codex",
    label: "Codex",
    vendor: "OpenAI",
    plan: "ChatGPT Plus, Pro or Business",
    models: [{ value: "default", label: "Codex default" }],
    efforts: ["low", "medium", "high"],
    install: "npm install -g @openai/codex",
    loginHint: "codex login",
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

export interface AiSettings {
  provider: ProviderId;
  model: Record<ProviderId, string>;
  effort: Record<ProviderId, string>;
  /** `subscription` strips API-key variables from the CLI's environment. */
  credentialMode: "subscription" | "auto";
  /** The user has agreed that enrichment sends row data to their provider. */
  consented: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "claude",
  model: { claude: "sonnet", codex: "default" },
  effort: { claude: "low", codex: "low" },
  credentialMode: "subscription",
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

export interface Recipe {
  id: string;
  campaignId: string;
  name: string;
  instructions: string;
  inputKeys: string[];
  outputs: RecipeOutput[];
  webSearch: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RunKind = "enrich" | "intro";
export type RunStatus = "running" | "paused" | "stopping" | "stopped" | "done" | "failed";
export type RowRunState = "pending" | "running" | "done" | "error" | "skipped";

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

/** Server → page, over the campaign's event stream. */
export type CampaignEvent =
  | { type: "run"; run: EnrichRun }
  | { type: "suggestions"; suggestions: Suggestion[] }
  | { type: "cells"; edits: { rowId: string; key: string; value: CellValue }[] }
  | { type: "ping" };

/** The column that collects source links for accepted suggestions. */
export const SOURCES_HEADER = "Enrichment sources";

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
