/**
 * A sign-in the user only sees in their browser.
 *
 * The CLI's own login command (`claude auth login`, `codex login`) runs as a hidden child. Over
 * plain pipes it opens the default browser by itself, waits on a localhost callback and prints
 * the sign-in address as a fallback. Mudd reads three things off that output: the address (for
 * "Browser didn't open?"), whether it will take a pasted code, and the end. The vendor's command
 * still does the OAuth exchange and stores the credential; Mudd never sees it.
 *
 * THE END is a change in who is signed in (polled), or the child exiting, whichever is first.
 * A change and not a state: someone signing in as a different account was already "signed in"
 * when it started. The exit code alone is never the answer; the status read after it is.
 *
 * One at a time: a second sign-in replaces the first rather than opening a second browser tab
 * and a second localhost listener (Codex's port is fixed, so the second would fail).
 */
import type { ProviderAuth, ProviderId, SetupEvent } from "../../shared/ai";
import { PROVIDERS } from "../../shared/ai";
import { childEnv } from "./env";
import { killTree, stripAnsi, track, untrack } from "./proc";

/** Generous: it includes a password manager, 2FA and SSO. */
const LOGIN_TIMEOUT_MS = 600_000;
/** Each read spawns the CLI's status command. */
const POLL_MS = 3_000;
const OUTPUT_TAIL = 16_384;
const MAX_CODE_LENGTH = 2_048;

export interface LoginChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  write(text: string): void;
  kill(): void;
  exited: Promise<number>;
}

export interface LoginDeps {
  spawn: (argv: string[]) => LoginChild;
  /** Who is signed in now, as one comparable string (`authIdentity`), or null. */
  identity: () => Promise<string | null>;
  pollMs?: number;
  timeoutMs?: number;
}

/** The account and the credential in front of it: a sign-in over an API key changes only the account. */
export function authIdentity(auth: ProviderAuth): string | null {
  if (auth.state !== "ok") return null;
  return `${auth.account ?? ""}\u0000${auth.keySource ?? ""}`;
}

/** The login command could not be started; the caller falls back to a terminal. */
export class LoginSpawnError extends Error {}

const SIGN_IN_URL = /oauth|authori[sz]e|login|signin|sign-in|\/auth\b|^auth\./i;
const looksLikeSignIn = (url: string) => {
  try {
    const { hostname, pathname } = new URL(url);
    return SIGN_IN_URL.test(hostname) || SIGN_IN_URL.test(pathname);
  } catch {
    return false;
  }
};

/**
 * The sign-in address in some output, once printed in full (followed by whitespace: a URL cut
 * mid-chunk carries a truncated OAuth `state`). The last one that looks like a sign-in wins over
 * an update notice's link printed before it. https only, which skips Codex's localhost callback.
 */
