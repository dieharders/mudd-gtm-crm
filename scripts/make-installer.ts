/**
 * Package the macOS build as a .dmg: Mudd.app beside an Applications shortcut, so installing is
 * a drag. The release workflow ships this as the macOS download, beside a zip of Mudd.app that
 * only Mudd's updater uses (src/server/update.ts can't install from a .dmg).
 *
 *   bun run installer                        dist/Mudd.app              -> dist/Mudd-<version>-darwin-<arch>.dmg
 *   bun run installer --target=darwin-arm64  dist/darwin-arm64/Mudd.app -> dist/Mudd-<version>-darwin-arm64.dmg
 *
 * Run the matching `bun run build` first. macOS only: hdiutil and codesign exist nowhere else.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const DIST = path.join(ROOT, "dist");
const APP_NAME = "Mudd";
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

if (process.platform !== "darwin") {
  console.error("The installer is a macOS .dmg and has to be made on a Mac.");
  process.exit(1);
}
const targetArg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
if (targetArg && !targetArg.startsWith("darwin-")) {
  console.error(`Unknown target '${targetArg}'. One of: darwin-arm64, darwin-x64`);
  process.exit(1);
}
const target = targetArg ?? `darwin-${process.arch}`;
const app = path.join(targetArg ? path.join(DIST, targetArg) : DIST, `${APP_NAME}.app`);
if (!fs.existsSync(app)) {
  console.error(`${app} not found. Run \`bun run build${targetArg ? `.ts --target=${targetArg}` : ""}\` first.`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err.trim()}`);
}

const staging = path.join(DIST, ".dmg-staging");
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
const staged = path.join(staging, `${APP_NAME}.app`);
// ditto, not cp: it copies the bundle with its signature, permissions and attributes intact.
await run(["ditto", app, staged]);
fs.symlinkSync("/Applications", path.join(staging, "Applications"));
// Checked on the copy that ships: past this point a broken seal shows up only as a user's
// "Mudd is damaged" dialog.
await run(["codesign", "--verify", "--deep", "--strict", staged]);

const out = path.join(DIST, `${APP_NAME}-${VERSION}-${target}.dmg`);
fs.rmSync(out, { force: true });
// UDZO (zlib) opens on every macOS the app supports; UDBZ and ULFO save little and build slower.
// hdiutil now and then fails with "Resource busy" on CI runners, so it gets a few tries.
for (let attempt = 1; ; attempt++) {
  try {
    await run(["hdiutil", "create", "-volname", APP_NAME, "-srcfolder", staging, "-fs", "HFS+", "-format", "UDZO", "-ov", out]);
    break;
  } catch (err) {
    if (attempt === 3) throw err;
    console.warn(`hdiutil failed, retrying (${attempt}/3): ${(err as Error).message}`);
    await Bun.sleep(5_000);
  }
}
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Built ${out}`);
