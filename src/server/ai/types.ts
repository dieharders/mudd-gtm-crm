/**
 * The provider seam, kept to what Mudd needs: one research turn in, events out. Every turn is
 * one-shot (no resumed sessions): each prospect is researched from a clean context so one row
 * can never leak into the next.
 */
import type { ProviderAuth, ProviderId } from "../../shared/ai";
import type { Resolution } from "./discovery";

export type AiErrorCode = "no_provider" | "cli_missing" | "not_authenticated" | "cli_failed" | "aborted" | "timeout" | "bad_output";

export type AiEvent =
  /** Something the agent is doing, for the progress line: "Searching: CORAS FedRAMP". */
  | { type: "step"; label: string }
  | { type: "result"; text: string; structured: unknown; costUsd: number | null }
  | { type: "error"; code: AiErrorCode; message: string };

export interface TurnOptions {
  prompt: string;
  system: string;
  model: string;
  effort: string;
  /** Allow web search and page fetches. Nothing else is ever allowed: no shell, no file writes. */
  webSearch: boolean;
  /** JSON Schema the answer must match. Claude decodes under it; Codex is asked to follow it. */
  schema?: Record<string, unknown>;
  /** An empty scratch directory: the CLI's working directory, never the user's files. */
  cwd: string;
  /** How many agent turns (tool calls and replies) the CLI may take; the provider's default otherwise. */
  maxTurns?: number;
  /** The whole turn's time limit; the provider's default (7 min) otherwise. */
  timeoutMs?: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  detect(): Promise<Resolution>;
  authStatus(): Promise<ProviderAuth>;
  turn(opts: TurnOptions, signal: AbortSignal): AsyncGenerator<AiEvent>;
}

export function errorCopy(code: AiErrorCode, label: string): string {
  switch (code) {
    case "no_provider":
      return "No AI provider chosen. Open AI settings to pick one.";
    case "cli_missing":
      return `${label} isn't installed, or Mudd can't find it. Open AI settings to set it up.`;
    case "not_authenticated":
      return `${label} isn't signed in. Open AI settings and sign in.`;
    case "aborted":
      return "Stopped.";
    case "timeout":
      return `${label} took too long and was stopped.`;
    case "bad_output":
      return `${label} didn't return the expected format.`;
    default:
      return `${label} couldn't finish that request.`;
  }
}
