import { describe, expect, test } from "bun:test";
import { mergeSources, SOURCES_HEADER, type SetupEvent } from "../../shared/ai";
import { allColumns, genericSchema } from "../../shared/schema";
import { enrichRequest, introRequest } from "../enrich/prompts";
import { parseAuthStatus } from "./claude";
import { buildArgs } from "./codex";
import { compareVersions, parseVersion } from "./discovery";
import { extractJson } from "./index";
import { extractUrl, runLogin } from "./login";

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

describe("sign-in", () => {
  test("the sign-in address wins over other links, and only once printed in full", () => {
    const out = "Update available: https://github.com/openai/codex/releases \nStarting server on http://localhost:1455\nOpen https://auth.openai.com/oauth/authorize?state=abc \n";
    expect(extractUrl(out)).toBe("https://auth.openai.com/oauth/authorize?state=abc");
    expect(extractUrl("visit: https://claude.com/cai/oauth/authorize?sta")).toBeNull();
  });

  const child = (lines: string[], exit: Promise<number>) => {
    const enc = new TextEncoder();
    const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const l of chunks) c.enqueue(enc.encode(l)); c.close(); } });
    return { stdout: stream(lines), stderr: stream([]), kill: () => {}, exited: exit };
  };

  test("finishes when somebody new is signed in, and reports the page", async () => {
    const events: SetupEvent[] = [];
    let who: string | null = null;
    setTimeout(() => (who = "a@b.co"), 20);
    await runLogin({
      provider: "codex", argv: ["codex", "login"], signal: new AbortController().signal, send: (e) => events.push(e),
      deps: { spawn: () => child(["Open https://auth.openai.com/oauth/authorize?x=1 \n", "Paste code here if prompted > "], new Promise(() => {})), identity: async () => who, pollMs: 10 },
    });
    expect(events.map((e) => e.type)).toEqual(["url", "done"]);
    expect(events.at(-1)).toMatchObject({ ok: true });
  });

  test("an exit with nobody signed in is a failure, whatever the code", async () => {
    const events: SetupEvent[] = [];
    await runLogin({
      provider: "claude", argv: ["claude", "auth", "login"], signal: new AbortController().signal, send: (e) => events.push(e),
      deps: { spawn: () => child([], Promise.resolve(0)), identity: async () => null, pollMs: 1_000 },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
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
  // The prospect's columns first, then its contacts' (Name is a contact's).
  const k = (h: string) => allColumns(schema).find((c) => c.header === h)!.key;
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
  test("the primary contact goes in nested, so a header both have keeps both values; the ID never goes", () => {
    const notes = schema.contacts!.columns.find((c) => c.header === "Notes")!.key;
    const recipe = { id: "r", campaignId: "c", name: "t", instructions: "Find it.", inputKeys: [], webSearch: true, createdAt: 0, updatedAt: 0,
      outputs: [{ key: k("Email"), header: "Email" }] };
    const cells = { [k("ID")]: "P-004", [k("Company")]: "Acme", [k("Notes")]: "Big fleet", [k("Name")]: "Ann Lee", [notes]: "Met at AUSA", [k("Primary")]: "TRUE" };
    const req = enrichRequest(recipe, schema, cells);
    expect(req.prompt).toContain('"Notes":"Big fleet","Primary contact":{"Name":"Ann Lee","Notes":"Met at AUSA"}');
    expect(req.prompt).not.toContain("P-004");
    // A contact column is filled like any other: keyed by its own key.
    expect(req.columns.map((c) => c.header)).toEqual(["Email"]);
  });
  test("a turn about one contact names them, and asks only what it's told to", () => {
    const recipe = { id: "r", campaignId: "c", name: "t", instructions: "Find it.", inputKeys: [], webSearch: true, createdAt: 0, updatedAt: 0,
      outputs: [{ key: k("Email"), header: "Email" }, { key: k("Website"), header: "Website" }] };
    const req = enrichRequest(recipe, schema, { [k("Company")]: "Acme", [k("Name")]: "Bob Ray" }, { contact: true, keys: new Set([k("Email")]) });
    expect(req.prompt).toContain('"Contact":{"Name":"Bob Ray"}');
    expect(req.prompt).toContain('about the person under "Contact"');
    expect(req.columns.map((c) => c.header)).toEqual(["Email"]);
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
  describe("what research found, and where an email came from", () => {
    const cs = schema.contacts!;
    // A Role the Decision-maker recipe made, and the sources cell research keeps.
    const researched = {
      ...schema,
      columns: [...schema.columns, { key: "src", header: SOURCES_HEADER, type: "longtext" as const, origin: "enrichment" as const }],
      contacts: { ...cs, columns: cs.columns.map((c) => (c.header === "Role" ? { ...c, origin: "enrichment" as const } : c)) },
    };
    const cells = { [k("Company")]: "Acme", [k("Name")]: "Ann Lee", [k("Role")]: "VP Operations", [cs.emailSourceKey!]: "Pattern", src: "Role: https://acme.io/team" };
    const recipe = (inputKeys: string[]) => ({ id: "r", campaignId: "c", name: "t", instructions: "Find it.", inputKeys, webSearch: true, createdAt: 0, updatedAt: 0,
      outputs: [{ key: k("Website"), header: "Website" }] });

    test("an intro is written from them, but never cites the sources cell or sends the email's source", () => {
      const req = introRequest([{ id: "t1", campaignId: "c", name: "Warm", body: "Hi", position: 0, updatedAt: 0 }], "t1", undefined, researched, cells, true);
      expect(req.prompt).toContain('"Contact":{"Name":"Ann Lee","Role":"VP Operations"}');
      expect(req.prompt).not.toContain("acme.io/team");
      expect(req.prompt).not.toContain("Email source");
    });

    test("a research turn is fed neither, even when the recipe names the email's source as an input", () => {
      expect(enrichRequest(recipe([]), researched, cells).prompt).toContain('"Primary contact":{"Name":"Ann Lee"}');
      const named = enrichRequest(recipe([k("Company"), cs.emailSourceKey!]), researched, cells).prompt;
      expect(named).toContain('"Company":"Acme"');
      expect(named).not.toContain("Email source");
    });
  });
  describe("intro request around the prospect's Hook", () => {
    const withSources = { ...schema, columns: [...schema.columns, { key: "src", header: SOURCES_HEADER, type: "longtext" as const, origin: "enrichment" as const }] };
    const t = (body: string) => [{ id: "t1", campaignId: "c", name: "Warm", body, position: 0, updatedAt: 0 }];
    const hook = "Won an AFWERX contract in May";
    const once = (prompt: string) => prompt.split("AFWERX contract").length === 2;

    test("sent once, with the source recorded for its value", () => {
      const cells = { [k("Company")]: "Acme", [k("Hook")]: hook };
      const req = introRequest(t("Hi {{First name}}"), "t1", undefined, schema, cells, true, (key) => (key === k("Hook") ? "https://afwerx.mil/acme" : null));
      expect(req.prompt).toContain(`Hook: "${hook}" (source: https://afwerx.mil/acme)`);
      expect(once(req.prompt)).toBe(true);
      expect(req.system).toContain("If a Hook is given");
      expect(introRequest(t("Hi {{First name}}"), "t1", undefined, schema, { [k("Company")]: "Acme" }, true).prompt).not.toContain("Hook:");
    });

    test("never cites a line in the sources cell, which may belong to an older hook", () => {
      const cells = { [k("Hook")]: hook, src: "Hook: https://stale.io" };
      expect(introRequest(t("Hi"), "t1", undefined, withSources, cells, true).prompt).toContain(`Hook: "${hook}"\n`);
    });

    test("a template's {{Hook}} is left for the model to write in, not pasted", () => {
      const req = introRequest(t("Hi {{First name}}, saw that {{Hook|you're growing}}."), "t1", undefined, schema, { [k("Name")]: "Ann Lee", [k("Hook")]: hook }, true);
      expect(req.prompt).toContain("Hi Ann, saw that {{Hook|you're growing}}.");
      expect(once(req.prompt)).toBe(true);
    });

    test("read from the first hook column the row fills, researched ones included", () => {
      const pers = { key: "pers", header: "Personalization", type: "longtext" as const, origin: "sheet" as const };
      const researched = { ...schema, columns: [...schema.columns.map((c) => (c.header === "Hook" ? { ...c, origin: "enrichment" as const } : c)), pers] };
      const empty = introRequest(t("Hi"), "t1", undefined, researched, { pers: hook }, true);
      expect(empty.prompt).toContain(`Hook (Personalization): "${hook}"`);
      expect(once(empty.prompt)).toBe(true);
      expect(introRequest(t("Hi"), "t1", undefined, researched, { [k("Hook")]: "Hired a CTO", pers: hook }, true).prompt).toContain('Hook: "Hired a CTO"');
    });

    test("cut to 600 characters, like every other value", () => {
      const req = introRequest(t("Hi"), "t1", undefined, schema, { [k("Hook")]: "x".repeat(5000) }, true);
      expect(req.prompt).toContain(`Hook: "${"x".repeat(600)}…"`);
      expect(req.prompt).not.toContain("x".repeat(601));
    });
  });
});
