import { describe, expect, test } from "bun:test";
import { recipeMode } from "./ai";
import { PRESETS, presetTargets } from "./presets";
import { CONTACT_TYPES, ensureAppColumns, genericSchema, makeKey, newProspectId, prospectSchema } from "./schema";
import { CHECKED, type CampaignSchema, type CellValue, type Column } from "./types";
import { CompanyIndex, companyKeys, contactLabel, contactOf, isChannel, isEmptyContact, orderedContacts, primaryOf, prospectCells, prospectTitle } from "./values";

/**
 * A schema with these headers, keyed by header ("Job title" → job_title), its Company, Status
 * and ID being Mudd's. Read as a contact's columns, the name is theirs.
 */
function sheet(...headers: string[]): CampaignSchema {
  const taken = new Set<string>();
  const columns = headers.map((header): Column => ({ key: makeKey(header, taken), header, type: "text", origin: "sheet" }));
  const keyOf = (header: string) => columns.find((c) => c.header === header)?.key;
  return { columns, companyKey: keyOf("Company"), statusKey: keyOf("Status"), idKey: keyOf("ID"), nameKey: keyOf("Name") };
}
/** A campaign whose contacts have these columns, and no columns of its own. */
const people = (...headers: string[]): CampaignSchema => {
  const s = sheet(...headers);
  return { columns: [], contacts: { columns: s.columns, nameKey: s.nameKey } };
};
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

  test("a contact with no name goes by their email, else as unnamed", () => {
    const schema = genericSchema();
    expect(contactLabel({ cells: { name: "Ann Lee", email: "ann@acme.com" } }, schema)).toBe("Ann Lee");
    expect(contactLabel({ cells: { email: "ann@acme.com" } }, schema)).toBe("ann@acme.com");
    expect(contactLabel({ cells: {} }, schema)).toBe("Unnamed contact");
  });
});

describe("a prospect and its contacts", () => {
  const schema = genericSchema();
  const ann = { id: "a", cells: { name: "Ann Lee", title: "Dr." } };
  const bob = { id: "b", cells: { name: "Bob Ray", primary: CHECKED } };

  test("the primary contact is the one ticked Primary, else the first", () => {
    expect(primaryOf([ann, bob], schema)).toBe(bob);
    expect(primaryOf([ann, { ...bob, cells: { name: "Bob Ray" } }], schema)).toBe(ann);
    expect(primaryOf([], schema)).toBeUndefined();
    expect(orderedContacts([ann, bob], schema)).toEqual([bob, ann]);
  });

  test("a channel is primary only when ticked, or when there's no one else", () => {
    const line = { id: "l", cells: { name: "Main line", contact_type: "Channel" } };
    expect(isChannel(line, schema)).toBe(true);
    expect(isChannel(ann, schema)).toBe(false);
    expect(CONTACT_TYPES).toContain("Channel");
    expect(primaryOf([line, ann], schema)).toBe(ann);
    expect(primaryOf([line], schema)).toBe(line);
    expect(primaryOf([{ ...line, cells: { ...line.cells, primary: CHECKED } }, ann], schema)?.id).toBe("l");
  });

  test("a contact with nothing in it but a Primary tick is empty", () => {
    expect(isEmptyContact({ cells: { primary: CHECKED } }, schema)).toBe(true);
    expect(isEmptyContact({ cells: {} }, schema)).toBe(true);
    expect(isEmptyContact({ cells: { primary: CHECKED, role: "CEO" } }, schema)).toBe(false);
  });

  test("a recipe filling in people's details runs per contact; one finding someone, per prospect", () => {
    expect(recipeMode([{ key: "email" }, { key: "linkedin" }], schema)).toBe("contacts");
    expect(recipeMode([{ key: "website" }, { contact: true }], schema)).toBe("contacts");
    expect(recipeMode([{ key: "name" }, { key: "role" }], schema)).toBe("prospects");
    expect(recipeMode([{ key: "website" }, { key: "hook" }], schema)).toBe("prospects");
    expect(recipeMode([{ key: "website" }], schema)).toBe("prospects");
  });

  test("every view names the prospect the same way: its company, over its primary contact", () => {
    const org = { cells: { company: "Acme" } };
    expect(prospectTitle(org, ann, schema)).toEqual({ title: "Acme", subtitle: "Dr. Ann Lee" });
    expect(prospectTitle(org, undefined, schema)).toEqual({ title: "Acme", subtitle: "" });
    expect(prospectTitle({ cells: {} }, ann, schema)).toEqual({ title: "Dr. Ann Lee", subtitle: "" });
    // Not the ID: it names nothing.
    expect(prospectTitle({ cells: { id: "P-004" } }, undefined, schema).title).toBe("Untitled prospect");
  });

  test("templates read the prospect and its primary contact as one", () => {
    const view = prospectSchema(schema);
    expect(view.nameKey).toBe("name");
    expect(view.columns.map((c) => c.header)).toContain("Contact type");
    // One view per schema: the contact-column cache keeps working across cards.
    expect(prospectSchema(schema)).toBe(view);
    expect(prospectCells({ cells: { company: "Acme" } }, ann)).toEqual({ company: "Acme", name: "Ann Lee", title: "Dr." });
  });
});

