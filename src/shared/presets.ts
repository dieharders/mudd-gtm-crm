/**
 * Starting recipes for prospect research. Each output lists header ALIASES so a preset fills
 * the sheet's existing column when there is one ("Role", "Email source") instead of adding a
 * near-duplicate. Aliases are in order of preference. A job title goes in a Title column only
 * when there is no Role, and not when its Title holds Mr. or Dr.
 *
 * A person's details (who decides, their email) belong to a contact: those outputs fill the
 * prospect's primary contact, and look only among the contact columns.
 */
import { isSourcesColumn } from "./ai";
import { norm } from "./merge";
import { contactSchema, HOOK_HEADERS, isHonorific, ROLE_HEADERS, TITLE_HEADER } from "./schema";
import type { CampaignSchema, Column, ColumnType, Row } from "./types";

export interface PresetOutput {
  header: string;
  aliases: string[];
  type: ColumnType;
  hint: string;
  /** A detail of the person: filled on the primary contact. */
  person?: boolean;
  /** The person's name: the contacts' name column when no alias matches. */
  name?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  icon: "building" | "news" | "person" | "mail" | "hook";
  tone: string;
  blurb: string;
  instructions: string;
  outputs: PresetOutput[];
}

export const PRESETS: Preset[] = [
  {
    id: "snapshot",
    name: "Company snapshot",
    icon: "building",
    tone: "bg-violet-100 text-violet-800",
    blurb: "What they do, how big they are, where they live online.",
    instructions:
      "Research this company. Explain what they do in plain language, estimate their headcount, and find their official website.",
    outputs: [
      { header: "Company summary", aliases: ["summary", "description", "about", "focus", "focuscerts"], type: "longtext", hint: "One or two plain sentences on what they sell and to whom." },
      { header: "Employees", aliases: ["staff", "headcount", "employees", "size", "companysize"], type: "text", hint: 'A number or range, e.g. "~40" or "50-100".' },
      { header: "Website", aliases: ["website", "url", "domain", "site"], type: "url", hint: "The official homepage URL." },
    ],
  },
  {
    id: "news",
    name: "Recent news & trigger",
    icon: "news",
    tone: "bg-sky-100 text-sky-800",
    blurb: "The latest notable news, and why now is a good moment.",
    instructions:
      "Find the most recent notable news about this company from the last 12 months: funding, contracts or awards, launches, partnerships, leadership changes. Then name the single best reason to reach out now.",
    outputs: [
      { header: "Recent news", aliases: ["recentnews", "news", "latestnews"], type: "longtext", hint: "Headline-style, with month and year." },
      { header: "Why now", aliases: ["whynow", "trigger", "reason"], type: "text", hint: "One sentence: the timely reason to reach out." },
    ],
  },
  {
    id: "decision-maker",
    name: "Decision-maker",
    icon: "person",
    tone: "bg-yellow-100 text-yellow-800",
    blurb: "Who is most likely to buy, with their role and LinkedIn: added as a contact.",
    instructions:
      "Identify the person most likely to make the buying decision: the founder or CEO at a small company, otherwise the head of marketing, growth or business development. Give their full name, job title and LinkedIn profile URL.",
    outputs: [
      { header: "Decision maker", aliases: ["primarycontact", "contact", "decisionmaker", "name", "contactname"], type: "text", hint: "Full name of one person.", person: true, name: true },
      { header: "Role", aliases: [...ROLE_HEADERS, TITLE_HEADER], type: "text", hint: "Their current job title.", person: true },
      { header: "LinkedIn", aliases: ["linkedin", "linkedinurl"], type: "url", hint: "Their personal LinkedIn profile URL.", person: true },
    ],
  },
  {
    id: "email",
    name: "Published email",
    icon: "mail",
    tone: "bg-pink-100 text-pink-800",
    blurb: "Each contact's work email, where one is actually published. Never a guess.",
    instructions:
      "Find a work email address for this contact that is published on the web (company site, press release, filings, conference pages). Never construct or guess an address from a naming pattern: if none is published for this person, return null.",
    outputs: [
      { header: "Email", aliases: ["email", "workemail", "emailaddress"], type: "email", hint: "Only an address you actually found published. Null if none.", person: true },
      { header: "Email source", aliases: ["emailsource"], type: "select", hint: "Published if you saw it on a page; Reported if a data site reports it.", person: true },
    ],
  },
  {
    id: "hook",
    name: "Personalization hook",
    icon: "hook",
    tone: "bg-emerald-100 text-emerald-800",
    blurb: "One specific, verifiable detail that makes an intro land.",
    instructions:
      "Find one specific, recent, verifiable detail about this company or its decision-maker that would make a cold introduction feel genuinely researched: a launch, a talk, a hire, a contract, a post they wrote. Write it as one short sentence that could open an email.",
    outputs: [
      { header: "Hook", aliases: HOOK_HEADERS, type: "longtext", hint: "One short, specific sentence, with the fact it rests on." },
    ],
  },
];

/**
 * The column each of a preset's outputs fills, if there is one: the most preferred header, among
 * the contact columns for a person's details and the prospect's for the rest. `rows` are the
 * prospects and contacts, to tell a Title of honorifics from one of job titles.
 */
export function presetTargets(p: Preset, schema: CampaignSchema, rows: Pick<Row, "cells">[]): (Column | undefined)[] {
  const used = new Set<string>();
  const contacts = contactSchema(schema);
  // A Title column holding Mr. or Dr. is how contacts are addressed: no job title goes there.
  const addresses = (c: Column) => norm(c.header) === TITLE_HEADER && rows.some((r) => isHonorific(String(r.cells[c.key] ?? "")));
  const open = (c: Column) => !used.has(c.key) && !isSourcesColumn(c) && c.key !== schema.idKey && !addresses(c);
  return p.outputs.map((o) => {
    const pool = o.person ? contacts.columns : schema.columns;
    let match = [norm(o.header), ...o.aliases].map((n) => pool.find((c) => open(c) && norm(c.header) === n)).find(Boolean);
    if (!match && o.name) match = contacts.columns.find((c) => c.key === contacts.nameKey && open(c));
    if (match) used.add(match.key);
    return match;
  });
}
