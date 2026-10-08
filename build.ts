/**
 * Compile Mudd.io to a standalone executable.
 *
 *   bun run build                          dist/Mudd.io(.exe), for this machine
 *   bun run build --target=darwin-arm64    dist/darwin-arm64/, what the release workflow zips
 *
 * A --target must match this machine: webview-bun picks its native library by the platform it
 * runs on, and macOS needs codesign, so each release target is built on its own runner.
 */
import fs from "node:fs";
import path from "node:path";

const TARGETS = ["windows-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

const ROOT = import.meta.dir;
const DIST = path.join(ROOT, "dist");
/** The one icon file: embedded in the Windows exe, converted to .icns for macOS. Made by `bun run icon`. */
const ICON_PATH = path.join(ROOT, "assets", "icon.ico");
const APP_NAME = "Mudd.io";
const BUNDLE_ID = "io.mudd.desktop";
const ext = process.platform === "win32" ? ".exe" : "";

/** package.json's SemVer as the four numeric parts Windows and macOS version fields accept. */
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const NUMERIC_VERSION = VERSION.split(/[-+]/)[0]!.split(".").concat("0", "0", "0").slice(0, 4).join(".");

const targetArg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
const HOST_TARGET = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
if (targetArg && !(TARGETS as readonly string[]).includes(targetArg)) {
  console.error(`Unknown target '${targetArg}'. One of: ${TARGETS.join(", ")}`);
  process.exit(1);
}
if (targetArg && targetArg !== HOST_TARGET) {
  console.error(`Refusing to build ${targetArg} on ${HOST_TARGET}. Build each target on a matching machine.`);
  process.exit(1);
}

// generated.css is gitignored, and a missing one builds an app with no styling at all.
const css = Bun.file(path.join(ROOT, "src/client/generated.css"));
if (!(await css.exists()) || css.size < 1024) {
  console.error("src/client/generated.css is missing or truncated. Run `bun run build:css` first.");
  process.exit(1);
}

const OUT_DIR = targetArg ? path.join(DIST, targetArg) : DIST;
if (targetArg) fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const outfile = path.join(OUT_DIR, `${APP_NAME}${ext}`);

const result = await Bun.build({
  entrypoints: [path.join(ROOT, "main.ts"), path.join(ROOT, "src/worker.ts")],
  compile: {
    outfile,
    ...(process.platform === "win32"
      ? {
          windows: {
            title: "Mudd.io",
            publisher: "Mudd.io",
            description: "Mudd.io - local-first prospect CRM",
            version: NUMERIC_VERSION,
            icon: ICON_PATH,
            hideConsole: false,
          },
        }
      : {}),
  },
  minify: true,
  // A release ships only the executable: Bun's maps carry the full source in sourcesContent.
  sourcemap: targetArg ? "none" : "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (process.platform === "darwin") {
  const app = await makeMacApp();
  await signMacApp(app);
  console.log(`Built ${app}`);
} else {
  console.log(`Built ${outfile}`);
}

/**
 * Wrap the executable in a .app so Finder launches it as an app rather than in a Terminal window.
 * The executable is moved, not copied: the bundle is the only thing a macOS build produces.
 */
async function makeMacApp(): Promise<string> {
  const { buildIcns, readIcoAsPngs } = await import("./scripts/icons");
  const app = path.join(OUT_DIR, `${APP_NAME}.app`);
  fs.rmSync(app, { recursive: true, force: true });
  const macos = path.join(app, "Contents", "MacOS");
  const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.renameSync(outfile, path.join(macos, APP_NAME));
  fs.chmodSync(path.join(macos, APP_NAME), 0o755);
  fs.writeFileSync(path.join(resources, "icon.icns"), buildIcns(await readIcoAsPngs(ICON_PATH)));
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${NUMERIC_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${NUMERIC_VERSION}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- AI sign-in opens Terminal through an Apple Event (src/server/ai/index.ts). Without this
       key macOS refuses the event with no prompt at all. -->
  <key>NSAppleEventsUsageDescription</key>
  <string>${APP_NAME} opens a Terminal window so you can sign in to your AI provider.</string>
</dict>
</plist>
`,
  );
  return app;
}

/**
 * Ad-hoc sign the bundle. `bun build --compile` appends the app to a signed Bun runtime, which
 * leaves the signature invalid, and Apple silicon kills a binary with an invalid signature on
 * launch ("Killed: 9"). Ad-hoc is enough to run; it is not notarization, so Gatekeeper still
 * warns about an unidentified developer.
 */
async function signMacApp(app: string): Promise<void> {
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err.trim()}`);
  };
  await run(["xattr", "-cr", app]);
  await run(["codesign", "--force", "--timestamp=none", "-s", "-", app]);
  await run(["codesign", "--verify", "--deep", "--strict", app]);
}
