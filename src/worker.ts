/**
 * The HTTP server, in a Worker, because `webview.run()` blocks the main thread forever with the
 * window's native event loop.
 *
 * The `import index from "./client/index.html"` literal is how Bun's bundler finds the frontend,
 * and how `bun build --compile` embeds it. It must stay a literal in this file.
 */
import index from "./client/index.html";
import { stopAllAiWork } from "./server/enrich/runner";
import { createFetchHandler } from "./server/index";
import { stopAllDiscovery } from "./server/sourcing/runner";

const handler = createFetchHandler();

// A fixed port when free, so the page's origin (and its localStorage) is the same every launch.
const PREFERRED_PORT = (() => {
  const v = Number(process.env.MUDD_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : 24871;
})();

const serveOn = (port: number) =>
  Bun.serve({
    // Loopback only: the only client is the window on this machine.
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    // Explicitly off: Bun's dev error page dumps source and paths to whoever triggers a throw.
    development: false,
    routes: {
      "/api/*": (req: Request) => handler(req),
      "/*": index as never,
    },
  });

const server = (() => {
  try {
    return serveOn(PREFERRED_PORT);
  } catch (err) {
    console.warn(`Port ${PREFERRED_PORT} unavailable (${(err as { code?: string }).code ?? "error"}); using a free port.`);
    return serveOn(0);
  }
})();

declare let self: Worker;
self.onmessage = (event: MessageEvent) => {
  if (event.data?.type !== "shutdown") return;
  // Discovery first: its runs hold CLIs that stopAllAiWork then aborts with the rest.
  stopAllDiscovery();
  stopAllAiWork();
  // "closed" only once the server has stopped: the main thread quits on it.
  void server.stop(true).finally(() => postMessage({ type: "closed" }));
};

postMessage({ type: "ready", port: server.port });