describe("prospect IDs and contact columns", () => {
  test("the next ID follows the highest P-number, whatever else is taken", () => {
    expect(newProspectId([])).toBe("P-001");
    expect(newProspectId(["P-001", "p-007", "ACME", "P-3"])).toBe("P-008");
    expect(newProspectId(["P-999"])).toBe("P-1000");
  });

  test("a new campaign has the company's columns and its contacts', keyed apart", () => {
    const schema = genericSchema();
    expect(schema.columns[0]).toMatchObject({ header: "ID", hidden: true });
    expect(schema.idKey).toBe("id");
    expect(schema.columns.map((c) => c.header)).not.toContain("Name");
    const contacts = schema.contacts!;
    expect(contacts.columns.map((c) => c.header)).toEqual(["Name", "Contact type", "Primary", "Title", "Role", "Email", "Phone", "LinkedIn", "Last contacted", "Last reply", "Notes", "Intro message"]);
    expect(contacts.columns.find((c) => c.key === contacts.typeKey)?.options).toEqual(CONTACT_TYPES);
    expect(contacts.columns.find((c) => c.key === contacts.primaryKey)?.type).toBe("checkbox");
    expect(contacts.columns.find((c) => c.key === contacts.lastContactedKey)).toMatchObject({ header: "Last contacted", type: "date" });
    expect(contacts.columns.find((c) => c.key === contacts.lastReplyKey)).toMatchObject({ header: "Last reply", type: "date" });
    expect(schema.columns.map((c) => c.header)).not.toContain("Last touch");
    // Notes is both the company's and a contact's: two keys.
    const keys = [...schema.columns, ...contacts.columns].map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(contacts.columns.find((c) => c.header === "Notes")!.key).toBe("notes_2");
  });

  test("an old campaign gains contact columns that don't reuse a key a deleted column left values under", () => {
    const schema = sheet("Company", "Status");
    ensureAppColumns(schema, ["name"]);
    expect(schema.contacts!.nameKey).toBe("name_2");
    ensureAppColumns(schema);
    expect(schema.contacts!.columns.filter((c) => c.header === "Name")).toHaveLength(1);
  });

  test("of the columns headed like a role's, the one headed as Mudd heads it is the role's", () => {
    const taken = new Set<string>();
    const of = (...headers: string[]): CampaignSchema => ({ columns: headers.map((header): Column => ({ key: makeKey(header, taken), header, type: "text", origin: "sheet" })) });
    const exact = of("Status:", "STATUS", "Status");
    ensureAppColumns(exact);
    expect(exact.columns.find((c) => c.key === exact.statusKey)!.header).toBe("Status");
    expect(exact.columns.slice(0, 3).map((c) => [c.header, c.type])).toEqual([["Status:", "text"], ["STATUS", "text"], ["Status", "select"]]);
    // Without one, the closest: by case before punctuation.
    const close = of("Status:", "STATUS");
    ensureAppColumns(close);
    expect(close.columns.slice(0, 2).map((c) => [c.header, c.key === close.statusKey])).toEqual([["Status:", false], ["Status", true]]);
  });

  test("a contact column Mudd relies on is only the one Mudd heads, and is Mudd's whatever the tab had", () => {
    const schema = sheet("Company", "Status");
    schema.contacts = { columns: [
      { key: "name", header: "NAME", type: "url", origin: "sheet" },
      { key: "contact_type", header: "Contact type", type: "select", options: ["Buyer", "User"], origin: "sheet" },
      { key: "is_primary", header: "Is primary", type: "checkbox", origin: "sheet" },
      { key: "last_contact", header: "Last contact", type: "text", origin: "sheet" },
      { key: "last_reply", header: "Last reply", type: "select", options: ["Yes", "No"], origin: "sheet" },
    ] };
    ensureAppColumns(schema);
    const cs = schema.contacts;
    const col = (key: string) => cs.columns.find((c) => c.key === key);
    expect(col("name")).toEqual({ key: "name", header: "Name", type: "text", origin: "sheet" });
    expect(col("contact_type")!.options).toEqual(CONTACT_TYPES);
    expect(col("last_reply")).toEqual({ key: "last_reply", header: "Last reply", type: "date", origin: "sheet" });
    // "Is primary" and "Last contact" are the tab's own columns; Mudd adds its own.
    expect(col("is_primary")!.header).toBe("Is primary");
    expect(col("last_contact")!.type).toBe("text");
    expect(col(cs.primaryKey!)).toMatchObject({ header: "Primary", type: "checkbox", origin: "mudd" });
    expect(col(cs.lastContactedKey!)).toMatchObject({ header: "Last contacted", type: "date", origin: "mudd" });
  });
});

