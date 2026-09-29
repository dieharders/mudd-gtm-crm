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
  test("the contact's Title, Role and Salutation go in the contact box, not the fact chips", () => {
    const layout = cardLayout(sheet(["Company"], ["Name"], ["Title"], ["Decision maker title"], ["Salutation"], ["Location"]));
    expect(headers(layout.facts)).toEqual(["Location"]);
  });

  test("hook columns read first, in the order intros prefer them, whatever their type", () => {
    const layout = cardLayout(sheet(["Company"], ["Notes", "longtext"], ["Pitch", "longtext"], ["Icebreaker"], ["Hook", "longtext"]));
    expect(headers(layout.paragraphs)).toEqual(["Hook", "Icebreaker", "Notes", "Pitch"]);
    expect(headers(layout.facts)).toEqual([]);
  });
});
