/**
 * The on/off filters beside the status chips, each picking the rows that need one thing done.
 * Each is offered only when the campaign has the columns it reads; any that are on narrow the
 * list together, and with the status chip and the search.
 */
import { isSourcesColumn } from "../../shared/ai";
import { DEAD, isChecked, isScreened, type CampaignSchema, type CellValue, type Row } from "../../shared/types";
import { parseLocal } from "./format";
import { contactedStage, lastTouchColumn, repliedColumn, sentColumn, stageIndex } from "./pipeline";

export type QuickFilterId = "followUp" | "notReady" | "unenriched" | "buyer";

export interface QuickFilter {
  id: QuickFilterId;
  label: string;
  title: string;
  test: (row: Row) => boolean;
}

/** Contacted this many days ago with no reply since: time to chase. */
export const FOLLOW_UP_DAYS = 7;
export const ECONOMIC_BUYER = "Economic Buyer";

const blank = (v: CellValue | undefined) => v === null || v === undefined || String(v).trim() === "";
const statusOf = (row: Row, schema: CampaignSchema) => (schema.statusKey ? String(row.cells[schema.statusKey] ?? "").trim() : "");
const isDead = (row: Row, schema: CampaignSchema) => statusOf(row, schema).toLowerCase() === DEAD.toLowerCase();

export function prospectFilters(
  schema: CampaignSchema,
  stages: string[],
  contactsOf: (id: string) => Row[],
  now = new Date(),
): QuickFilter[] {
  const out: QuickFilter[] = [];
  const inPlay = (r: Row) => !isScreened(r, schema);

  // Still at Contacted, nothing heard back, and the last touch is a week old (or never dated).
  const contacted = contactedStage(stages);
  const sent = sentColumn(schema);
  const last = lastTouchColumn(schema);
  const replied = repliedColumn(schema);
  if (schema.statusKey && contacted && (sent || last)) {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - FOLLOW_UP_DAYS);
    out.push({
      id: "followUp",
      label: "Needs follow-up",
      title: `At ${contacted} with no reply, last touched ${FOLLOW_UP_DAYS}+ days ago`,
      test: (r) => {
        if (!inPlay(r) || statusOf(r, schema).toLowerCase() !== contacted.toLowerCase()) return false;
        if (replied && !blank(r.cells[replied.key])) return false;
        const dates = [last, sent].map((c) => (c ? parseLocal(String(r.cells[c.key] ?? "")) : null)).filter((d): d is Date => !!d);
        return !dates.length || Math.max(...dates.map((d) => d.getTime())) <= cutoff.getTime();
      },
    });
  }

  // Not contacted yet, and missing what outreach needs: someone to address, or the intro itself.
  const { introKey } = schema;
  const primaryKey = schema.contacts?.primaryKey;
  if (introKey || primaryKey) {
    const before = contacted ? stageIndex(contacted, stages) : stages.length;
    out.push({
      id: "notReady",
      label: "Not ready to send",
      title: "Not contacted yet, with no primary contact or no intro",
      test: (r) => {
        if (!inPlay(r)) return false;
        const s = statusOf(r, schema);
        if (s) {
          const i = stageIndex(s, stages);
          if (i < 0 || i >= before) return false;
        }
        return (!!introKey && blank(r.cells[introKey])) || (!!primaryKey && !contactsOf(r.id).some((c) => isChecked(c.cells[primaryKey])));
      },
    });
  }

  // A gap in any column an enrichment recipe fills. Dead prospects aren't worth the lookup.
  const enriched = schema.columns.filter((c) => c.origin === "enrichment" && !c.hidden && !isSourcesColumn(c));
  if (enriched.length) {
    out.push({
      id: "unenriched",
      label: "Missing enrichment",
      title: `A blank in ${enriched.map((c) => c.header).join(", ")}`,
      test: (r) => inPlay(r) && !isDead(r, schema) && enriched.some((c) => blank(r.cells[c.key])),
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
    title: "Contacts who hold the budget",
    test: (r) => String(r.cells[typeKey] ?? "").trim().toLowerCase() === ECONOMIC_BUYER.toLowerCase(),
  }];
}
