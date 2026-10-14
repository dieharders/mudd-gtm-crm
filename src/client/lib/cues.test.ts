import { describe, expect, test } from "bun:test";
import { genericSchema } from "../../shared/schema";
import { cueFor } from "./cues";

describe("cues", () => {
  // The Contacts grid's schema: the contacts' own, keys and all.
  const cs = genericSchema().contacts!;
  const email = cs.columns.find((c) => c.header === "Email")!;
  const source = cs.emailSourceKey!;

  test("a Pattern email is flagged to verify, by the contacts' Email source, however the cell spells it", () => {
    for (const v of ["Pattern", "pattern"]) expect(cueFor(email, { [email.key]: "ann@acme.io", [source]: v }, cs)).toBe("unverified");
    expect(cueFor(email, { [email.key]: "ann@acme.io", [source]: "Published" }, cs)).toBeNull();
    expect(cueFor(email, { [source]: "Pattern" }, cs)).toBeNull();
  });
});
