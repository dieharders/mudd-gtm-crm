/**
 * Discovery: the types shared by the sourcing engine and the page.
 *
 * A Discovery run works from the campaign's ICP thesis. It plans a few search angles, finds
 * candidate companies along each (one web turn per angle), then maps each company's buying
 * committee (one web turn per company). Candidates wait in an inbox until the user accepts
 * them as prospects or dismisses them; nothing reaches the sheet on its own.
 */
import type { ProviderId, RunStatus, Source } from "./ai";
import { CHANNEL, CONTACT_TYPES, DISCOVERY_FIELDS, discoveryColumn, FIT_OPTIONS, type DiscoveryField } from "./schema";
import type { CampaignBundle, CampaignSchema, Column } from "./types";

export { DISCOVERY_FIELDS, FIT_OPTIONS, type DiscoveryField };

/** The roles a person on the buying committee can have: every contact type but Channel. */
export const DEAL_ROLES: string[] = CONTACT_TYPES.filter((t) => t !== CHANNEL);

export type Fit = "High" | "Medium" | "Low";
export type Confidence = "high" | "medium" | "low";

export interface CandidateContact {
  id: string;
  name: string;
  /** Their job title. */
  title: string | null;
  /** One of DEAL_ROLES. */
  type: string | null;
  /** Their part in this deal, what they gain from it, and the angle to take with them. */
  dealRole: string | null;
  gain: string | null;
  angle: string | null;
  linkedin: string | null;
  /** Where this person was found. */
  source: string | null;
  confidence: Confidence;
}

/**
 * `mapping`: found, its committee not yet mapped. `ready`: in the inbox. `accepted`: a prospect
 * now (`rowId`). `dismissed`: kept as a negative example, never suggested again. `error`: the
 * map turn failed; "Map again" retries it.
 */
export type CandidateStatus = "mapping" | "ready" | "accepted" | "dismissed" | "error";

export interface Candidate {
  id: string;
  campaignId: string;
  /** The run that found it. */
  runId: string;
  status: CandidateStatus;
  company: string;
  website: string | null;
  location: string | null;
  employees: number | null;
  fit: Fit | null;
  whyFit: string | null;
  whyNow: string | null;
  budget: string | null;
  clock: string | null;
  /** The pages it was found on, and the pages its committee was found on. */
  sources: Source[];
  contacts: CandidateContact[];
  /** The contact the agent recommends approaching first (its id), made Primary on accept. */
  firstContact: string | null;
  /** The search angle it came from. */
  angle: string | null;
  error: string | null;
  /** Why the user dismissed it, or why the agent disqualified it. */
  dismissReason: string | null;
  /** The prospect it became. */
  rowId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What to run on accepted prospects: presets (by id) and saved recipes (by id). */
export interface EnrichChoice {
  presets: string[];
  recipeIds: string[];
  autoFill: boolean;
}

export const DEFAULT_ENRICH: EnrichChoice = { presets: ["snapshot", "email"], recipeIds: [], autoFill: false };

export type JobState = "pending" | "running" | "done" | "error" | "skipped";

export interface SearchAngle {
  id: string;
  /** A short name for the angle: "State manufacturing associations". */
  label: string;
  /** What to search for along it. */
  query: string;
  state: JobState;
  /** What the agent is doing right now. */
  step?: string;
  /** Companies this angle added. */
  found: number;
  error?: string;
}

/** A company's map job, as the progress view shows it. */
export interface MapJob {
  state: JobState;
  step?: string;
  error?: string;
}

/**
 * `thesis`: draft the blank answers only. `find`: the full run (thesis → plan → find → map).
 * `map`: map one or more candidates again.
 */
export type DiscoveryKind = "thesis" | "find" | "map";
export type DiscoveryStage = "thesis" | "plan" | "find" | "map" | "done";

export interface DiscoveryRun {
  id: string;
  campaignId: string;
  kind: DiscoveryKind;
  status: RunStatus;
  stage: DiscoveryStage;
  provider: ProviderId;
  model: string;
  concurrency: number;
  /** How many companies to find, and how many people to map at each. */
  target: number;
  perCompany: number;
  /** Anything extra for this run ("only the Midwest"). */
  focus: string | null;
  enrich: EnrichChoice;
  /** Questions the thesis stage drafted. */
  drafted: string[];
  angles: SearchAngle[];
  /** The candidates this run found, in the order found; the map jobs by candidate id. */
  candidateIds: string[];
  jobs: Record<string, MapJob>;
  /** Companies found (after de-duplication), ready in the inbox, disqualified, and map jobs failed. */
  found: number;
  ready: number;
  disqualified: number;
  failed: number;
  costUsd: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export const TARGET_OPTIONS = [5, 10, 25];
export const PER_COMPANY_OPTIONS = [3, 5, 8];

/** How many angles a run of this size plans: 3 for a handful, 6 for a long list. */
export const angleCount = (target: number): number => (target <= 5 ? 3 : target <= 10 ? 4 : 6);

/** Roughly how many agent turns a Find run takes: the angles, plus one per company, plus some for duplicates. */
export function estimateTurns(target: number): number {
  return angleCount(target) + Math.ceil(target * 1.3);
}

/** The column for each Discovery field in this layout (a deleted one is undefined). */
export function discoveryColumns(schema: CampaignSchema): Partial<Record<DiscoveryField["id"], Column>> {
  const out: Partial<Record<DiscoveryField["id"], Column>> = {};
  for (const f of DISCOVERY_FIELDS) {
    const col = discoveryColumn(schema, f);
    if (col) out[f.id] = col;
  }
  return out;
}

/** A Discovery campaign: one with a thesis, created through "Discover prospects" or re-imported from such a workbook. */
export const isDiscovery = (bundle: Pick<CampaignBundle, "thesis">): boolean => bundle.thesis !== null;

/** Inbox order: the best fit first, then the newest. */
export function inboxOrder(a: Candidate, b: Candidate): number {
  const rank = (c: Candidate) => (c.fit ? FIT_OPTIONS.indexOf(c.fit) : FIT_OPTIONS.length);
  return rank(a) - rank(b) || b.createdAt - a.createdAt;
}
