/**
 * The Claude Code provider, through the Claude Agent SDK.
 *
 * THE FENCE. `tools` is an allowlist of the built-in tools that exist at all for the session:
 * WebSearch and WebFetch when the recipe wants the web, otherwise nothing. No Bash, no Read,
 * no Write, no Edit — a research turn cannot touch the machine. `permissionMode: 'dontAsk'`
 * denies anything not pre-approved instead of prompting into a terminal nobody is watching,
 * `settingSources: []` and `strictMcpConfig` keep the user's own CLAUDE.md, hooks and MCP
 * servers out, and `persistSession: false` keeps hundreds of research turns out of their
 * Claude Code history.
 */
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAuth } from "../../shared/ai";
import { CLAUDE_SPEC, discoverCli } from "./discovery";
import { childEnv, hadApiKeyOverride } from "./env";
import { captureCommand, track, untrack } from "./proc";
import { getAiSettings, updateAiSettings } from "./settings";
import { errorCopy, type AiEvent, type Provider, type TurnOptions } from "./types";

const copy = (code: Parameters<typeof errorCopy>[0]) => errorCopy(code, "Claude Code");
const STALL_MS = 180_000;
const WALL_MS = 420_000;

interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
  /** Which credential is actually billed. Independent of the fields above. */
  apiKeySource?: string;
}

export function parseAuthStatus(stdout: string): ProviderAuth {
  let raw: AuthStatusJson;
  try {
    raw = JSON.parse(stdout) as AuthStatusJson;
  } catch {
    return { state: "unknown", plan: null, account: null, subscription: false };
  }
  if (typeof raw !== "object" || raw === null || typeof raw.loggedIn !== "boolean") {
    return { state: "unknown", plan: null, account: null, subscription: false };
  }
  if (!raw.loggedIn) return { state: "logged_out", plan: null, account: null, subscription: false, keySource: null };
  const source = typeof raw.apiKeySource === "string" ? raw.apiKeySource : null;
  const billedToKey = source !== null && source !== "none";
  return {
    state: "ok",
    plan: typeof raw.subscriptionType === "string" ? raw.subscriptionType : null,
    account: typeof raw.email === "string" ? raw.email : null,
    subscription: raw.apiProvider === "firstParty" && raw.authMethod === "claude.ai" && !billedToKey,
    keySource: billedToKey ? source : null,
  };
}

async function probe(argv: string[], env: Record<string, string | undefined>): Promise<ProviderAuth> {
  // The payload decides, whatever the exit code: a signed-out CLI prints {"loggedIn": false}
  // on its way to exiting 1.
  const r = await captureCommand([...argv, "auth", "status", "--json"], 15_000, env).catch(() => null);
  if (!r || r.timedOut) return { state: "unknown", plan: null, account: null, subscription: false };
  return parseAuthStatus(r.stdout);
}

async function authStatus(): Promise<ProviderAuth> {
  const found = await discoverCli(CLAUDE_SPEC);
  if (!found.argv.length) return { state: "cli_missing", plan: null, account: null, subscription: false };
  const stripped = await probe(found.argv, childEnv());
  // Never let the key strip take the user's ONLY credential: if they are "signed out" only
  // because we hid their API key, fall back to `auto` and say so in the UI (billing badge).
  if (stripped.state !== "logged_out" || getAiSettings().credentialMode !== "subscription" || !hadApiKeyOverride()) return stripped;
  const withKey = await probe(found.argv, { ...process.env });
  if (withKey.state !== "ok") return stripped;
  updateAiSettings({ credentialMode: "auto" });
  return withKey;
}

const STEP_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  WebSearch: (i) => `Searching: ${String(i.query ?? "the web").slice(0, 80)}`,
  WebFetch: (i) => `Reading ${String(i.url ?? "a page").replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`,
};

async function* turn(opts: TurnOptions, signal: AbortSignal): AsyncGenerator<AiEvent> {
  const found = await discoverCli(CLAUDE_SPEC);
  if (!found.path) {
    yield { type: "error", code: "cli_missing", message: copy("cli_missing") };
    return;
  }
  const controller = new AbortController();
  track(controller);
  let reason: "aborted" | "timeout" | null = null;
  const stop = (why: "aborted" | "timeout") => {
    reason ??= why;
    controller.abort();
  };
  let stderrTail = "";
  let stall: ReturnType<typeof setTimeout> | null = null;
  const armStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => stop("timeout"), STALL_MS);
  };
  const wall = setTimeout(() => stop("timeout"), WALL_MS);
  const onAbort = () => stop("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) stop("aborted");
  armStall();

  const tools = opts.webSearch ? ["WebSearch", "WebFetch"] : [];
  const options: Options = {
    pathToClaudeCodeExecutable: found.path,
    abortController: controller,
    env: childEnv(),
    cwd: opts.cwd,
    stderr: (chunk) => (stderrTail = (stderrTail + chunk).slice(-4096)),
    ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
    effort: opts.effort as Options["effort"],
    tools,
    allowedTools: tools,
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: opts.webSearch ? 16 : 4,
    systemPrompt: opts.system,
    ...(opts.schema ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } } : {}),
  };

  try {
    for await (const message of query({ prompt: opts.prompt, options })) {
      armStall();
      const msg = message as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        total_cost_usd?: number;
        message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
      };
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          // StructuredOutput is how the SDK hands back the JSON answer, not a research step.
          if (block.type === "tool_use" && block.name && block.name !== "StructuredOutput") {
            const label = STEP_LABELS[block.name]?.(block.input ?? {}) ?? block.name;
            yield { type: "step", label };
          }
        }
      } else if (msg.type === "result") {
        if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
          const auth = /not (logged in|authenticated)|please log in|\/login/i.test(`${msg.result ?? ""} ${stderrTail}`);
          yield auth
            ? { type: "error", code: "not_authenticated", message: copy("not_authenticated") }
            : { type: "error", code: msg.subtype === "error_max_structured_output_retries" ? "bad_output" : "cli_failed", message: copy(msg.subtype === "error_max_structured_output_retries" ? "bad_output" : "cli_failed") };
          return;
        }
        yield { type: "result", text: msg.result ?? "", structured: msg.structured_output ?? null, costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null };
        return;
      }
    }
    if (reason) yield { type: "error", code: reason, message: copy(reason) };
    else yield { type: "error", code: "cli_failed", message: copy("cli_failed") };
  } catch (err) {
    if (reason) {
      yield { type: "error", code: reason, message: copy(reason) };
      return;
    }
    console.error("[claude] turn failed:", err, stderrTail ? `\nstderr: ${stderrTail}` : "");
    const auth = /not (logged in|authenticated)|auth login|please log in/i.test(stderrTail + String(err));
    yield auth ? { type: "error", code: "not_authenticated", message: copy("not_authenticated") } : { type: "error", code: "cli_failed", message: copy("cli_failed") };
  } finally {
    clearTimeout(wall);
    if (stall) clearTimeout(stall);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    untrack(controller);
  }
}

export const claudeProvider: Provider = {
  id: "claude",
  label: "Claude Code",
  detect: () => discoverCli(CLAUDE_SPEC),
  authStatus,
  turn,
};
