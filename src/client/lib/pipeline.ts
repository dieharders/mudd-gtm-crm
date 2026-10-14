/**
 * Moving a prospect along the pipeline. A stage change is only that: no dates are stamped. When
 * each person was last contacted, and last replied, is kept on the contact.
 */
import { DEAD, MEETING_STAGE, type CampaignSchema, type CellEdit, type Row } from "../../shared/types";

/** The edit that moves a prospect to `stage` (blank clears it): none without a Status column. */
export function stageEdits(row: Row, schema: CampaignSchema, stage: string): CellEdit[] {
  return schema.statusKey ? [{ rowId: row.id, key: schema.statusKey, value: stage || null }] : [];
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

