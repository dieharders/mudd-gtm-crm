/**
 * The Codex provider — ChatGPT Plus/Pro/Business through OpenAI's `codex` CLI. Adapted from
 * motionbuff-native-app's providers/codex.ts and jsonl-turn.ts.
 *
 * `codex exec --json` is one-way: prompt in, one JSON event per line out. The sandbox is
 * `read-only` (a research turn has no business writing files), every knob goes through `-c`,
 * and the system prompt is prepended to the prompt because `exec` has no per-call system slot.
 *
 * NOTE: Codex is not installed on the development machine, so — like motionbuff's copy — this
 * is written against OpenAI's CLI reference and the event mapping is deliberately tolerant.
 * Web search is enabled with `-c tools.web_search=true`.
 */
import type { ProviderAuth } from "../../shared/ai";
import { CODEX_SPEC, discoverCli } from "./discovery";
import { childEnv } from "./env";
import { captureCommand, killTree, readLines, stripAnsi, track, untrack } from "./proc";
import { errorCopy, type AiErrorCode, type AiEvent, type Provider, type TurnOptions } from "./types";

const copy = (code: AiErrorCode) => errorCopy(code, "Codex");
const STALL_MS = 180_000;
const WALL_MS = 420_000;

async function authStatus(): Promise<ProviderAuth> {
  const found = await discoverCli(CODEX_SPEC);
  if (!found.argv.length) return { state: "cli_missing", plan: null, account: null, subscription: false };
  const r = await captureCommand([...found.argv, "login", "status"], 15_000, childEnv()).catch(() => null);
  if (!r || r.timedOut) return { state: "unknown", plan: null, account: null, subscription: false };
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 || /not (logged in|authenticated)|run `?codex login/i.test(text)) {
    return { state: "logged_out", plan: null, account: null, subscription: false };
  }
  const account = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0] ?? null;
  const plan = /\b(plus|pro|business|team|enterprise)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
  return { state: "ok", plan, account, subscription: !/api key/i.test(text) };
}

export function buildArgs(argv: string[], opts: TurnOptions): string[] {
  const toml = (v: string) => JSON.stringify(v);
  const flags = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode=${toml("read-only")}`];
  if (process.platform === "win32") flags.push("-c", "features.experimental_windows_sandbox=true");
  flags.push("-c", `model_reasoning_effort=${toml(opts.effort)}`);
  if (opts.webSearch) flags.push("-c", "tools.web_search=true");
  if (opts.model && opts.model !== "default") flags.push("--model", opts.model);
  const schemaNote = opts.schema ? `\n\nReply with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(opts.schema)}` : "";
  return [...argv, "exec", ...flags, `${opts.system}\n\n---\n\n${opts.prompt}${schemaNote}`];
}

interface CodexLine {
  type?: string;
  item?: { type?: string; text?: string; query?: string };
  error?: { message?: string } | string;
}

async function* turn(opts: TurnOptions, signal: AbortSignal): AsyncGenerator<AiEvent> {
  const found = await discoverCli(CODEX_SPEC);
  if (!found.argv.length) {
    yield { type: "error", code: "cli_missing", message: copy("cli_missing") };
    return;
  }
  if (signal.aborted) {
    yield { type: "error", code: "aborted", message: copy("aborted") };
    return;
  }
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(buildArgs(found.argv, opts), { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: opts.cwd, env: childEnv(), windowsHide: true });
  } catch (err) {
    console.error("[codex] spawn failed:", err);
    yield { type: "error", code: "cli_failed", message: copy("cli_failed") };
    return;
  }
  const controller = new AbortController();
  track(controller);
  let reason: "aborted" | "timeout" | null = null;
  const stdoutStop = new AbortController();
  const stop = (why: "aborted" | "timeout") => {
    reason ??= why;
    killTree(proc);
    setTimeout(() => stdoutStop.abort(), 2_000);
  };
  let stderrTail = "";
  const drainErr = (async () => {
    for await (const line of readLines(proc.stderr as ReadableStream<Uint8Array>)) stderrTail = (stderrTail + line + "\n").slice(-4096);
  })().catch(() => {});
  let stall: ReturnType<typeof setTimeout> | null = null;
  const armStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => stop("timeout"), STALL_MS);
  };
  const wall = setTimeout(() => stop("timeout"), WALL_MS);
  const onAbort = () => stop("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", onAbort, { once: true });
  armStall();

  let text = "";
  let done = false;
  let failed = false;
  try {
    for await (const raw of readLines(proc.stdout as ReadableStream<Uint8Array>, stdoutStop.signal)) {
      armStall();
      let msg: CodexLine;
      try {
        msg = JSON.parse(raw) as CodexLine;
      } catch {
        continue;
      }
      if (msg.type === "item.started" && msg.item?.type === "web_search") {
        yield { type: "step", label: msg.item.query ? `Searching: ${msg.item.query.slice(0, 80)}` : "Searching the web" };
      } else if (msg.type === "item.completed" && msg.item?.type === "agent_message" && msg.item.text) {
        text = msg.item.text;
      } else if (msg.type === "turn.completed") {
        done = true;
      } else if (msg.type === "turn.failed" || msg.type === "error") {
        failed = true;
      }
    }
    const code = reason === null ? await proc.exited : await Promise.race([proc.exited, Bun.sleep(2_000).then(() => -1)]);
    if (done && text) {
      yield { type: "result", text, structured: null, costUsd: null };
    } else if (reason) {
      yield { type: "error", code: reason, message: copy(reason) };
    } else {
      await Promise.race([drainErr, Bun.sleep(2_000)]);
      console.error(`[codex] exit ${code}${failed ? " (turn failed)" : ""}\n${stderrTail}`);
      yield /not (logged in|authenticated)|codex login/i.test(stderrTail)
        ? { type: "error", code: "not_authenticated", message: copy("not_authenticated") }
        : { type: "error", code: "cli_failed", message: copy("cli_failed") };
    }
  } finally {
    clearTimeout(wall);
    if (stall) clearTimeout(stall);
    signal.removeEventListener("abort", onAbort);
    killTree(proc);
    untrack(controller);
  }
}

export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  detect: () => discoverCli(CODEX_SPEC),
  authStatus,
  turn,
};
