/** The AI routes against a real SQLite file in a temp directory. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { genericSchema } from "../shared/schema";
import type { Campaign } from "../shared/types";
import { registerAiRoutes } from "./ai-routes";
import * as db from "./db";

type Handler = (req: Request, params: string[]) => Promise<Response> | Response;
const routes = new Map<string, Handler>();
registerAiRoutes((method, pattern, h) => routes.set(`${method} ${pattern}`, h), {
  json: (data, status = 200) => Response.json(data, { status }),
  body: async <T>(req: Request) => (await req.json()) as T,
  fail: (status, message) => {
    throw new Error(`${status}: ${message}`);
  },
});

let dir = "";
const prevDir = process.env.MUDD_DATA_DIR;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-routes-"));
  db.closeDb();
  process.env.MUDD_DATA_DIR = dir;
});
afterAll(() => {
  db.closeDb();
  if (prevDir === undefined) delete process.env.MUDD_DATA_DIR;
  else process.env.MUDD_DATA_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a recipe's new columns are typed as import types the header, on keys no deleted column used", async () => {
  const c = db.createCampaign({ name: "Test", schema: genericSchema(), sheets: [] });
  // A deleted "Contact email" column left its values behind, under its key.
  db.insertRows(c.id, [{ id: "r1", cells: { contact_email: "old@acme.io" } }]);
  const outputs = [{ header: "Contact email" }, { header: "Company news" }, { header: "Fleet size", hint: "x".repeat(90) }, { header: "Fleet type" }];
  const req = new Request("http://mudd.local/", { method: "POST", body: JSON.stringify({ name: "R", instructions: "Find it.", inputKeys: [], webSearch: false, outputs }) });
  const res = await routes.get("POST /api/campaigns/:id/recipes")!(req, [c.id]);
  const { campaign } = (await res.json()) as { campaign: Campaign };
  const col = (header: string) => campaign.schema.columns.find((x) => x.header === header)!;
  expect(col("Contact email")).toMatchObject({ key: "contact_email_2", type: "email" });
  expect(col("Company news").type).toBe("longtext");
  expect(col("Fleet size").type).toBe("longtext");
  expect(col("Fleet type").type).toBe("text");
});

test("a person's detail becomes a contact column, keyed apart from every other column", async () => {
  const c = db.createCampaign({ name: "Test", schema: genericSchema(), sheets: [] });
  // "Mobile" left values under its key; "Notes" is both the company's and a contact's.
  db.insertRows(c.id, [{ id: "r1", cells: { mobile: "555" } }]);
  const outputs = [
    { header: "Mobile", contact: true },
    { header: "Notes", contact: true },
    { header: "Headcount" },
    { header: "ID", key: c.schema.idKey },
  ];
  const req = new Request("http://mudd.local/", { method: "POST", body: JSON.stringify({ name: "R", instructions: "Find it.", inputKeys: [], webSearch: false, outputs }) });
  const res = await routes.get("POST /api/campaigns/:id/recipes")!(req, [c.id]);
  const { recipe, campaign } = (await res.json()) as { recipe: { outputs: { key: string; header: string }[] }; campaign: Campaign };
  const contactCol = (header: string) => campaign.schema.contacts!.columns.find((x) => x.header === header);
  expect(contactCol("Mobile")).toMatchObject({ key: "mobile_2", type: "phone", origin: "enrichment" });
  expect(campaign.schema.columns.some((x) => x.header === "Mobile")).toBe(false);
  expect(campaign.schema.columns.find((x) => x.header === "Headcount")).toBeDefined();
  // The contacts' own Notes, not the company's; nothing is researched into the ID.
  expect(recipe.outputs.map((o) => o.key)).toEqual(["mobile_2", "notes_2", campaign.schema.columns.find((x) => x.header === "Headcount")!.key]);
});
