/**
 * How a prospect card is laid out, worked out from the column headers.
 *
 * Every sheet names things differently (Org vs Company, Contact vs Primary contact), so the
 * reading view assigns columns to slots by header — title, rank, tier, type line, contact box,
 * paragraphs, links, small facts — and anything it can't place becomes a fact chip, so no data
 * is ever hidden from the card.
 */
import { norm } from "../../shared/merge";
import type { CampaignSchema, Column } from "../../shared/types";

export interface CardLayout {
  titleKey?: string;
  rankKey?: string;
  tierKey?: string;
  subtitleKey?: string;
  roleKey?: string;
  otherContactsKey?: string;
  emailKeys: string[];
  phoneKeys: string[];
  links: Column[];
  paragraphs: Column[];
  facts: Column[];
}

const find = (cols: Column[], names: RegExp) => cols.find((c) => names.test(norm(c.header)))?.key;

export function cardLayout(schema: CampaignSchema): CardLayout {
  const cols = schema.columns.filter((c) => !c.hidden);
  const titleKey = schema.companyKey ?? schema.nameKey ?? cols[0]?.key;
  const rankKey = find(cols, /^(rank|#|no|number|order|priorityrank)$/);
  const tierKey = find(cols, /^(tier|priority|grade|segment|band)$/);
  // The line under the name: a type if the sheet has one, else what the company does.
  const subtitleKey =
    find(cols, /^(type|category|industry|vertical|kind|orgtype|companytype)$/) ??
    find(cols, /^(focus|focuscerts|specialty|specialties|whattheydo|offering|sector)$/);
  const roleKey = find(cols, /^(role|title|jobtitle|position|contactrole)$/);
  const otherContactsKey = find(cols, /^othercontacts?$|^additionalcontacts?$/);

  const used = new Set(
    [titleKey, schema.nameKey, rankKey, tierKey, subtitleKey, roleKey, otherContactsKey, schema.statusKey, schema.introKey,
      schema.meetingAtKey, schema.meetingUrlKey, schema.screenedKey, schema.reasonKey].filter(Boolean) as string[],
  );
  const emailKeys: string[] = [];
  const phoneKeys: string[] = [];
  const links: Column[] = [];
  const paragraphs: Column[] = [];
  const facts: Column[] = [];
  for (const c of cols) {
    if (used.has(c.key)) continue;
    const h = norm(c.header);
    if (c.type === "email") emailKeys.push(c.key);
    else if (c.type === "phone") phoneKeys.push(c.key);
    else if (c.type === "url") links.push(c);
    else if (c.type === "longtext" || /hook|notes?|description|summary|about|angle|pitch/.test(h)) paragraphs.push(c);
    else facts.push(c);
  }
  // The hook (why this prospect, why now) reads first.
  paragraphs.sort((a, b) => Number(/hook|angle|pitch/.test(norm(b.header))) - Number(/hook|angle|pitch/.test(norm(a.header))));
  return { titleKey, rankKey, tierKey, subtitleKey, roleKey, otherContactsKey, emailKeys, phoneKeys, links, paragraphs, facts };
}

/** Columns worth grouping the reading view by: the tier, the status, and any dropdown. */
export function groupableColumns(schema: CampaignSchema): Column[] {
  const layout = cardLayout(schema);
  const out: Column[] = [];
  const add = (k?: string) => {
    const c = schema.columns.find((x) => x.key === k);
    if (c && !out.includes(c)) out.push(c);
  };
  add(layout.tierKey);
  add(schema.statusKey);
  add(layout.subtitleKey);
  for (const c of schema.columns) if (c.type === "select" && !c.hidden) add(c.key);
  return out;
}
