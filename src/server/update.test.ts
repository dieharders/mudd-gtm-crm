/**
 * The updater without GitHub: which release counts as an update, checking a download, and the
 * swap itself, on a scratch folder standing in for where Mudd is installed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { applyUpdate, blockedReason, cleanUpAfterUpdate, describe as describeUpdate, installTarget, verifyDownload, waitForExit, type Release } from "./update";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-update-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const release = (tag: string, assets: string[]): Release => ({
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}`, size: 1 })),
});

describe("installTarget", () => {
  test("is the exe, the .app on macOS, and nothing when running from source", () => {
    expect(installTarget("C:\\Apps\\Mudd.exe", "win32")).toBe("C:\\Apps\\Mudd.exe");
    expect(installTarget("/home/me/Mudd", "linux")).toBe("/home/me/Mudd");
    expect(installTarget("/Applications/Mudd.app/Contents/MacOS/Mudd", "darwin")).toBe(path.resolve("/Applications/Mudd.app"));
    expect(installTarget("/Users/me/Mudd", "darwin")).toBeNull();
    expect(installTarget("C:\\Users\\me\\.bun\\bin\\bun.exe", "win32")).toBeNull();
    expect(installTarget("/usr/local/bin/bun", "linux")).toBeNull();
  });
});

describe("blockedReason", () => {
  test("lets Mudd update in a folder it can write to, and leaves nothing behind there", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "writable-"));
    expect(blockedReason(path.join(dir, "Mudd.exe"), "win32")).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("refuses one it can't write to, from source, and a translocated macOS app", () => {
    expect(blockedReason(path.join(tmp, "missing", "Mudd.exe"), "win32")).toMatch(/can't write/);
    expect(blockedReason(null)).toMatch(/from source/);
    expect(blockedReason("/private/var/folders/x/AppTranslocation/y/d/Mudd.app", "darwin")).toMatch(/Applications/);
  });
});

describe("which release is an update", () => {
  const check = (r: Release | null) => describeUpdate(r, "0.1.7", "windows-x64", null).latest;

  test("a newer version with this platform's download", () => {
    expect(check(release("v0.1.8", ["Mudd-0.1.8-windows-x64.zip", "Mudd-0.1.8-linux-x64.zip"]))).toEqual({
      version: "0.1.8",
      url: "https://github.com/x/y/releases/tag/v0.1.8",
    });
    expect(check(release("v0.2.0", ["Mudd-0.2.0-windows-x64.zip"]))?.version).toBe("0.2.0");
  });

  test("not this version, an older one, one without this platform, or a tag that isn't a version", () => {
    expect(check(release("v0.1.7", ["Mudd-0.1.7-windows-x64.zip"]))).toBeNull();
    expect(check(release("v0.1.6", ["Mudd-0.1.6-windows-x64.zip"]))).toBeNull();
    expect(check(release("v0.1.8", ["Mudd-0.1.8-linux-x64.zip", "Mudd-0.1.8-darwin-arm64.dmg"]))).toBeNull();
    expect(check(release("nightly", ["Mudd-nightly-windows-x64.zip"]))).toBeNull();
    expect(check(null)).toBeNull();
  });
});

describe("verifyDownload", () => {
  const bytes = new TextEncoder().encode("a build");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const asset = (size: number, digest?: string) => ({ name: "x.zip", browser_download_url: "", size, digest });

  test("passes a complete download whose checksum matches, or that has none listed", () => {
    expect(() => verifyDownload(bytes, asset(bytes.length, `sha256:${sha}`))).not.toThrow();
    expect(() => verifyDownload(bytes, asset(bytes.length))).not.toThrow();
  });

  test("refuses a short or damaged one", () => {
    expect(() => verifyDownload(bytes, asset(bytes.length + 1, `sha256:${sha}`))).toThrow(/completely/);
    expect(() => verifyDownload(bytes, asset(bytes.length, `sha256:${"0".repeat(64)}`))).toThrow(/damaged/);
  });
});

describe("applyUpdate", () => {
  const zipOf = async (files: Record<string, string>) => {
    const zip = new JSZip();
    for (const [name, text] of Object.entries(files)) zip.file(name, text);
    return zip.generateAsync({ type: "uint8array" });
  };
  const install = (name: string) => {
    const dir = fs.mkdtempSync(path.join(tmp, "app-"));
    const exe = path.join(dir, name);
    fs.writeFileSync(exe, "old build");
    return exe;
  };

  test("Linux: the new build takes the old one's place, and the old one is gone", async () => {
    const exe = install("Mudd");
    await applyUpdate(await zipOf({ Mudd: "new build" }), exe, "linux");
    expect(fs.readFileSync(exe, "utf8")).toBe("new build");
    expect(fs.readdirSync(path.dirname(exe))).toEqual(["Mudd"]);
    if (process.platform !== "win32") expect(fs.statSync(exe).mode & 0o111).toBeTruthy();
  });

  test("Windows: the running exe is set aside, and removed on the next launch", async () => {
    // Keeps the user's own name for the exe, whatever the zip calls it.
    const exe = install("Mudd (2).exe");
    await applyUpdate(await zipOf({ "Mudd.exe": "new build" }), exe, "win32");
    expect(fs.readFileSync(exe, "utf8")).toBe("new build");
    expect(fs.readFileSync(`${exe}.old`, "utf8")).toBe("old build");
    cleanUpAfterUpdate(exe);
    expect(fs.readdirSync(path.dirname(exe))).toEqual(["Mudd (2).exe"]);
  });

  test("a download that isn't one build changes nothing", async () => {
    const exe = install("Mudd.exe");
    await expect(applyUpdate(await zipOf({ "Mudd.exe": "a", "other.exe": "b" }), exe, "win32")).rejects.toThrow(/isn't a Mudd build/);
    await expect(applyUpdate(new TextEncoder().encode("not a zip"), exe, "win32")).rejects.toThrow();
    expect(fs.readFileSync(exe, "utf8")).toBe("old build");
    cleanUpAfterUpdate(exe);
    expect(fs.readdirSync(path.dirname(exe))).toEqual(["Mudd.exe"]);
  });
});

describe("waitForExit", () => {
  test("returns once the process is gone, and at once for one that isn't running", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(400)"]);
    const started = Date.now();
    await waitForExit(child.pid, 10_000);
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);

    const gone = Date.now();
    await waitForExit(child.pid, 10_000);
    expect(Date.now() - gone).toBeLessThan(1_000);
  });
});
