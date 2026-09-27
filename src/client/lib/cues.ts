/**
 * The red and amber cues the sheet's conditional formats draw, recreated for the grid:
 * overdue next steps on open rows, lapsed expiry dates, unverified pattern emails, and
 * meetings happening today.
 */
import { DEAD, type CampaignSchema, type CellValue, type Column } from "../../shared/types";
import { norm } from "../../shared/merge";
import { isSameDay, parseLocal, todayString } from "./format";

export type Cue = "overdue" | "expired" | "unverified" | "today" | "upcoming" | "past" | null;

export function cueFor(col: Column, cells: Record<string, CellValue>, schema: CampaignSchema): Cue {
  const v = cells[col.key];
  const h = norm(col.header);
  const status = schema.statusKey ? String(cells[schema.statusKey] ?? "") : "";
  const closed = status === "Signed" || status === DEAD;

  if (col.key === schema.meetingAtKey && typeof v === "string" && v) {
    const d = parseLocal(v);
    if (!d) return null;
    const now = new Date();
    if (isSameDay(d, now)) return "today";
    return d > now ? "upcoming" : "past";
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const today = todayString();
    if (/^nextdate$|^followup|^nexttouch/.test(h) && v.slice(0, 10) < today && !closed) return "overdue";
    if (/expir/.test(h) && v.slice(0, 10) < today) return "expired";
  }
  if (col.type === "email" && v) {
    const src = schema.columns.find((c) => norm(c.header) === "emailsource");
    if (src && String(cells[src.key] ?? "").toLowerCase() === "pattern") return "unverified";
  }
  return null;
}

export const CUE_LABEL: Record<Exclude<Cue, null>, string> = {
  overdue: "Overdue",
  expired: "Lapsed",
  unverified: "Pattern email: inferred, verify before sending",
  today: "Today",
  upcoming: "Upcoming",
  past: "Past",
};
