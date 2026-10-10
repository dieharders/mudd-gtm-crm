/**
 * The client in a browser with hot reload, against the real API.
 *
 *   bun run dev   -> http://127.0.0.1:3000
 *
 * A separate entrypoint so src/worker.ts keeps `development: false`. Also runs the Tailwind
 * watcher, since nothing else rebuilds generated.css while you edit.
 */
import index from "../src/client/index.html";
import { createFetchHandler } from "../src/server/index";

const hot = globalThis as { __twWatch?: { kill(): void }; __twExitHook?: boolean };
hot.__twWatch?.kill();
hot.__twWatch = Bun.spawn(
  [process.execPath, "x", "@tailwindcss/cli", "-i", "./src/client/styles.css", "-o", "./src/client/generated.css", "--watch=always"],
  { cwd: `${import.meta.dir}/..`, stdio: ["ignore", "inherit", "inherit"] },
);
if (!hot.__twExitHook) {
  hot.__twExitHook = true;
  process.on("exit", () => hot.__twWatch?.kill());
}

const handler = createFetchHandler();
const port = Number(process.env.MUDD_DEV_PORT ?? 3000);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  development: { hmr: true, console: true },
  routes: {
    "/api/*": (req: Request) => handler(req),
    "/*": index as never,
  },
});
console.log(`\n  Mudd dev server -> http://127.0.0.1:${server.port}\n`);
