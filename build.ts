/**
 * Compile Mudd.io to a standalone executable in dist/.
 *
 *   bun run build
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dir;
const DIST = path.join(ROOT, "dist");
const ext = process.platform === "win32" ? ".exe" : "";
fs.mkdirSync(DIST, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(ROOT, "main.ts"), path.join(ROOT, "src/worker.ts")],
  compile: {
    outfile: path.join(DIST, `Mudd.io${ext}`),
    ...(process.platform === "win32"
      ? { windows: { title: "Mudd.io", publisher: "Mudd.io", description: "Mudd.io - local-first prospect CRM", hideConsole: false } }
      : {}),
  },
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${path.join(DIST, `Mudd.io${ext}`)}`);
