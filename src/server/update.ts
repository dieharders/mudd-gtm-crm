/**
 * Updates from GitHub Releases: the only request Mudd makes on its own. It asks GitHub for the
 * latest published release (drafts and prereleases are never "latest"), and to update, downloads
 * this platform's zip, checks it against the SHA-256 GitHub lists for it, and swaps it in.
 *
 * The swap is a rename. A running program can't be overwritten, but on every platform it can be
 * renamed: the running copy becomes `<name>.old`, the new one takes its name, and the next launch
 * runs the new one. macOS and Linux delete the old copy at once; Windows can't delete a running
 * exe, so the next launch does (cleanUpAfterUpdate).
 *
 * What is replaced is the executable, or on macOS the whole Mudd.app. Data lives elsewhere
 * (db.dataDir), so it carries over untouched.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { version as CURRENT_VERSION } from "../../package.json";
import type { UpdateInfo } from "../shared/types";
import { compareVersions } from "./ai/discovery";

export const RELEASES_REPO = "dieharders/mudd-gtm-crm";
const LATEST_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "Mudd" };

/** This build's name in release downloads, as release.yml names them: `Mudd-<version>-<target>.zip`. */
export const TARGET = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

export { CURRENT_VERSION };

/** The parts of GitHub's release JSON used here. */
export interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
}

/**
 * What an update replaces: this executable, or on macOS the .app around it. Null when Mudd runs
 * from source, where the executable is Bun itself.
 */
export function installTarget(execPath = process.execPath, platform = process.platform): string | null {
  if (/^bun(\.exe)?$/i.test(path.basename(execPath))) return null;
  if (platform !== "darwin") return execPath;
  const app = path.resolve(execPath, "..", "..", "..");
  return app.endsWith(".app") ? app : null;
}

export function blockedReason(target: string | null, platform = process.platform): string | null {
  if (!target) return "Mudd is running from source.";
  // macOS runs an app opened from where it was downloaded from a hidden read-only copy.
  if (platform === "darwin" && target.includes("/AppTranslocation/")) return "Move Mudd to your Applications folder to update it in place.";
  // Write a file to find out: on Windows fs.access only reads the read-only flag, not the folder's
  // permissions, so it would pass Program Files.
  const probe = path.join(path.dirname(target), `.mudd-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
  } catch {
    return "Mudd can't write to the folder it's in.";
  }
  return null;
}

const versionOf = (release: Release) => {
  const v = release.tag_name.replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
};

export const assetFor = (release: Release, target = TARGET) =>
  release.assets.find((a) => a.name === `Mudd-${versionOf(release)}-${target}.zip`) ?? null;

/** What to tell the UI about `release` (null: none found) from this build's point of view. */
export function describe(release: Release | null, current = CURRENT_VERSION, target = TARGET, blocked = blockedReason(installTarget())): UpdateInfo {
  const version = release && versionOf(release);
  // A release without this platform's download is not an update for it.
  const newer = release && version && compareVersions(version, current) > 0 && assetFor(release, target);
  return { current, latest: newer ? { version: version!, url: release.html_url } : null, installed: null, blocked };
}

/** The latest published release, or null when there is none. Throws when GitHub can't be asked. */
async function latestRelease(): Promise<Release | null> {
  let res: Response;
  try {
    res = await fetch(LATEST_URL, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Mudd couldn't reach GitHub for the update. Check your connection and try again.");
  }
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is turning away update requests for now. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub didn't answer about the update (${res.status}). Try again later.`);
  return (await res.json()) as Release;
}

/** The version swapped in by installUpdate, which runs once Mudd restarts. */
let installedVersion: string | null = null;

// GitHub allows an IP 60 unauthenticated requests an hour, shared with anything else on it. However
// often the page checks, ask at most once per half hour.
const CHECK_TTL = 30 * 60_000;
let lastCheck: { at: number; release: Promise<Release | null> } | null = null;

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (installedVersion) return { ...describe(null), installed: installedVersion };
  if (!lastCheck || Date.now() - lastCheck.at > CHECK_TTL) {
    // Offline, or GitHub is down: no update to offer, and nothing worth telling the user.
    lastCheck = { at: Date.now(), release: latestRelease().catch(() => null) };
  }
  return describe(await lastCheck.release);
}

/** GitHub lists `sha256:<hex>` for each release download; older releases have no digest. */
export function verifyDownload(bytes: Uint8Array, asset: Release["assets"][number]): void {
  if (bytes.length !== asset.size) throw new Error("The update didn't download completely. Try again.");
  const [algo, hex] = asset.digest?.split(":") ?? [];
  if (algo === "sha256" && createHash("sha256").update(bytes).digest("hex") !== hex) {
    throw new Error("The update's download is damaged (its checksum doesn't match). Try again.");
  }
}

const sidecar = (target: string, kind: "new" | "old") => `${target}.${kind}`;

/**
 * Unpack `zip` beside `target` and swap it in. On macOS the zip holds Mudd.app; elsewhere, the one
 * executable. Exported for tests, which point it at a scratch folder.
 */
