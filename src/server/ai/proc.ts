/**
 * Child-process helpers for the agent CLIs: line splitting, killing a process TREE, and a
 * short capture with a hard timeout. Adapted from motionbuff-native-app
 * (app/src/agent/cli/server/providers/jsonl-turn.ts and @suite/shell).
 */

/** Every live controller, so shutting the app down stops every CLI it started. */
const live = new Set<AbortController>();
export const track = (c: AbortController) => live.add(c);
export const untrack = (c: AbortController) => live.delete(c);
export function abortAll(): void {
  for (const c of live) c.abort();
  live.clear();
}

/** Split a byte stream into lines. Stops early when `signal` aborts. */
export async function* readLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf.replace(/\r$/, "");
  } catch {
    // Cancelled or broken pipe: end of stream as far as the caller is concerned.
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Remove terminal escape sequences (OSC before CSI; OSC removed whole). */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Kill a child and, on Windows, everything it started: an npm codex is `node codex.js`, which
 * starts codex.exe with the pipes inherited, so killing node alone leaves the real work running.
 * A no-op once the child has exited, because its pid may already belong to someone else.
 */
export function killTree(proc: { pid: number; exitCode: number | null; signalCode: unknown; kill: () => void }): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    } catch {
      /* taskkill missing; the direct kill is still worth doing */
    }
  }
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Run a short command (`--version`, `auth status`) and capture its output, with a timeout that
 * is hard in fact: after the kill it waits briefly for the pipes, then returns regardless.
 */
export async function captureCommand(
  argv: string[],
  timeoutMs: number,
  env: Record<string, string | undefined> = { ...process.env },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => (timer = setTimeout(() => resolve("expired"), timeoutMs)));
  try {
    const first = await Promise.race([finished, expired]);
    if (first !== "expired") return { code: first[2], stdout: first[0], stderr: first[1], timedOut: false };
    killTree(proc);
    const late = await Promise.race([finished, Bun.sleep(2_000).then(() => null)]);
    return late ? { code: late[2], stdout: late[0], stderr: late[1], timedOut: true } : { code: -1, stdout: "", stderr: "", timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}