export function extractUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const urls = output.match(/https:\/\/[^\s"'<>\x00-\x1f\x7f]+(?=\s)/g) ?? [];
  return urls.filter(looksLikeSignIn).at(-1) ?? urls.at(-1) ?? null;
}

export const asksForCode = (output: string) => /paste (the )?code|enter (the )?code/i.test(output);

interface Session {
  provider: ProviderId;
  abort: AbortController;
  url: string | null;
  write: ((text: string) => void) | null;
}
let current: Session | null = null;

/** Run one sign-in to its end. Throws `LoginSpawnError` (having sent nothing) if it can't start. */
export async function runLogin(opts: { provider: ProviderId; argv: string[]; signal: AbortSignal; send: (ev: SetupEvent) => void; deps: LoginDeps }): Promise<void> {
  const { provider, send, deps } = opts;
  const label = PROVIDERS[provider].label;
  const failed = (message: string) => send({ type: "done", ok: false, message });
  if (opts.signal.aborted) return failed("Sign-in cancelled.");

  current?.abort.abort();
  const abort = new AbortController();
  const session: Session = { provider, abort, url: null, write: null };
  current = session;

  let child: LoginChild;
  try {
    child = deps.spawn(opts.argv);
  } catch (err) {
    if (current === session) current = null;
    throw new LoginSpawnError(String(err));
  }
  session.write = (text) => child.write(text);
  // Tracked so quitting Mudd kills it.
  track(abort);
  abort.signal.addEventListener("abort", () => child.kill(), { once: true });
  const onClientGone = () => abort.abort();
  opts.signal.addEventListener("abort", onClientGone, { once: true });

  // Read while the child starts, so the browser opens at once. A failed read counts as nobody.
  const read = () => deps.identity().catch(() => null);
  const before = read();
  const changed = async () => {
    const [was, now] = await Promise.all([before, read()]);
    return now !== null && now !== was;
  };

  // Raw per stream, escapes stripped on read: stripped per chunk, an escape split across two
  // reads survives and fuses into the URL.
  const raw = { stdout: "", stderr: "" };
  let prompted = false;
  const onText = (from: keyof typeof raw, text: string) => {
    raw[from] = (raw[from] + text).slice(-OUTPUT_TAIL);
    const out = stripAnsi(raw.stdout);
    const err = stripAnsi(raw.stderr);
    const found = [extractUrl(out), extractUrl(err)].filter((u): u is string => u !== null);
    const url = found.find(looksLikeSignIn) ?? found[0];
    if (url && url !== session.url) {
      session.url = url;
      send({ type: "url" });
    }
    if (!prompted && (asksForCode(out) || asksForCode(err))) {
      prompted = true;
      send({ type: "code_prompt" });
    }
  };
  const drain = async (from: keyof typeof raw, stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onText(from, decoder.decode(value, { stream: true }));
    }
  };
  const drained = Promise.all([drain("stdout", child.stdout), drain("stderr", child.stderr)]).catch(() => {});

  type Outcome = { kind: "exit"; code: number } | { kind: "signed_in" | "timeout" | "aborted" };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const settle = (o: Outcome) => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    void child.exited.then((code) => settle({ kind: "exit", code }));
    abort.signal.addEventListener("abort", () => settle({ kind: "aborted" }), { once: true });
    timers.push(setTimeout(() => settle({ kind: "timeout" }), deps.timeoutMs ?? LOGIN_TIMEOUT_MS));
    const poll = () => {
      timers.push(
        setTimeout(() => {
          if (settled) return;
          void changed().then((yes) => (yes ? settle({ kind: "signed_in" }) : poll()));
        }, deps.pollMs ?? POLL_MS),
      );
    };
    poll();
  });

  for (const t of timers) clearTimeout(t);
  opts.signal.removeEventListener("abort", onClientGone);
  session.write = null;
  if (outcome.kind !== "exit") child.kill();
  await Promise.race([drained, Bun.sleep(1_000)]);
  untrack(abort);
  if (current === session) current = null;

  const done = () => send({ type: "done", ok: true, message: `${label} is signed in.` });
  const exitCode = outcome.kind === "exit" ? outcome.code : null;
  if (outcome.kind === "signed_in") return done();
  if (outcome.kind === "aborted") return failed("Sign-in cancelled.");
  if (outcome.kind === "timeout") return (await changed()) ? done() : failed("That sign-in wasn't finished in time. Try again.");
  // The child exited: the status says how. A different identity is a finished sign-in whatever
  // the exit code; the same one only on a clean exit (signed in again as the same account).
  const [was, now] = await Promise.all([before, read()]);
  if (now !== null && (now !== was || exitCode === 0)) return done();
  // The sign-in URL carries this attempt's OAuth state: it stays out of the log.
  const transcript = `${stripAnsi(raw.stdout)}\n${stripAnsi(raw.stderr)}`.replace(/https:\/\/\S+/g, "<sign-in url>");
  console.error(`[login] ${provider} exited ${exitCode} without signing in\n${transcript}`);
  failed("Couldn't finish signing in. Try again.");
}

/** The real child: piped, windowless, in an empty directory, with the same environment as a turn. */
export function spawnLogin(argv: string[], cwd: string): LoginChild {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd, env: childEnv(), windowsHide: true });
  // A write to a child that just exited rejects asynchronously (EPIPE); that is not a crash.
  const settle = (r: unknown) => {
    if (r instanceof Promise) r.catch((err) => console.warn("[login] stdin write failed:", err));
  };
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    write: (text) => {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("login command has exited");
      settle(proc.stdin.write(text));
      settle(proc.stdin.flush());
    },
    kill: () => killTree(proc),
    exited: proc.exited,
  };
}

/** Hand a pasted code to the running sign-in: one line, control characters removed. */
export function submitLoginCode(provider: ProviderId, code: string): boolean {
  if (current?.provider !== provider || !current.write) return false;
  // eslint-disable-next-line no-control-regex
  const line = code.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!line || line.length > MAX_CODE_LENGTH) return false;
  try {
    current.write(`${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The running sign-in's page, as read from the CLI. The page never supplies an address. */
export const loginUrl = (provider: ProviderId): string | null => (current?.provider === provider ? current.url : null);