describe("telling companies apart", () => {
  test("a company is known by its domain, its name without legal forms, and the domain's label", () => {
    expect(companyKeys("Acme, Inc.", "https://www.Acme.com/about")).toEqual(["d:acme.com", "n:acme"]);
    expect(companyKeys("Beta Forge Ltd", null)).toEqual(["n:betaforge"]);
    const index = new CompanyIndex<string>();
    index.add("Acme, Inc.", "acme.com", "P-001");
    expect(index.find("ACME", null)).toBe("P-001");
    expect(index.find("Something Else", "https://acme.com/")).toBe("P-001");
    expect(index.find("Beta Forge", "https://betaforge.com")).toBeUndefined();
  });

  test("the domain's label is the registered one: a subdomain names no company, nor does a public suffix", () => {
    expect(companyKeys("Acme", "https://info.acme.com")).toEqual(["d:info.acme.com", "n:acme"]);
    expect(companyKeys("Beta", "https://info.beta.com")).toEqual(["d:info.beta.com", "n:beta"]);
    expect(companyKeys("Gamma Ltd", "https://www.gamma.co.uk/")).toEqual(["d:gamma.co.uk", "n:gamma"]);
    const index = new CompanyIndex<string>();
    index.add("Acme", "https://info.acme.com", "P-001");
    expect(index.find("Beta", "https://info.beta.com")).toBeUndefined();
    expect(index.find("Info", null)).toBeUndefined();
    // A prospect whose site is portal.example.com is not "Portal Inc".
    index.add("Example", "https://portal.example.com", "P-002");
    expect(index.find("Portal Inc", null)).toBeUndefined();
    expect(index.find("Example Co", null)).toBe("P-002");
  });

  test("two companies whose website is a page on a shared host are not one company", () => {
    const index = new CompanyIndex<string>();
    index.add("Acme", "https://www.linkedin.com/company/acme/", "P-001");
    expect(index.find("Beta", "https://www.linkedin.com/company/beta")).toBeUndefined();
    expect(index.find("Gamma", "https://sites.google.com/view/gamma")).toBeUndefined();
    // The same page, under another name, is the same company; a bare shared host names no one.
    expect(index.find("Acme Metal Works", "https://linkedin.com/company/acme")).toBe("P-001");
    expect(companyKeys("Delta", "https://facebook.com")).toEqual(["n:delta"]);
    expect(companyKeys(null, "https://facebook.com/")).toEqual([]);
  });
});

describe("preset targets", () => {
  const role = PRESETS.find((p) => p.id === "decision-maker")!;
  const hook = PRESETS.find((p) => p.id === "hook")!;
  const roleTarget = (schema: CampaignSchema, rows: Record<string, CellValue>[] = []) =>
    presetTargets(role, schema, rows.map((r) => ({ cells: cellsOf(r) })))[1]?.header;

  test("the job title goes in Role, else in a Title that holds job titles", () => {
    expect(roleTarget(people("Name", "Title", "Role"))).toBe("Role");
    expect(roleTarget(people("Name", "Title"), [{ Title: "CEO" }])).toBe("Title");
    expect(roleTarget(people("Name", "Title"), [{ Title: "CEO" }, { Title: "Dr." }])).toBeUndefined();
  });

  test("the most preferred header wins, not the leftmost column", () => {
    expect(roleTarget(people("Position", "Role"))).toBe("Role");
    expect(presetTargets(hook, sheet("Angle", "Hook"), [])[0]?.header).toBe("Hook");
  });

  test("a person's details fill the contact columns, never the prospect's", () => {
    const contacts = people("Full name", "Role", "Email").contacts!;
    const schema: CampaignSchema = { ...sheet("Company", "Role", "Email"), contacts: { ...contacts, nameKey: contacts.columns[0]!.key } };
    const [name, jobTitle, linkedIn] = presetTargets(role, schema, []);
    // No alias for "Full name": the contacts' name column all the same.
    expect(name?.header).toBe("Full name");
    expect(jobTitle?.key).toBe(schema.contacts!.columns[1]!.key);
    expect(linkedIn).toBeUndefined();
    const email = presetTargets(PRESETS.find((p) => p.id === "email")!, schema, [])[0];
    expect(email?.key).toBe(schema.contacts!.columns[2]!.key);
  });
});
