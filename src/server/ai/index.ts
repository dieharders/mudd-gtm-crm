/**
 * The provider registry, status reporting, and the one call the rest of Mudd makes:
 * `generateStructured` — a research turn whose answer is validated JSON. Install, sign-in and
 * sign-out are in setup.ts.
 */
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { ProviderId, ProviderStatus } from "../../shared/ai";
import { dataDir } from "../db";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { resetDiscovery } from "./discovery";
import { getAiSettings } from "./settings";
import { errorCopy, type AiErrorCode, type Provider } from "./types";

const REGISTRY: Record<ProviderId, Provider> = { claude: claudeProvider, codex: codexProvider };
export const getProvider = (id: ProviderId): Provider => REGISTRY[id] ?? claudeProvider;

export async function providerStatus(id: ProviderId, fresh = false): Promise<ProviderStatus> {
  if (fresh) resetDiscovery();
  const p = getProvider(id);
  const found = await p.detect();
  const auth = found.argv.length ? await p.authStatus() : { state: "cli_missing" as const, plan: null, account: null, subscription: false };
  return { id, installed: found.argv.length > 0, path: found.path, version: found.version, outdated: found.outdated, auth };
}

/** An empty directory for the CLIs to run in, so they never see the user's own files. */
export function agentWorkDir(): string {
  const dir = path.join(dataDir(), "agent-work");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- structured turns ----------

export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string) {
    super(message);
  }
}

/** Pull a JSON object out of a reply that may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const src = fenced ?? text;
  const start = src.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in reply");
}

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  webSearch: boolean;
  signal: AbortSignal;
  onStep?: (label: string) => void;
  /** For a long turn (a Discovery search): more agent turns and more time than a research turn gets. */
  maxTurns?: number;
  timeoutMs?: number;
}

export async function generateStructured<T>(req: StructuredRequest<T>): Promise<{ data: T; costUsd: number | null }> {
  const settings = getAiSettings();
  const id = settings.provider;
  if (!id) throw new AiError("no_provider", errorCopy("no_provider", ""));
  const provider = getProvider(id);
  let prompt = req.prompt;
  let lastError = "";
  // One repair attempt: the reply is shown back with what was wrong with it.
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: { text: string; structured: unknown; costUsd: number | null } | null = null;
    for await (const ev of provider.turn(
      { prompt, system: req.system, model: settings.model[id]!, effort: settings.effort[id]!, webSearch: req.webSearch, schema: req.jsonSchema, cwd: agentWorkDir(), maxTurns: req.maxTurns, timeoutMs: req.timeoutMs },
      req.signal,
    )) {
      if (ev.type === "step") req.onStep?.(ev.label);
      else if (ev.type === "error") throw new AiError(ev.code, ev.message);
      else result = ev;
    }
    if (!result) throw new AiError("cli_failed", errorCopy("cli_failed", provider.label));
    let raw: unknown;
    try {
      raw = result.structured ?? extractJson(result.text);
    } catch (err) {
      lastError = (err as Error).message;
      prompt = `${req.prompt}\n\nYour previous reply could not be read (${lastError}). Reply with ONLY the JSON object.\n\nPrevious reply:\n${result.text.slice(0, 4000)}`;
      continue;
    }
    const parsed = req.schema.safeParse(raw);
    if (parsed.success) return { data: parsed.data, costUsd: result.costUsd };
    lastError = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    prompt = `${req.prompt}\n\nYour previous reply did not match the required shape (${lastError}). Reply with ONLY a corrected JSON object.\n\nPrevious reply:\n${JSON.stringify(raw).slice(0, 4000)}`;
  }
  throw new AiError("bad_output", `${errorCopy("bad_output", provider.label)} (${lastError})`);
}
