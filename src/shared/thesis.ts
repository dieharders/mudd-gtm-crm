/**
 * The ICP thesis: the questionnaire that drives Discovery. Sixteen questions in four sections,
 * each with a help line and an example. The answers are the user's; "Fill blanks with AI" drafts
 * the ones left blank, which stay tagged as drafts until the user edits or keeps them.
 *
 * Saved to the workbook as an "ICP thesis" tab (Question | Answer | Filled by), so a workbook
 * saved from a Discovery campaign brings the thesis back when it is re-imported.
 */
import { norm } from "./merge";
import type { Thesis, ThesisId } from "./types";

export const THESIS_SHEET = "ICP thesis";

export interface ThesisQuestion {
  id: ThesisId;
  label: string;
  help: string;
  example: string;
  /** Discovery can't start without an answer here. */
  required?: boolean;
}

export interface ThesisSection {
  id: string;
  label: string;
  questions: ThesisQuestion[];
}

export const THESIS_SECTIONS: ThesisSection[] = [
  {
    id: "offer",
    label: "Offer & fit",
    questions: [
      {
        id: "offer", label: "What do you sell?", required: true,
        help: "The product or service, in a sentence or two, as you'd say it to a stranger.",
        example: "Managed cybersecurity monitoring for mid-size manufacturers, priced per site.",
      },
      {
        id: "avatar", label: "Who qualifies?", required: true,
        help: "Who buys, who uses it, who pays. Their volume or size, their clock, whose money it is, and who reviews the purchase.",
        example: "US manufacturers with 200–2,000 staff and 2+ plants; the IT director buys, the plant managers use it, the CFO pays.",
      },
      {
        id: "pains", label: "Their pain points",
        help: "What hurts today, in their words. The things that make them pick up the phone.",
        example: "Ransomware scares, a cyber-insurance renewal that demands 24/7 monitoring, a two-person IT team.",
      },
      {
        id: "fit", label: "How those pains map to your solution",
        help: "Pain by pain: what you take away, and why they'd believe you.",
        example: "We're the 24/7 SOC their insurer asks for, without the headcount; one plant is live in a week.",
      },
      {
        id: "jobs", label: "The jobs your product does for them",
        help: "The outcomes they're hiring you for, not features.",
        example: "Pass the insurance audit, sleep at night, keep the line running during an incident.",
      },
    ],
  },
  {
    id: "committee",
    label: "Buying committee",
    questions: [
      {
        id: "painRoles", label: "Who feels the pain and intends to buy",
        help: "The job titles that start the search. Discovery looks for these people first.",
        example: "IT Director, Head of OT, Plant Manager.",
      },
      {
        id: "payerRoles", label: "Who has authority to pay, and whose money it is",
        help: "The economic buyer and the budget it comes from.",
        example: "CFO or COO; the operations or IT budget, sometimes the insurance line.",
      },
      {
        id: "gainRoles", label: "Who has the most to gain (the champion)",
        help: "The person whose life gets easier, who will sell it inside.",
        example: "The IT manager who is on call every night.",
      },
      {
        id: "friction", label: "Who can slow it down",
        help: "Procurement, brand or legal review, security questionnaires, incumbents.",
        example: "Procurement wants three quotes; the existing MSP will push back.",
      },
    ],
  },
  {
    id: "targeting",
    label: "Targeting",
    questions: [
      {
        id: "exclude", label: "Filter these out",
        help: "Companies and situations that look like a fit but never close.",
        example: "Fortune 500, companies with an in-house SOC, anyone already with CrowdStrike Falcon Complete.",
      },
      {
        id: "triggers", label: "Trigger events and intent signals",
        help: "What happens right before they buy: a hire, a breach, a renewal, a new plant.",
        example: "Hiring a first security lead, a reported incident, a new plant announced, an insurance renewal in Q4.",
      },
      {
        id: "channels", label: "Where to find them",
        help: "Lists, directories, associations, conferences, news sources and job boards Discovery should search.",
        example: "State manufacturing association member lists, FABTECH exhibitors, local business journals' 'fastest growing' lists.",
      },
    ],
  },
  {
    id: "deal",
    label: "Deal",
    questions: [
      {
        id: "dealShape", label: "Desired deal shape",
        help: "Size, term, pilot or full rollout, what a first order looks like.",
        example: "A 90-day paid pilot at one plant, then a 3-year contract across all sites.",
      },
      {
        id: "clock", label: "Their buying clock",
        help: "Fiscal year end, budget season, dead months, renewal dates.",
        example: "Budgets set in October; nothing moves in December; insurance renews in Q1.",
      },
      {
        id: "approach", label: "Sales approach",
        help: "How you want to open: a referral, a benchmark, an audit, a webinar.",
        example: "Offer a free insurance-readiness assessment to the IT director, copy the CFO.",
      },
      {
        id: "win", label: "Definition of a win",
        help: "What the campaign is for: meetings, pilots, signed sites.",
        example: "Six paid pilots this half.",
      },
    ],
  },
];

export const THESIS_QUESTIONS: ThesisQuestion[] = THESIS_SECTIONS.flatMap((s) => s.questions);
export const THESIS_IDS: ThesisId[] = THESIS_QUESTIONS.map((q) => q.id);
const BY_ID = new Map(THESIS_QUESTIONS.map((q) => [q.id, q]));

export const isThesisId = (id: string): id is ThesisId => BY_ID.has(id as ThesisId);
export const thesisQuestion = (id: ThesisId): ThesisQuestion => BY_ID.get(id)!;

/** The question whose label this is (case, spacing and punctuation aside), for reading the tab back. */
export function questionByLabel(label: string): ThesisQuestion | undefined {
  const n = norm(label);
  return THESIS_QUESTIONS.find((q) => norm(q.label) === n);
}

/** An answer that says something. */
export const answered = (thesis: Thesis, id: ThesisId): boolean => !!thesis.answers[id]?.trim();

/** The questions with no answer yet, in questionnaire order. */
export const blankQuestions = (thesis: Thesis): ThesisQuestion[] => THESIS_QUESTIONS.filter((q) => !answered(thesis, q.id));

export const answeredCount = (thesis: Thesis): number => THESIS_QUESTIONS.length - blankQuestions(thesis).length;

/** The two questions a Find run can't do without. */
export const canFind = (thesis: Thesis): boolean => answered(thesis, "offer") && answered(thesis, "avatar");
