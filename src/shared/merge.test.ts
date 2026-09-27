import { describe, expect, test } from "bun:test";
import { firstNameOf, mergeTemplate } from "./merge";
import type { CampaignSchema } from "./types";

const schema: CampaignSchema = {
  columns: [
    { key: "contact", header: "Primary contact", type: "text" },
    { key: "company", header: "Company", type: "text" },
    { key: "hook", header: "Hook", type: "longtext" },
  ],
  nameKey: "contact",
  companyKey: "company",
};

describe("mergeTemplate", () => {
  test("fills headers case- and punctuation-insensitively, plus First name", () => {
    const r = mergeTemplate("Hi {{First name}} at {{company}} ({{PRIMARY CONTACT}})", schema, { contact: "Jenna Young, CF APMP", company: "Arlo" });
    expect(r.text).toBe("Hi Jenna at Arlo (Jenna Young, CF APMP)");
    expect(r.unknown).toEqual([]);
  });
  test("uses a fallback for empty cells and reports what was missing", () => {
    const r = mergeTemplate("{{Hook|your work}} / {{Hook}}", schema, {});
    expect(r.text).toBe("your work / ");
    expect(r.missing).toEqual(["Hook"]);
  });
  test("leaves unknown placeholders in place", () => {
    const r = mergeTemplate("Hi {{Frist name}}", schema, { contact: "Ann" });
    expect(r.text).toBe("Hi {{Frist name}}");
    expect(r.unknown).toEqual(["Frist name"]);
  });
  test("first name from multi-person cells", () => {
    expect(firstNameOf("Blair Tighe; Bob Nunnally; Jan Norris")).toBe("Blair");
    expect(firstNameOf("Tesfa 'Taz' Wube")).toBe("Tesfa");
  });
});
