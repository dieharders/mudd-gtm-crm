import { describe, expect, test } from "bun:test";
import { assignRoles, makeKey } from "../../shared/schema";
import type { CampaignSchema, ColumnType } from "../../shared/types";
import { cardLayout } from "./listLayout";

function sheet(...cols: [string, ColumnType?][]): CampaignSchema {
  const taken = new Set<string>();
  const schema: CampaignSchema = { columns: cols.map(([header, type = "text"]) => ({ key: makeKey(header, taken), header, type, origin: "sheet" })) };
  assignRoles(schema);
  return schema;
}
const headers = (cols: { header: string }[]) => cols.map((c) => c.header);

describe("card layout", () => {
  test("the title is the company, and the ID is never on the card", () => {
    const layout = cardLayout(sheet(["ID"], ["Company"], ["Location"]));
    expect(layout.titleKey).toBe("company");
    expect(headers(layout.facts)).toEqual(["Location"]);
  });

  test("hook columns read first, in the order intros prefer them, whatever their type", () => {
    const layout = cardLayout(sheet(["Company"], ["Notes", "longtext"], ["Pitch", "longtext"], ["Icebreaker"], ["Hook", "longtext"]));
    expect(headers(layout.paragraphs)).toEqual(["Hook", "Icebreaker", "Notes", "Pitch"]);
    expect(headers(layout.facts)).toEqual([]);
  });
});
