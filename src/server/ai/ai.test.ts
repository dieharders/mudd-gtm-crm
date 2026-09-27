import { describe, expect, test } from "bun:test";
import { mergeSources } from "../../shared/ai";
import { genericSchema } from "../../xlsx/layouts";
import { enrichRequest, introRequest } from "../enrich/prompts";
import { parseAuthStatus } from "./claude";
import { buildArgs } from "./codex";
import { compareVersions, parseVersion } from "./discovery";
import { extractJson } from "./index";

describe("extractJson", () => {
  test("reads a bare object, a fenced one, and one wrapped in prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: "}" } });
    expect(extractJson('Sure! {"x": "y"} Hope that helps.')).toEqual({ x: "y" });
  });
  test("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("claude auth status", () => {
  test("a subscription login", () => {
    const a = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.co", subscriptionType: "max" }));
    expect(a).toMatchObject({ state: "ok", plan: "max", account: "a@b.co", subscription: true, keySource: null });
  });
  test("an API key in front of the login is per-token billing", () => {
    const a = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" }));
    expect(a.subscription).toBe(false);
    expect(a.keySource).toBe("ANTHROPIC_API_KEY");
  });
  test("signed out, and unreadable", () => {
    expect(parseAuthStatus('{"loggedIn": false}').state).toBe("logged_out");
    expect(parseAuthStatus("oops").state).toBe("unknown");
  });
});

describe("codex args", () => {
  test("read-only sandbox, web search, model and the system prompt prepended", () => {
    const args = buildArgs(["codex"], { prompt: "P", system: "S", model: "gpt-x", effort: "low", webSearch: true, cwd: "." });
    expect(args.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain("tools.web_search=true");
    expect(args).toContain("--model");
    expect(args.at(-1)!.startsWith("S\n\n---\n\nP")).toBe(true);
  });
});

describe("versions", () => {
  test("parse and compare", () => {
    expect(parseVersion("2.1.251 (Claude Code)")).toBe("2.1.251");
    expect(compareVersions("2.1.251", "2.1.41")).toBeGreaterThan(0);
    expect(compareVersions("0.78.9", "0.79.0")).toBeLessThan(0);
  });
});

describe("sources", () => {
  test("merge keeps existing lines and skips duplicates", () => {
    const a = mergeSources(null, "Website", [{ url: "https://x.io" }]);
    const b = mergeSources(a, "Website", [{ url: "https://x.io" }, { url: "https://y.io" }]);
    expect(b.split("\n")).toEqual(["Website: https://x.io", "Website: https://y.io"]);
  });
});

describe("prompts", () => {
  const schema = genericSchema();
  const k = (h: string) => schema.columns.find((c) => c.header === h)!.key;
  test("enrich request: one schema property per output, select options named, current value shown", () => {
    const recipe = { id: "r", campaignId: "c", name: "t", instructions: "Find it.", inputKeys: [], webSearch: true, createdAt: 0, updatedAt: 0,
      outputs: [{ key: k("Website"), header: "Website" }, { key: k("Status"), header: "Status" }] };
    const req = enrichRequest(recipe, schema, { [k("Company")]: "Acme", [k("Website")]: "acme.io" });
    const props = (req.jsonSchema.properties as { fields: { properties: Record<string, unknown> } }).fields.properties;
    expect(Object.keys(props)).toEqual([k("Website"), k("Status")]);
    expect(req.prompt).toContain('"Company":"Acme"');
    expect(req.prompt).toContain("Must be exactly one of:");
    expect(req.prompt).toContain('currently has "acme.io"');
    const ok = req.schema.safeParse({ fields: { [k("Website")]: { value: "https://acme.io", source: "https://acme.io", confidence: "high" } }, notes: null });
    expect(ok.success).toBe(true);
  });
  test("intro request pre-fills templates and limits the pool to the chosen one", () => {
    const templates = [
      { id: "t1", campaignId: "c", name: "Warm", body: "Hi {{First name}} at {{Company}}", position: 0, updatedAt: 0 },
      { id: "t2", campaignId: "c", name: "Cold", body: "Hello", position: 1, updatedAt: 0 },
    ];
    const req = introRequest(templates, "t1", undefined, schema, { [k("Name")]: "Ann Lee", [k("Company")]: "Acme" }, true);
    expect(req.templates.map((t) => t.id)).toEqual(["t1"]);
    expect(req.prompt).toContain("Hi Ann at Acme");
    expect(introRequest(templates, "auto", undefined, schema, {}, true).templates).toHaveLength(2);
  });
});