export async function applyUpdate(zip: Uint8Array, target: string, platform = process.platform): Promise<void> {
  const fresh = sidecar(target, "new");
  const old = sidecar(target, "old");
  // Read the download before touching anything beside Mudd, so that only a failure there, where
  // Mudd is installed, reads as "can't replace itself".
  const staged = platform === "darwin" ? stageApp(zip) : await readExe(zip);

  let incoming: string;
  try {
    fs.rmSync(fresh, { recursive: true, force: true });
    incoming = await staged.unpack(fresh);
    fs.rmSync(old, { recursive: true, force: true });
    fs.renameSync(target, old);
  } catch (err) {
    try {
      fs.rmSync(fresh, { recursive: true, force: true });
    } catch {
      // Still locked; cleanUpAfterUpdate tries again on the next launch.
    }
    // Say so, rather than "EPERM: operation not permitted, open '…\Mudd.exe.new'".
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") throw new Error("Mudd can't replace itself where it's installed. Download the update instead.");
    throw err;
  } finally {
    staged.discard();
  }
  try {
    fs.renameSync(incoming, target);
  } catch (err) {
    fs.renameSync(old, target);
    throw err;
  }
  // On macOS, the folder the app was unpacked into; elsewhere it was the exe, now moved.
  fs.rmSync(fresh, { recursive: true, force: true });
  // A running program's file can be deleted on macOS and Linux; Windows waits for the next launch.
  if (platform !== "win32") fs.rmSync(old, { recursive: true, force: true });
}

/** A download made ready without touching Mudd's folder. `unpack` writes it to `out` there. */
interface Staged {
  unpack(out: string): Promise<string>;
  discard(): void;
}

/** Windows and Linux: the zip holds the one executable, written to `out`. */
async function readExe(zip: Uint8Array): Promise<Staged> {
  const files = Object.values((await JSZip.loadAsync(zip)).files).filter((f) => !f.dir);
  if (files.length !== 1) throw new Error("The update's download isn't a Mudd build.");
  const bytes = await files[0]!.async("uint8array");
  return {
    async unpack(out) {
      fs.writeFileSync(out, bytes, { mode: 0o755 });
      return out;
    },
    discard() {},
  };
}

/**
 * macOS: ditto made the zip (release.yml), so ditto unpacks it, into the folder `out`: symlinks,
 * modes and the code signature come out exactly as they went in. `unpack` returns the Mudd.app in
 * `out`. The zip waits in the temp folder until then.
 */
function stageApp(zip: Uint8Array): Staged {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-update-"));
  const discard = () => fs.rmSync(scratch, { recursive: true, force: true });
  const file = path.join(scratch, "update.zip");
  try {
    fs.writeFileSync(file, zip);
  } catch (err) {
    discard();
    throw err;
  }
  return {
    async unpack(out) {
      // Made here rather than by ditto, so a folder Mudd can't write to fails with EACCES, not
      // ditto's "Permission denied" text.
      fs.mkdirSync(out);
      await run(["ditto", "-x", "-k", file, out], "The update's download couldn't be unpacked");
      const apps = fs.readdirSync(out).filter((name) => name.endsWith(".app"));
      const app = apps.length === 1 ? path.join(out, apps[0]!) : null;
      if (!app || !fs.existsSync(path.join(app, "Contents", "MacOS", "Mudd"))) throw new Error("The update's download has no Mudd.app in it.");
      // A broken seal would only show up as macOS's "Mudd is damaged" on the next launch.
      await run(["codesign", "--verify", "--deep", "--strict", app], "The update's signature doesn't check out");
      return app;
    },
    discard,
  };
}

/** Run a macOS tool. When it fails, throws `message` with what the tool said. */
async function run(cmd: string[], message: string): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${message}: ${err.trim()}`);
}

async function download(url: string): Promise<Uint8Array> {
  const offline = "The update couldn't be downloaded. Check your connection and try again.";
  const res = await fetch(url, { headers: { "User-Agent": "Mudd" }, signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
  if (!res) throw new Error(offline);
  if (!res.ok) throw new Error(`The update couldn't be downloaded (${res.status}). Try again.`);
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    throw new Error(offline);
  }
}

let installing = false;

/** Download the latest release and swap it in. Mudd runs it from the next launch (see relaunch). */
export async function installUpdate(): Promise<{ version: string }> {
  // A second install would download the same release again, and on Windows can't clear the
  // `.old` copy aside: that is the exe still running.
  if (installedVersion) throw new Error(`Mudd ${installedVersion} is already installed. Restart Mudd to finish.`);
  if (installing) throw new Error("An update is already being installed.");
  installing = true;
  try {
    const target = installTarget();
    const blocked = blockedReason(target);
    if (blocked) throw new Error(blocked);
    const release = await latestRelease();
    const info = describe(release, CURRENT_VERSION, TARGET, null);
    if (!release || !info.latest) throw new Error("There's no newer version to install.");
    const asset = assetFor(release)!;
    const bytes = await download(asset.browser_download_url);
    verifyDownload(bytes, asset);
    await applyUpdate(bytes, target!);
    installedVersion = info.latest.version;
    return { version: installedVersion };
  } finally {
    installing = false;
  }
}

/**
 * Start the copy now at Mudd's path, which waits for this process to exit before it starts its
 * server (so it gets the same port, and with it the page's localStorage). Called as Mudd quits.
 */
export function relaunch(): void {
  const target = installTarget();
  if (!target) return;
  const args = [`--wait-for=${process.pid}`];
  // `open -n`: a fresh instance even while this one is still running, launched as an app.
  const [cmd, argv] = process.platform === "darwin" ? ["open", ["-n", target, "--args", ...args]] : [target, args];
  // Not windowsHide: Windows applies SW_HIDE to a new process's first ShowWindow, which would be
  // the new Mudd's main window. Detached, it gets no console window to hide anyway.
  spawn(cmd, argv, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

/** Wait (up to `timeoutMs`) for process `pid` to exit. */
export async function waitForExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(100);
  }
}

/** Remove what an update left beside Mudd: the previous copy, or a half-unpacked new one. */
export function cleanUpAfterUpdate(target = installTarget()): void {
  if (!target) return;
  for (const kind of ["old", "new"] as const) {
    try {
      fs.rmSync(sidecar(target, kind), { recursive: true, force: true });
    } catch {
      // Still in use; the next launch tries again.
    }
  }
}
