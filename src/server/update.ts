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
import path from "node:path";
import JSZip from "jszip";
import { version as CURRENT_VERSION } from "../../package.json";
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

export interface UpdateInfo {
  current: string;
  /** A newer published release, or null when this is the newest (or GitHub couldn't be reached). */
  latest: { version: string; url: string } | null;
  /** Why Mudd can't update itself, so the UI offers the download page instead; null when it can. */
  blocked: string | null;
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
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
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
  return { current, latest: newer ? { version: version!, url: release.html_url } : null, blocked };
}

async function latestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(LATEST_URL, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Release) : null;
  } catch {
    // Offline, or GitHub is down: no update to offer, and nothing worth telling the user.
    return null;
  }
}

export const checkForUpdate = async (): Promise<UpdateInfo> => describe(await latestRelease());

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
  const book = await JSZip.loadAsync(zip);
  const fresh = sidecar(target, "new");
  const old = sidecar(target, "old");
  fs.rmSync(fresh, { recursive: true, force: true });

  // Finder's AppleDouble files ("._x", "__MACOSX/") carry nothing the app needs.
  const files = Object.values(book.files).filter((f) => !f.dir && !f.name.startsWith("__MACOSX/") && !path.posix.basename(f.name).startsWith("._"));
  if (platform === "darwin") {
    const app = files[0]?.name.split("/")[0];
    if (!app?.endsWith(".app")) throw new Error("The update's download has no Mudd.app in it.");
    for (const f of files) {
      if (!f.name.startsWith(`${app}/`) || f.name.split("/").includes("..")) continue;
      const out = path.join(fresh, ...f.name.slice(app.length + 1).split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // A file's mode travels in the zip; the executable must keep its x bit or the app won't open.
      const mode = typeof f.unixPermissions === "number" ? f.unixPermissions & 0o777 : 0;
      fs.writeFileSync(out, await f.async("uint8array"), { mode: mode || 0o644 });
    }
    const exe = path.join(fresh, "Contents", "MacOS", "Mudd");
    if (!fs.existsSync(exe)) throw new Error("The update's download has no Mudd.app in it.");
    fs.chmodSync(exe, 0o755);
    await checkSignature(fresh);
  } else {
    if (files.length !== 1) throw new Error("The update's download isn't a Mudd build.");
    fs.writeFileSync(fresh, await files[0]!.async("uint8array"), { mode: 0o755 });
  }

  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(target, old);
  try {
    fs.renameSync(fresh, target);
  } catch (err) {
    fs.renameSync(old, target);
    throw err;
  }
  // A running program's file can be deleted on macOS and Linux; Windows waits for the next launch.
  if (platform !== "win32") fs.rmSync(old, { recursive: true, force: true });
}

/** A broken seal would only show up as macOS's "Mudd is damaged" on the next launch. */
async function checkSignature(app: string): Promise<void> {
  const proc = Bun.spawn(["codesign", "--verify", "--deep", "--strict", app], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    fs.rmSync(app, { recursive: true, force: true });
    throw new Error(`The update's signature doesn't check out: ${err.trim()}`);
  }
}

let installing = false;

/** Download the latest release and swap it in. Mudd runs it from the next launch (see relaunch). */
export async function installUpdate(): Promise<{ version: string }> {
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
    const res = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Mudd" }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`The update couldn't be downloaded (${res.status}). Try again.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    verifyDownload(bytes, asset);
    await applyUpdate(bytes, target!);
    return { version: info.latest.version };
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
  spawn(cmd, argv, { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
