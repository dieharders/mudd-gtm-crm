/**
 * The on/off filters beside the status chips, each picking the rows that need one thing done.
 * Each is offered only when the campaign has the columns it reads; any that are on narrow the
 * list together, and with the status chip and the search.
 */
import { isSourcesColumn, type EnrichRun, type Recipe } from "../../shared/ai";
import { CONTACT_TYPE_HINTS, contactSchema, ECONOMIC_BUYER } from "../../shared/schema";
import { DEAD, isScreened, type CampaignSchema, type CellValue, type Row } from "../../shared/types";
import { hasIntro } from "../../shared/values";
import { parseLocal, todayString } from "./format";
import { contactedStage, stageIndex } from "./pipeline";

export type QuickFilterId = "followUp" | "notReady" | "unenriched" | "buyer";

/**
 * What a filter reads beyond the row, handed over at test time: the filters stay the same
 * through an edit, and the list is filtered again only while a chip that reads what changed is on.
 */
export interface FilterContext {
  contactsOf: (id: string) => Row[];
  /** Whether a run of the recipe went through the row (see runsThrough). */
  ran: (recipeId: string, rowId: string) => boolean;
}

export interface QuickFilter {
  id: QuickFilterId;
  label: string;
  title: string;
  /** The part of the context its test reads, if any. */
  reads?: keyof FilterContext;
  test: (row: Row, ctx: FilterContext) => boolean;
}

/** Contacted this many days ago with no reply since: time to chase. */
export const FOLLOW_UP_DAYS = 7;

const blank = (v: CellValue | undefined) => v === null || v === undefined || String(v).trim() === "";
const statusOf = (row: Row, schema: CampaignSchema) => (schema.statusKey ? String(row.cells[schema.statusKey] ?? "").trim() : "");
const isDead = (row: Row, schema: CampaignSchema) => statusOf(row, schema).toLowerCase() === DEAD.toLowerCase();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Recipe id → the rows its runs finished. */
export type FinishedRows = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The rows each recipe's runs finished, whether or not they found anything there: those of the
 * runs the page holds, and those `stored` (every run the server kept, as the page holds only
 * the latest few).
 */
export function runsThrough(runs: readonly EnrichRun[], stored: FinishedRows = new Map()): FilterContext["ran"] {
  const done = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.kind !== "enrich" || !run.recipeId) continue;
    const ids = done.get(run.recipeId) ?? new Set<string>();
    for (const [rowId, r] of Object.entries(run.rows)) if (r.state === "done") ids.add(rowId);
    done.set(run.recipeId, ids);
  }
  return (recipeId, rowId) => !!done.get(recipeId)?.has(rowId) || !!stored.get(recipeId)?.has(rowId);
}

/** `today` is the date the follow-up's week counts back from ("2026-10-11"). */
export function prospectFilters(schema: CampaignSchema, stages: string[], recipes: readonly Recipe[], today = todayString()): QuickFilter[] {
  const out: QuickFilter[] = [];
  const inPlay = (r: Row) => !isScreened(r, schema);

  // Still at Contacted, last contacted a week or more ago, and nobody has replied since. The
  // dates are the contacts' own. With none at all, it was moved to Contacted without a date
  // (the stepper): due, unless someone has replied.
  const contacted = contactedStage(stages);
  const { lastContactedKey, lastReplyKey } = contactSchema(schema);
  if (schema.statusKey && contacted && lastContactedKey) {
    const now = parseLocal(today) ?? new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - FOLLOW_UP_DAYS).getTime();
    // The latest of a date column across the contacts, by the day: a datetime's hour doesn't put
    // it on the other side of the cutoff. A date that won't read ("10/10/2026" typed as text)
    // is passed over; null when none reads.
    const latest = (people: Row[], key: string | undefined) => {
      const days = key ? people.flatMap((p) => parseLocal(String(p.cells[key] ?? "").trim()) ?? []).map(startOfDay) : [];
      return days.length ? Math.max(...days) : null;
    };
    out.push({
      id: "followUp",
      label: "Needs follow-up",
      title: `At ${contacted} with no reply, last contacted ${FOLLOW_UP_DAYS}+ days ago or never dated`,
      reads: "contactsOf",
      test: (r, { contactsOf }) => {
        if (!inPlay(r) || statusOf(r, schema).toLowerCase() !== contacted.toLowerCase()) return false;
        const people = contactsOf(r.id);
        const reply = latest(people, lastReplyKey);
        if (people.every((p) => blank(p.cells[lastContactedKey]))) return reply === null;
        const sent = latest(people, lastContactedKey);
        if (sent === null || sent > cutoff) return false;
        return reply === null || reply < sent;
      },
    });
  }

  // Not contacted yet, and missing what outreach needs: anyone to write to, or an intro written
  // to any of them.
  const introKey = schema.contacts?.introKey;
  if (schema.contacts) {
    const before = contacted ? stageIndex(contacted, stages) : stages.length;
    out.push({
      id: "notReady",
      label: "Not ready to send",
      title: "Not contacted yet, with no contact or no intro",
      reads: "contactsOf",
      test: (r, { contactsOf }) => {
        if (!inPlay(r)) return false;
        const s = statusOf(r, schema);
        if (s) {
          const i = stageIndex(s, stages);
          if (i < 0 || i >= before) return false;
        }
        const people = contactsOf(r.id);
        return !people.length || (!!introKey && !people.some((p) => hasIntro(p, schema)));
      },
    });
  }

  // A recipe not yet run on the prospect: none of its columns filled, and no run of it finished
  // there. A blank a run left (nothing found, a box it didn't tick) is its answer, not a gap.
  // Dead prospects aren't worth the lookup.
  const byRecipe = recipes
    .map((recipe) => ({
      recipe,
      keys: recipe.outputs.flatMap((o) => schema.columns.filter((c) => c.key === o.key && !c.hidden && !isSourcesColumn(c)).map((c) => c.key)),
    }))
    .filter((x) => x.keys.length);
  if (byRecipe.length) {
    out.push({
      id: "unenriched",
      label: "Missing enrichment",
      title: `Not yet enriched with ${byRecipe.map((x) => x.recipe.name).join(", ")}`,
      reads: "ran",
      test: (r, { ran }) => inPlay(r) && !isDead(r, schema)
        && byRecipe.some(({ recipe, keys }) => keys.every((k) => blank(r.cells[k])) && !ran(recipe.id, r.id)),
    });
  }
  return out;
}

export function contactFilters(schema: CampaignSchema): QuickFilter[] {
  const typeKey = schema.contacts?.typeKey;
  if (!typeKey) return [];
  return [{
    id: "buyer",
    label: ECONOMIC_BUYER,
    title: CONTACT_TYPE_HINTS[ECONOMIC_BUYER]!,
    test: (r) => String(r.cells[typeKey] ?? "").trim().toLowerCase() === ECONOMIC_BUYER.toLowerCase(),
  }];
}
