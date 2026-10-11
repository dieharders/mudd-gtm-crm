/**
 * Managed installs: the vendor's own binary, downloaded into Mudd's folder, so nobody needs npm,
 * Node or a terminal to use their plan.
 *
 * This does what the vendors' installer scripts do (read the release manifest, download the
 * platform build, check its SHA-256) without the shell. The copy goes in Mudd's own folder and
 * NOT on PATH: a GUI app's PATH is fixed at launch, so a PATH install would not be found until a
 * restart, and a user's own `claude` stays theirs. Uninstalling is deleting the folder. Sign-in
 * is still shared: the CLIs keep credentials in `~/.claude` and `~/.codex`, not here.
 */
import type { FileSink } from "bun";
import fs from "node:fs";
import path from "node:path";
import type { ProviderId } from "../../shared/ai";
import { localDataDir } from "../db";

const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const CODEX_CHANNEL = "https://releases.openai.com/codex/channels/latest";
const IS_WIN = process.platform === "win32";
/** The release lists are small: past this, the vendor isn't answering. */
const LIST_TIMEOUT_MS = 30_000;
/** A download that receives nothing for this long has stalled. */
const STALL_MS = 60_000;

export type InstallLog = (line: string) => void;

export class ChecksumError extends Error {
  constructor(expected: string, actual: string) {
    super(`checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

const binDir = (id: ProviderId) => path.join(localDataDir(), "bin", id);
const exe = (name: string) => (IS_WIN ? `${name}.exe` : name);

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `process.arch` says x64 under Rosetta on Apple silicon, which would fetch the Intel build. */
function effectiveArch(): "x64" | "arm64" {
  if (process.platform === "darwin") {
    try {
      if (Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"], { stderr: "ignore" }).stdout.toString().trim() === "1") return "arm64";
    } catch {
      /* not translated */
    }
  }
  return process.arch === "arm64" ? "arm64" : "x64";
}

/** A glibc build crashes on musl (Alpine) instead of failing clearly. */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
  } catch {
    /* fall through to the filesystem */
  }
  try {
    return fs.readdirSync("/lib").some((f) => /^libc\.musl-.*\.so\.1$/.test(f));
  } catch {
    return false;
  }
}

/** Anthropic's manifest key, e.g. `win32-x64`, `linux-x64-musl`. */
function claudePlatformKey(): string {
  const arch = effectiveArch();
  if (IS_WIN) return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  return `linux-${arch}${isMusl() ? "-musl" : ""}`;
}

/** OpenAI's Rust target triple. Their Linux builds are static musl and run on glibc too. */
function codexTargetTriple(): string {
  const arch = effectiveArch() === "arm64" ? "aarch64" : "x86_64";
  if (IS_WIN) return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-musl`;
}

/**
 * The managed copy's executable, or null when there is none. Codex ships a package tree (the
 * launcher next to its ripgrep and sandbox helpers), so its launcher is looked for by name
 * rather than assumed at one path.
 */
export function managedBinary(id: ProviderId): string | null {
  const dir = binDir(id);
  if (id === "claude") {
    const p = path.join(dir, exe("claude"));
    return isFile(p) ? p : null;
  }
  return codexLauncher(dir);
}

function codexLauncher(dir: string): string | null {
  for (const sub of ["bin", ""]) {
    for (const name of [exe("codex"), exe(`codex-${codexTargetTriple()}`)]) {
      const p = path.join(dir, sub, name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

const humanBytes = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

/** Progress every 10%, not every chunk: a 200 MB download is tens of thousands of chunks. */
function tenPercent(log: InstallLog) {
  let last = -1;
  return (received: number, total: number) => {
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct >= last + 10) {
      last = pct;
      log(`${pct}% (${humanBytes(received)}${total ? ` of ${humanBytes(total)}` : ""})`);
    }
  };
}

/**
 * Download to a staging file, hashing as it streams, and move it into place only once the hash
 * matches: an interrupted download must never leave a truncated binary where discovery looks.
 */
async function downloadVerified(
  spec: { url: string; sha256: string; size: number; dest: string; executable?: boolean },
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  fs.mkdirSync(path.dirname(spec.dest), { recursive: true });
  const staging = `${spec.dest}.partial`;
  // No overall limit (a slow line is fine), only on receiving nothing at all.
  const stall = new AbortController();
  let stallTimer = setTimeout(() => stall.abort(), STALL_MS);
  let sink: FileSink | null = null;
  try {
    const res = await fetch(spec.url, { signal: AbortSignal.any([signal, stall.signal]) });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || spec.size;
    const hasher = new Bun.CryptoHasher("sha256");
    sink = Bun.file(staging).writer();
    let received = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), STALL_MS);
      hasher.update(chunk);
      await sink.write(chunk);
      received += chunk.byteLength;
      onProgress(received, total);
    }
    const open = sink;
    sink = null;
    await open.end();
    const actual = hasher.digest("hex");
    if (actual.toLowerCase() !== spec.sha256.toLowerCase()) throw new ChecksumError(spec.sha256, actual);
    // Remove first: on Windows a rename onto an existing file fails.
    fs.rmSync(spec.dest, { force: true });
    fs.renameSync(staging, spec.dest);
    if (spec.executable && !IS_WIN) fs.chmodSync(spec.dest, 0o755);
  } catch (err) {
    if (stall.signal.aborted && !signal.aborted) throw new Error("the download stopped receiving data. Check your connection and try again.", { cause: err });
    throw err;
  } finally {
    clearTimeout(stallTimer);
    // Closed before the staging file is removed: Windows won't delete a file that is still open.
    await Promise.resolve(sink?.end()).catch(() => {});
    removeQuietly(staging);
  }
}

/** Clean-up that must never replace the error that made it necessary. */
function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    console.error(`[install] could not remove ${p}:`, err);
  }
}

