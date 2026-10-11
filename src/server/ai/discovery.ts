/**
 * Find an agent CLI on this machine and report how to spawn it.
 *
 * On Windows npm installs a bin as shims (`x.cmd`, `x.ps1`) that are not executables, and
 * spawning a `.cmd` goes through cmd.exe, which re-parses arguments — so a shim is resolved to
 * what it actually launches (`claude.exe`, or `[node, codex.js]`) and that is spawned directly.
 *
 * Search order: explicit env override → the copy Mudd installed (install.ts) → PATH (shims
 * resolved) → the npm global prefix → well-known directories → the copy bundled with the Claude
 * Agent SDK. Each candidate is asked for `--version`, and copies older than the minimum this app
 * drives are passed over.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "../../shared/ai";
import { managedBinary } from "./install";
import { captureCommand } from "./proc";

const IS_WIN = process.platform === "win32";

export interface CliSpec {
  id: ProviderId;
  binary: string;
  npm: { package: string; bin: string[] };
  /** Packages that bundle a platform binary (the Agent SDK ships Claude Code). */
  bundled?: { package: string; bin: string }[];
  minVersion: string;
  envOverride: string;
}

export interface Resolution {
  /** How to spawn it: `[exe]` or `[node, script.js]`. Empty when not found. */
  argv: string[];
  /** The executable (or script) found, for display and for the Agent SDK. */
  path: string | null;
  version: string | null;
  /** A copy was found but is older than `minVersion`. */
  outdated: string | null;
  searched: string[];
}

export const MIN_CLAUDE_VERSION = "2.1.41";
export const MIN_CODEX_VERSION = "0.79.0";

export const CLAUDE_SPEC: CliSpec = {
  id: "claude",
  binary: "claude",
  npm: { package: "@anthropic-ai/claude-code", bin: ["bin", IS_WIN ? "claude.exe" : "claude"] },
  bundled: [{ package: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, bin: IS_WIN ? "claude.exe" : "claude" }],
  minVersion: MIN_CLAUDE_VERSION,
  envOverride: "MUDD_CLAUDE_PATH",
};

export const CODEX_SPEC: CliSpec = {
  id: "codex",
  binary: "codex",
  npm: { package: "@openai/codex", bin: ["bin", "codex.js"] },
  minVersion: MIN_CODEX_VERSION,
  envOverride: "MUDD_CODEX_PATH",
};

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function argvFor(target: string): string[] {
  if (/\.(c?js|mjs)$/i.test(target)) {
    const node = Bun.which("node");
    return node ? [node, target] : [];
  }
  return [target];
}

function npmPrefixes(): string[] {
  const out: string[] = [];
  if (IS_WIN && process.env.APPDATA) out.push(path.join(process.env.APPDATA, "npm"));
  if (process.env.npm_config_prefix) out.push(process.env.npm_config_prefix);
  if (!IS_WIN) out.push("/usr/local", "/opt/homebrew", path.join(os.homedir(), ".npm-global"));
  return out;
}

function packageBin(prefix: string, spec: CliSpec): string {
  const nm = IS_WIN ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  return path.join(nm, ...spec.npm.package.split("/"), ...spec.npm.bin);
}

/** Map an npm Windows shim to the file it launches. */
function resolveShim(shim: string, spec: CliSpec): string | null {
  const direct = packageBin(path.dirname(shim), spec);
  if (exists(direct)) return direct;
  try {
    const body = fs.readFileSync(shim, "utf8");
    const m = /"%(?:~?dp0|~dp0)%\\?([^"]+?\.(?:exe|js|cjs|mjs))"/i.exec(body) ?? /\$basedir[/\\]([^"'\s]+?\.(?:exe|js|cjs|mjs))/i.exec(body);
    if (m) {
      const p = path.join(path.dirname(shim), m[1]!.replace(/^[\\/]/, ""));
      if (exists(p)) return p;
    }
  } catch {
    /* unreadable shim */
  }
  return null;
}

function candidates(spec: CliSpec): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(process.env[spec.envOverride]);
  // Before PATH: the copy Mudd installed is the one it knows works.
  add(managedBinary(spec.id));
  const onPath = Bun.which(spec.binary);
  if (onPath) add(IS_WIN && /\.(cmd|ps1|bat)$/i.test(onPath) ? resolveShim(onPath, spec) : onPath);
  if (IS_WIN) {
    for (const ext of [".cmd", ".ps1"]) {
      const shim = Bun.which(spec.binary + ext);
      if (shim) add(resolveShim(shim, spec));
    }
  }
  for (const prefix of npmPrefixes()) add(packageBin(prefix, spec));
  const home = os.homedir();
  const names = IS_WIN ? [`${spec.binary}.exe`] : [spec.binary];
  for (const dir of [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), path.join(home, "bin")]) {
    for (const n of names) add(path.join(dir, n));
  }
  for (const b of spec.bundled ?? []) {
    try {
      const pkg = Bun.resolveSync(`${b.package}/package.json`, import.meta.dir);
      add(path.join(path.dirname(pkg), b.bin));
    } catch {
      /* not installed */
    }
  }
  return out;
}

const cache = new Map<string, Resolution>();

/** Forget cached results, e.g. after the user installs a CLI and presses "Check again". */
export function resetDiscovery(): void {
  cache.clear();
}

export async function discoverCli(spec: CliSpec): Promise<Resolution> {
  const hit = cache.get(spec.binary);
  if (hit) return hit;
  const searched: string[] = [];
  let outdated: string | null = null;
  for (const target of candidates(spec)) {
    searched.push(target);
    if (!exists(target)) continue;
    const argv = argvFor(target);
    if (!argv.length) continue;
    const r = await captureCommand([...argv, "--version"], 15_000).catch(() => null);
    const version = r && !r.timedOut ? parseVersion(`${r.stdout}\n${r.stderr}`) : null;
    if (version && compareVersions(version, spec.minVersion) < 0) {
      outdated ??= version;
      continue;
    }
    const found: Resolution = { argv, path: target, version, outdated: null, searched };
    // Only success is cached: a CLI installed while the app runs is found on the next check.
    cache.set(spec.binary, found);
    return found;
  }
  return { argv: [], path: null, version: null, outdated, searched };
}
