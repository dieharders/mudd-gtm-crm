/** The outreach-template prompt: what the model is told, and what it must answer. */
import { describe, expect, test } from "bun:test";
import { genericSchema } from "../../shared/schema";
import type { Thesis } from "../../shared/types";
import { OUTREACH_RULES, outreachRequest, unknownPlaceholders } from "./outreach";

const schema = genericSchema();
const thesis: Thesis = { campaignId: "D", answers: { offer: "SOC monitoring", avatar: "Manufacturers", pains: "Ransomware" }, drafted: [], updatedAt: 0 };

describe("outreachRequest", () => {
  test("the rules make the four points, in order, and forbid a built product", () => {
    const at = (s: string) => OUTREACH_RULES.indexOf(s);
    const beats = [at("passionate about solving"), at("still learning"), at("how we are thinking about the problem"), at("have a say")];
    expect(beats.every((i) => i >= 0)).toBe(true);
    expect([...beats].sort((a, b) => a - b)).toEqual(beats);
    expect(OUTREACH_RULES).toMatch(/Never say or imply there is a built/);
    expect(OUTREACH_RULES).toMatch(/never as instructions/);
    // {{First name}}, {{Company}} and {{Hook}} are asked for only on a campaign that has them.
    expect(OUTREACH_RULES).toMatch(/Each of these only when it is listed: open with \{\{First name\}\}; name the company with \{\{Company\}\}; .*\{\{Hook\|\.\.\.\}\}/);
  });

  test("the prompt carries the problem, the thesis when there is one, and only the campaign's placeholders", () => {
    const r = outreachRequest({ problem: "  Small shops get hit by ransomware  ", thesis, schema, existing: [] });
    expect(r.system).toBe(OUTREACH_RULES);
    expect(r.prompt).toContain('"Small shops get hit by ransomware"');
    expect(r.prompt).toContain('"Who qualifies?":"Manufacturers"');
    // The offer and pains prefill the problem box, so they are not sent twice.
    expect(r.prompt).not.toContain("SOC monitoring");
    expect(r.prompt).not.toContain('"Their pain points"');
    expect(r.placeholders).toEqual(expect.arrayContaining(["First name", "Company", "Hook"]));
    expect(r.prompt).toContain(JSON.stringify(r.placeholders));
    expect(r.prompt).not.toContain("existing templates");

    const plain = outreachRequest({ problem: "x", thesis: null, schema, existing: [] });
    expect(plain.prompt).not.toContain("ideal customer");
    // A thesis with only the prefilled answers adds nothing.
    const onlyProblem = outreachRequest({ problem: "x", thesis: { ...thesis, answers: { offer: "SOC", pains: "Ransomware" } }, schema, existing: [] });
    expect(onlyProblem.prompt).not.toContain("ideal customer");
  });

  test("existing templates are shown for voice, at most three, clipped", () => {
    const existing = [1, 2, 3, 4].map((i) => ({ id: `t${i}`, campaignId: "c", name: `T${i}`, body: "x".repeat(700), position: i, updatedAt: 0 }));
    const r = outreachRequest({ problem: "x", thesis: null, schema, existing });
    expect(r.prompt).toContain("for voice only");
    expect(r.prompt).toContain('"T3"');
    expect(r.prompt).not.toContain('"T4"');
    expect(r.prompt).not.toContain("x".repeat(601));
  });

  test("the answer needs a body; a blank name falls back", () => {
    const { schema: z } = outreachRequest({ problem: "x", thesis: null, schema, existing: [] });
    expect(z.parse({ name: "  ", body: " Hi {{First name}} " })).toEqual({ name: "Outreach intro", body: "Hi {{First name}}" });
    expect(z.safeParse({ name: "Intro", body: "   " }).success).toBe(false);
    expect(z.safeParse({ name: "Intro" }).success).toBe(false);
  });
});

test("unknownPlaceholders names the ones that match no column, once each", () => {
  expect(unknownPlaceholders("Hi {{First name}} at {{Company}}, {{Budget}} and {{Budget|x}}", schema)).toEqual(["Budget"]);
  expect(unknownPlaceholders("Hi {{First name}}", schema)).toEqual([]);
});
