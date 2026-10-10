/**
 * The Windows data folder: %APPDATA%\Mudd, with an earlier build's %APPDATA%\Mudd.io moved into it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./db";

describe.skipIf(process.platform !== "win32")("dataDir on Windows", () => {
  const saved = { data: process.env.MUDD_DATA_DIR, appdata: process.env.APPDATA };
  let appdata: string;

  beforeEach(() => {
    appdata = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-appdata-"));
    delete process.env.MUDD_DATA_DIR;
    process.env.APPDATA = appdata;
  });

  afterEach(() => {
    if (saved.data === undefined) delete process.env.MUDD_DATA_DIR;
    else process.env.MUDD_DATA_DIR = saved.data;
    process.env.APPDATA = saved.appdata;
    fs.rmSync(appdata, { recursive: true, force: true });
  });

  test("is %APPDATA%\\Mudd", () => {
    expect(dataDir()).toBe(path.join(appdata, "Mudd"));
  });

  test("moves an earlier build's Mudd.io folder over, contents and all", () => {
    fs.mkdirSync(path.join(appdata, "Mudd.io"));
    fs.writeFileSync(path.join(appdata, "Mudd.io", "mudd.sqlite"), "campaigns");

    expect(dataDir()).toBe(path.join(appdata, "Mudd"));
    expect(fs.readFileSync(path.join(appdata, "Mudd", "mudd.sqlite"), "utf8")).toBe("campaigns");
    expect(fs.existsSync(path.join(appdata, "Mudd.io"))).toBe(false);
  });

  test("leaves both alone when Mudd already exists", () => {
    fs.mkdirSync(path.join(appdata, "Mudd"));
    fs.mkdirSync(path.join(appdata, "Mudd.io"));

    expect(dataDir()).toBe(path.join(appdata, "Mudd"));
    expect(fs.existsSync(path.join(appdata, "Mudd.io"))).toBe(true);
  });

  test("MUDD_DATA_DIR still wins", () => {
    process.env.MUDD_DATA_DIR = path.join(appdata, "elsewhere");
    fs.mkdirSync(path.join(appdata, "Mudd.io"));

    expect(dataDir()).toBe(path.join(appdata, "elsewhere"));
    expect(fs.existsSync(path.join(appdata, "Mudd.io"))).toBe(true);
  });
});
