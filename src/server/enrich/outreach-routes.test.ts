/** Generating a template through the REST API: consent, input checks, and that nothing is saved. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Campaign, Template } from "../../shared/types";
import * as ai from "../ai";

// Module mocks outlive this file, so anything that isn't one of these tests gets the real turn.
const realAi = { ...ai };
let fakeTurn: ((req: ai.StructuredRequest<unknown>) => Promise<{ data: unknown; costUsd: number | null }>) | null = null;
void mock.module("../ai", () => ({
  ...realAi,
  generateStructured: (req: ai.StructuredRequest<unknown>) => (fakeTurn ? fakeTurn(req) : realAi.generateStructured(req)),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-outreach-routes-"));
const prevDir = process.env.MUDD_DATA_DIR;
let handler: (req: Request) => Promise<Response>;
let db: typeof import("../db");
let settings: typeof import("../ai/settings");

beforeAll(async () => {
  process.env.MUDD_DATA_DIR = path.join(tmp, "data");
  db = await import("../db");
  db.closeDb();
  settings = await import("../ai/settings");
  handler = (await import("../index")).createFetchHandler();
  settings.updateAiSettings({ provider: "claude", consented: false });
});
afterAll(() => {
  fakeTurn = null;
  db.closeDb();
  if (prevDir === undefined) delete process.env.MUDD_DATA_DIR;
  else process.env.MUDD_DATA_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async <T,>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handler(new Request(`http://127.0.0.1${url}`, init));
  return { status: res.status, json: (await res.json()) as T };
};
const generate = (id: string, problem: string) => call<{ name: string; body: string; unknown: string[]; error?: string }>("POST", `/api/campaigns/${id}/templates/generate`, { problem });

describe("POST /api/campaigns/:id/templates/generate", () => {
  test("needs a problem, then consent", async () => {
    const c = (await call<Campaign>("POST", "/api/campaigns", { name: "Plain", layout: "generic" })).json;
    settings.updateAiSettings({ consented: false });
    expect((await generate(c.id, "   ")).status).toBe(400);
    const r = await generate(c.id, "Ransomware at small shops");
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/AI provider/);
    expect((await generate("nope", "x")).status).toBe(404);
  });

  test("returns the draft with its unknown placeholders, and saves nothing", async () => {
    const c = (await call<Campaign>("POST", "/api/campaigns", { name: "Disco", layout: "discovery", thesis: { offer: "SOC monitoring", avatar: "Manufacturers" } })).json;
    settings.updateAiSettings({ consented: true });
    let seen: ai.StructuredRequest<unknown> | null = null;
    fakeTurn = (req) => {
      seen = req;
      return Promise.resolve({ data: { name: "Learning intro", body: "Hi {{First name}} at {{Company}}, {{Budget}}\n\n[Your name]" }, costUsd: null });
    };
    try {
      const r = await generate(c.id, "Ransomware at small shops");
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ name: "Learning intro", body: "Hi {{First name}} at {{Company}}, {{Budget}}\n\n[Your name]", unknown: ["Budget"] });
      expect(seen!.webSearch).toBe(false);
      expect(seen!.prompt).toContain("Ransomware at small shops");
      expect(seen!.prompt).toContain('"SOC monitoring"');
      expect((await call<Template[]>("GET", `/api/campaigns/${c.id}/templates`)).json).toEqual([]);

      fakeTurn = () => Promise.reject(new ai.AiError("bad_output", "The reply could not be read."));
      const bad = await generate(c.id, "x");
      expect(bad.status).toBe(502);
      expect(bad.json.error).toMatch(/could not be read/);
    } finally {
      fakeTurn = null;
      settings.updateAiSettings({ consented: false });
    }
  });
});
