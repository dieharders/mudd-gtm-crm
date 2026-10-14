import { describe, expect, test } from "bun:test";
import { makeKey } from "../../shared/schema";
import type { CampaignSchema, Column, ColumnType } from "../../shared/types";
import { cardLayout, pinnedCount } from "./listLayout";

/** A schema with these columns, its Company and ID being Mudd's. */
function sheet(...cols: [string, ColumnType?][]): CampaignSchema {
  const taken = new Set<string>();
  const columns = cols.map(([header, type = "text"]): Column => ({ key: makeKey(header, taken), header, type, origin: "sheet" }));
  const keyOf = (header: string) => columns.find((c) => c.header === header)?.key;
  return { columns, companyKey: keyOf("Company"), idKey: keyOf("ID") };
}
const headers = (cols: { header: string }[]) => cols.map((c) => c.header);

describe("card layout", () => {
  test("the title is the company, and the ID is never on the card", () => {
    const layout = cardLayout(sheet(["ID"], ["Company"], ["Location"]));
    expect(layout.titleKey).toBe("company");
    expect(headers(layout.facts)).toEqual(["Location"]);
  });

  test("the grid pins through the company column, not a fixed two", () => {
    const pinned = (...headers: string[]) => {
      const s = sheet(...headers.map((h): [string] => [h]));
      return pinnedCount(s.columns, s);
    };
    expect(pinned("Company", "Motion", "Tier")).toBe(1);
    expect(pinned("Tier", "Company", "Location")).toBe(2);
    expect(pinned("Name", "Email", "Phone", "Notes", "Company")).toBe(1);
    expect(pinned("Name", "Email")).toBe(1);
    expect(pinned()).toBe(0);
  });

  test("hook columns read first, in the order intros prefer them, whatever their type", () => {
    const layout = cardLayout(sheet(["Company"], ["Notes", "longtext"], ["Pitch", "longtext"], ["Icebreaker"], ["Hook", "longtext"]));
    expect(headers(layout.paragraphs)).toEqual(["Hook", "Icebreaker", "Notes", "Pitch"]);
    expect(headers(layout.facts)).toEqual([]);
  });
});