/**
 * Windows' own bsdtar (Windows 10 1803+) before any `tar` on PATH: GNU tar from Git or MSYS2
 * reads `C:\…` as a remote host. Run in the archive's folder with a bare file name, so no tar
 * ever sees a drive letter.
 */
async function extractTarGz(archive: string): Promise<void> {
  const system = IS_WIN && process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : null;
  const tar = system && isFile(system) ? system : Bun.which("tar");
  if (!tar) throw new Error("`tar` was not found, so the package cannot be unpacked.");
  const proc = Bun.spawn([tar, "-xzf", path.basename(archive)], { cwd: path.dirname(archive), stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.slice(0, 400)}`);
}

const listSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]);

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal: listSignal(signal) });
  if (!res.ok) throw new Error(`could not read the release list (HTTP ${res.status})`);
  return (await res.json()) as T;
}

async function installClaude(signal: AbortSignal, log: InstallLog): Promise<string> {
  // `stable`, the build Anthropic has promoted, rather than the newest one published.
  const res = await fetch(`${CLAUDE_RELEASES}/stable`, { signal: listSignal(signal) });
  if (!res.ok) throw new Error(`could not read the release list (HTTP ${res.status})`);
  const version = (await res.text()).trim();
  log(`Claude Code ${version}`);
  const manifest = await fetchJson<{ platforms: Record<string, { binary: string; checksum: string; size: number }> }>(`${CLAUDE_RELEASES}/${version}/manifest.json`, signal);
  const key = claudePlatformKey();
  const entry = manifest.platforms[key];
  if (!entry) throw new Error(`Anthropic does not publish a build for ${key}.`);
  const dest = path.join(binDir("claude"), exe("claude"));
  log(`Downloading ${humanBytes(entry.size)}…`);
  await downloadVerified({ url: `${CLAUDE_RELEASES}/${version}/${key}/${entry.binary}`, sha256: entry.checksum, size: entry.size, dest, executable: true }, signal, tenPercent(log));
  log("Checksum verified.");
  return dest;
}

async function installCodex(signal: AbortSignal, log: InstallLog): Promise<string> {
  const feed = await fetchJson<{ tag_name?: string; assets?: { name: string; digest?: string | null; browser_download_url: string }[] }>(CODEX_CHANNEL, signal);
  log(`Codex ${feed.tag_name ?? "(latest)"}`);
  const triple = codexTargetTriple();
  const wanted = `codex-package-${triple}.tar.gz`;
  const asset = feed.assets?.find((a) => a.name === wanted);
  if (!asset) throw new Error(`OpenAI does not publish a build for ${triple}.`);
  if (!asset.digest) throw new Error("The download carries no checksum, so it was not installed.");
  // Unpacked beside the live copy and swapped in whole, so a failed or changed package never
  // leaves old and new files mixed where discovery looks.
  const dir = binDir("codex");
  const staging = `${dir}.partial`;
  const old = `${dir}.old`;
  removeQuietly(staging);
  removeQuietly(old);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const archive = path.join(staging, wanted);
    log("Downloading…");
    await downloadVerified({ url: asset.browser_download_url, sha256: asset.digest.replace(/^sha256:/, ""), size: 0, dest: archive }, signal, tenPercent(log));
    log("Checksum verified. Unpacking…");
    await extractTarGz(archive);
    fs.rmSync(archive, { force: true });
    if (!codexLauncher(staging)) throw new Error("the package did not contain the Codex program.");
    if (fs.existsSync(dir)) {
      try {
        fs.renameSync(dir, old);
      } catch (err) {
        // Windows won't move a folder while a program in it runs.
        throw new Error("the current copy of Codex is in use. Wait for research to finish, then try again.", { cause: err });
      }
    }
    try {
      fs.renameSync(staging, dir);
    } catch (err) {
      if (fs.existsSync(old)) fs.renameSync(old, dir);
      throw err;
    }
  } finally {
    removeQuietly(staging);
    removeQuietly(old);
  }
  const found = managedBinary("codex");
  if (!found) throw new Error("the package did not contain the Codex program.");
  return found;
}

/** Install a provider's CLI into Mudd's folder. Throws with a message fit to show. */
export function installManaged(id: ProviderId, signal: AbortSignal, log: InstallLog): Promise<string> {
  return id === "claude" ? installClaude(signal, log) : installCodex(signal, log);
}
