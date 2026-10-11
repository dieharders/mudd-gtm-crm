/**
 * Setting a provider up from AI settings: install its CLI, sign in, sign out.
 *
 * Each is one click by the user and nothing happens unasked. An install names the vendor and
 * checks the download against the SHA-256 the vendor published; a sign-in opens the vendor's own
 * page in the user's browser. Install and sign-in answer with an event stream, so the dialog can
 * show progress and move on by itself when they finish; closing the stream cancels them.
 */
import { PROVIDERS, type ProviderId, type SetupEvent } from "../../shared/ai";
import { openExternal } from "../dialogs";
import { childEnv } from "./env";
import { agentWorkDir, getProvider } from "./index";
import { ChecksumError, installManaged } from "./install";
import { authIdentity, LoginSpawnError, loginUrl, runLogin, spawnLogin } from "./login";
import { resetDiscovery } from "./discovery";
import { captureCommand } from "./proc";

const INSTALL_TIMEOUT_MS = 300_000;
const LOGOUT_TIMEOUT_MS = 15_000;

/**
 * An event stream fed by `run`. The comment heartbeat keeps a sign-in that is quiet for minutes
 * (the user is in their browser) under the server's idle timeout.
 */
function eventResponse(run: (send: (ev: SetupEvent) => void) => Promise<void>, onCancel: () => void): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* client gone */
        }
      };
      const ping = setInterval(() => push(": ping\n\n"), 25_000);
      try {
        await run((ev) => push(`data: ${JSON.stringify(ev)}\n\n`));
      } finally {
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel: onCancel,
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}

/** Download the vendor's CLI into Mudd's folder, streaming progress. */
export function installStream(id: ProviderId, signal: AbortSignal): Response {
  const ac = new AbortController();
  signal.addEventListener("abort", () => ac.abort(), { once: true });
  return eventResponse(async (send) => {
    const timer = setTimeout(() => ac.abort(), INSTALL_TIMEOUT_MS);
    try {
      await installManaged(id, ac.signal, (line) => send({ type: "log", line }));
      // Discovery cached a miss for where the binary now is.
      resetDiscovery();
      const found = await getProvider(id).detect();
      send(found.argv.length
        ? { type: "done", ok: true, message: `${PROVIDERS[id].label} is installed.` }
        : { type: "done", ok: false, message: "The download finished, but Mudd couldn't run it afterwards." });
    } catch (err) {
      console.error(`[setup] ${id} install failed:`, err);
      send({
        type: "done",
        ok: false,
        message: err instanceof ChecksumError
          ? "The download didn't match the checksum the vendor published, so it was discarded."
          : ac.signal.aborted
            ? "Install cancelled."
            : `Install failed: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }, () => ac.abort());
}

/** A command as the user would type it, for when they must run it themselves. */
const displayCommand = (argv: string[]) => argv.map((a) => (/[\s'"]/.test(a) ? `"${a}"` : a)).join(" ");

/**
 * Open a terminal running the CLI's sign-in: the fallback when the hidden one can't run or the
 * user asks for another way. Mudd can't see it finish, so it ends in a `handoff`.
 */
async function signInInTerminal(argv: string[]): Promise<SetupEvent> {
  const handoff: SetupEvent = { type: "handoff", message: "Finish signing in in the terminal window, then press Check again." };
  const [exe, ...args] = argv;
  try {
    if (process.platform === "win32") {
      // PowerShell also reads the curly single quotes (U+2018–U+201B) as quotes: double those too.
      const q = (s: string) => `'${s.replace(/['‘’‚‛]/g, "$&$&")}'`;
      const list = args.length ? ` -ArgumentList ${args.map(q).join(",")}` : "";
      Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Start-Process -FilePath ${q(exe!)}${list}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
      return handoff;
    }
    if (process.platform === "darwin") {
      const cmd = argv.map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ");
      Bun.spawn(["osascript", "-e", `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return handoff;
    }
  } catch (err) {
    console.error("[setup] could not open a terminal:", err);
  }
  return { type: "done", ok: false, message: `Couldn't open a terminal. Run ${displayCommand(argv)} yourself, then press Check again.` };
}

/**
 * Sign in with the CLI's own command, hidden, the vendor's page opening in the browser. Streams
 * `url` and `code_prompt` as the CLI offers them and one `done` once the user is signed in.
 * `terminal` asks for a terminal window instead (answered with one JSON event, not a stream).
 */
export async function signInStream(id: ProviderId, terminal: boolean, signal: AbortSignal): Promise<Response> {
  const ac = new AbortController();
  // Listened for before discovery, which can take seconds: a sign-in cancelled meanwhile must
  // not open a browser tab (or hold Codex's fixed callback port) for nobody.
  signal.addEventListener("abort", () => ac.abort(), { once: true });
  const found = await getProvider(id).detect();
  if (!found.argv.length) return Response.json({ type: "done", ok: false, message: `${PROVIDERS[id].label} isn't installed yet.` } satisfies SetupEvent);
  if (ac.signal.aborted) return new Response(null, { status: 499 });
  const argv = [...found.argv, ...PROVIDERS[id].loginArgs];
  if (terminal) return Response.json(await signInInTerminal(argv));

  const cwd = agentWorkDir();
  return eventResponse(async (send) => {
    try {
      await runLogin({
        provider: id,
        argv,
        signal: ac.signal,
        send,
        deps: { spawn: (a) => spawnLogin(a, cwd), identity: async () => authIdentity(await getProvider(id).authStatus()) },
      });
    } catch (err) {
      console.error(`[setup] ${id} sign-in failed:`, err);
      send(err instanceof LoginSpawnError ? await signInInTerminal(argv) : { type: "done", ok: false, message: "Couldn't start the sign-in. Try again." });
    }
  }, () => ac.abort());
}

/** Reopen the running sign-in's page. The address is the one read from the CLI. */
export function openSignInPage(id: ProviderId): boolean {
  const url = loginUrl(id);
  return url !== null && url.startsWith("https:") && openExternal(url);
}

/**
 * Sign the CLI out with its own command, then re-read the status: that, not the exit code, says
 * whether it worked. With an API key in use the CLI can still be connected afterwards.
 */
export async function signOut(id: ProviderId): Promise<{ ok: boolean; message: string }> {
  const info = PROVIDERS[id];
  const found = await getProvider(id).detect();
  if (!found.argv.length) return { ok: false, message: `${info.label} isn't installed.` };
  const r = await captureCommand([...found.argv, ...info.logoutArgs], LOGOUT_TIMEOUT_MS, childEnv()).catch(() => null);
  if (!r || r.timedOut || r.code !== 0) console.error(`[setup] ${id} logout ${r?.timedOut ? "timed out" : `exit ${r?.code}`}\n${r?.stderr.slice(-4096) ?? ""}`);
  const after = await getProvider(id).authStatus();
  if (after.state === "logged_out") return { ok: true, message: `Signed out of ${info.label}.` };
  if (after.state === "ok" && after.keySource) return { ok: false, message: `${info.label} is signed out of your account, but still connected through an API key (${after.keySource}).` };
  return { ok: false, message: `Couldn't sign out of ${info.label}. Try again.` };
}
