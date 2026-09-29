import { describe, expect, test } from "bun:test";
import { PRESETS, presetTargets } from "./presets";
import { assignRoles, makeKey } from "./schema";
import type { CampaignSchema, CellValue } from "./types";
import { contactOf, rowTitle } from "./values";

/** A schema with these headers, keyed by header ("Job title" → job_title), roles assigned. */
function sheet(...headers: string[]): CampaignSchema {
  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: headers.map((header) => ({ key: makeKey(header, taken), header, type: "text", origin: "sheet" })) };
  assignRoles(schema);
  return schema;
}
const cellsOf = (values: Record<string, CellValue>) => Object.fromEntries(Object.entries(values).map(([h, v]) => [makeKey(h, new Set()), v]));

describe("contact", () => {
  test("a Title holding a job title is the role, as in older campaigns and CRM exports", () => {
    const c = contactOf(cellsOf({ Name: "Ann Lee", Title: "CEO" }), sheet("Name", "Company", "Title"));
    expect(c).toEqual({ name: "Ann Lee", role: "CEO", rest: [] });
  });

  test("a Title holding an honorific goes before the name, and the Role is the job", () => {
    const schema = sheet("Name", "Title", "Role");
    expect(contactOf(cellsOf({ Name: "Ann Lee", Title: "Dr.", Role: "CEO" }), schema)).toEqual({ name: "Dr. Ann Lee", role: "CEO", rest: [] });
    expect(contactOf(cellsOf({ Name: "Ann Lee", Title: "Lt. Col." }), schema).name).toBe("Lt. Col. Ann Lee");
  });

  test("a name that already has the honorific keeps it once", () => {
    expect(contactOf(cellsOf({ Name: "Dr. Ann Lee", Title: "Dr" }), sheet("Name", "Title")).name).toBe("Dr. Ann Lee");
  });

  test("nothing is dropped: an honorific with no name, a salutation that isn't one, a second job title", () => {
    expect(contactOf(cellsOf({ Title: "Dr." }), sheet("Name", "Title")).rest).toEqual([{ key: "title", value: "Dr." }]);
    const both = contactOf(cellsOf({ Name: "Ann Lee", Salutation: "Dear Ann", Title: "Col.", Role: "Founder" }), sheet("Name", "Salutation", "Title", "Role"));
    expect(both).toEqual({ name: "Col. Ann Lee", role: "Founder", rest: [{ key: "salutation", value: "Dear Ann" }] });
    expect(contactOf(cellsOf({ Title: "CEO", Role: "Founder" }), sheet("Title", "Role")).role).toBe("Founder · CEO");
    expect(contactOf(cellsOf({ Title: "CEO", Role: "ceo" }), sheet("Title", "Role")).role).toBe("ceo");
  });

  test("a hidden Title is left alone", () => {
    const schema = sheet("Name", "Title");
    schema.columns[1]!.hidden = true;
    expect(contactOf(cellsOf({ Name: "Ann Lee", Title: "Dr." }), schema)).toEqual({ name: "Ann Lee", role: "", rest: [] });
  });

  test("every view names the prospect the same way", () => {
    const row = { cells: cellsOf({ Company: "Acme", Name: "Ann Lee", Title: "Dr." }) };
    expect(rowTitle(row, sheet("Company", "Name", "Title"))).toEqual({ title: "Acme", subtitle: "Dr. Ann Lee" });
    expect(rowTitle(row, sheet("Name", "Title"))).toEqual({ title: "Dr. Ann Lee", subtitle: "" });
  });
});

describe("preset targets", () => {
  const role = PRESETS.find((p) => p.id === "decision-maker")!;
  const hook = PRESETS.find((p) => p.id === "hook")!;
  const roleTarget = (schema: CampaignSchema, rows: Record<string, CellValue>[] = []) =>
    presetTargets(role, schema, rows.map((r) => ({ cells: cellsOf(r) })))[1]?.header;

  test("the job title goes in Role, else in a Title that holds job titles", () => {
    expect(roleTarget(sheet("Name", "Title", "Role"))).toBe("Role");
    expect(roleTarget(sheet("Name", "Title"), [{ Title: "CEO" }])).toBe("Title");
    expect(roleTarget(sheet("Name", "Title"), [{ Title: "CEO" }, { Title: "Dr." }])).toBeUndefined();
  });

  test("the most preferred header wins, not the leftmost column", () => {
    expect(roleTarget(sheet("Position", "Role"))).toBe("Role");
    expect(presetTargets(hook, sheet("Angle", "Hook"), [])[0]?.header).toBe("Hook");
  });
});
