/**
 * A headless Edge or Chrome driven over the DevTools protocol, for the scripts that need a real
 * browser engine: make-icon.ts (rasterising the icon) and screenshots/ (the README images).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findBrowser(): string {
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    process.env.CHROME_PATH,
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const found =
    candidates.find((c): c is string => !!c && fs.existsSync(c)) ??
    Bun.which("google-chrome") ??
    Bun.which("chromium") ??
    Bun.which("microsoft-edge");
  if (!found) throw new Error("No Edge or Chrome found. Set CHROME_PATH to a Chromium-based browser.");
  return found;
}

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export async function withBrowser<T>(fn: (send: Send) => Promise<T>, opts: { name?: string; args?: string[] } = {}): Promise<T> {
  // Its own profile, so it cannot hand off to (or open a window in) a browser already running.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `mudd-${opts.name ?? "browser"}-`));
  // Port 0: the browser picks a free port and writes it to DevToolsActivePort in that profile, so
  // a browser left over from an earlier run, or one beside this, is never the one driven.
  const proc = Bun.spawn(
    [findBrowser(), "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...(opts.args ?? []), "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    // Polled until the port is written and the page target is listed: the endpoint can answer
    // `[]` before about:blank has registered.
    type Target = { type: string; webSocketDebuggerUrl: string };
    let port: number | undefined;
    let page: Target | undefined;
    for (let i = 0; i < 60 && !page; i++) {
      try {
        // The first line is the port; a file still being written reads as 0, and is read again.
        port ||= Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
        if (port) {
          const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
          page = list.find((t) => t.type === "page");
        }
      } catch {
        // Not listening yet.
      }
      if (!page) await Bun.sleep(250);
    }
    if (!page) throw new Error(`the headless browser exposed no page ${port ? `on port ${port} ` : ""}within 15s`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let id = 0;
    // A reply is a result or an error: an error fails that call, with what the browser said.
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      const call = msg.id ? pending.get(msg.id) : undefined;
      if (!call) return;
      pending.delete(msg.id!);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message ?? "the browser returned an error"}`));
      else call.resolve(msg.result ?? {});
    };
    // A socket that fails or drops fails the run, rather than leaving an await that never returns.
    let closed: Error | null = null;
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to the browser's debugger at ${page.webSocketDebuggerUrl}`));
    });
    ws.onclose = () => {
      closed = new Error("the browser's debugger connection closed");
      for (const p of pending.values()) p.reject(closed);
      pending.clear();
    };
    await opened;
    const send: Send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(closed);
        const n = ++id;
        pending.set(n, { method, resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    try {
      return await fn(send);
    } finally {
      ws.close();
    }
  } finally {
    proc.kill();
    await proc.exited;
    // Edge's child processes can outlive the parent and hold the profile open for a moment on
    // Windows. A leftover temp folder isn't worth failing a run that already did its work.
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`  (could not remove ${profile}: ${(err as Error).message})`);
    }
  }
}