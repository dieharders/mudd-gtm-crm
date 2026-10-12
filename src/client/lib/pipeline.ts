/**
 * What changing a prospect's stage also changes.
 *
 * The sheet has date columns that mirror the pipeline — base-tracker's Direct prospects has
 * "Sent" and "Replied", Aggregators has "Last touch". Moving a prospect along fills them in
 * with today's date, but only when they are empty: a date the user typed is never overwritten
 * (Last touch excepted, which by definition is the most recent touch).
 */
import { norm } from "../../shared/merge";
import { DEAD, MEETING_STAGE, type CampaignSchema, type CellEdit, type Column, type Row } from "../../shared/types";
import { todayString } from "./format";

const findCol = (schema: CampaignSchema, names: string[]): Column | undefined =>
  schema.columns.find((c) => names.includes(norm(c.header)) && (c.type === "date" || c.type === "text" || c.type === "datetime"));

/** The date the first message went out: stamped on Contacted. */
export const sentColumn = (schema: CampaignSchema) => findCol(schema, ["sent", "firstmessage", "firstmessagesent", "contactedon", "datecontacted", "firsttouch"]);
/** The date they first replied: stamped on Replied. */
export const repliedColumn = (schema: CampaignSchema) => findCol(schema, ["replied", "repliedon", "reply", "responded", "firstreply"]);
/** The date of the latest touch: stamped on every move along the pipeline. */
export const lastTouchColumn = (schema: CampaignSchema) => findCol(schema, ["lasttouch", "lastcontact", "lastcontacted", "lasttouched"]);

export function stageEdits(row: Row, schema: CampaignSchema, stages: string[], stage: string): { edits: CellEdit[]; stamped: string[] } {
  const edits: CellEdit[] = [];
  const stamped: string[] = [];
  if (!schema.statusKey) return { edits, stamped };
  edits.push({ rowId: row.id, key: schema.statusKey, value: stage || null });
  const today = todayString();
  const fillIfEmpty = (col: Column | undefined) => {
    if (!col || row.cells[col.key]) return;
    edits.push({ rowId: row.id, key: col.key, value: today });
    stamped.push(col.header);
  };
  const lower = stage.toLowerCase();
  if (lower === "contacted") fillIfEmpty(sentColumn(schema));
  if (lower === "replied") fillIfEmpty(repliedColumn(schema));
  const last = lastTouchColumn(schema);
  if (last && stage && stage !== stages[0] && row.cells[last.key] !== today) {
    edits.push({ rowId: row.id, key: last.key, value: today });
    stamped.push(last.header);
  }
  return { edits, stamped };
}

export function stageIndex(stage: string | undefined | null, stages: string[]): number {
  if (!stage) return -1;
  return stages.findIndex((s) => s.toLowerCase() === stage.toLowerCase());
}

/** Booking a meeting moves the prospect to "Meeting booked" unless it is already further on. */
export function shouldAdvanceToMeeting(current: string | null | undefined, stages: string[]): string | null {
  const meeting = stages.find((s) => s.toLowerCase() === MEETING_STAGE.toLowerCase());
  if (!meeting) return null;
  if (!current || current === DEAD) return meeting;
  const cur = stageIndex(current, stages);
  return cur < stageIndex(meeting, stages) ? meeting : null;
}

export function contactedStage(stages: string[]): string | undefined {
  return stages.find((s) => s.toLowerCase() === "contacted") ?? stages[1];
}

