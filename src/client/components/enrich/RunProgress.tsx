/** A run as it goes: progress, what each row is doing, and pause / resume / stop. */
import { AlertCircle, Check, CircleDashed, Loader2, Pause, Play, Search, Square } from "lucide-react";
import { isLiveStatus, PROVIDERS, type EnrichRun } from "../../../shared/ai";
import type { CampaignSchema, Row } from "../../../shared/types";
import { contactLabel, primaryOf, prospectTitle } from "../../../shared/values";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { Button } from "../ui/Button";

const STATUS: Record<EnrichRun["status"], [string, string]> = {
  running: ["Running", "bg-sky-100 text-sky-800"],
  paused: ["Paused", "bg-yellow-100 text-yellow-800"],
  stopping: ["Stopping…", "bg-paper-deep text-mud-soft"],
  stopped: ["Stopped", "bg-paper-deep text-mud-soft"],
  done: ["Done", "bg-emerald-100 text-emerald-800"],
  failed: ["Failed", "bg-rose-100 text-rose-700"],
};

export function RunProgress({ run, rowById, schema, contactsOf, onAction, onReview, pending, onOpenRow }: {
  run: EnrichRun;
  /** Prospects and contacts: an intro run lists contacts. */
  rowById: Map<string, Row>;
  schema: CampaignSchema;
  contactsOf: (orgId: string) => Row[];
  onAction: (a: "pause" | "resume" | "stop") => void;
  onReview: () => void;
  pending: number;
  onOpenRow: (id: string) => void;
}) {
  const finished = run.completed + run.failed + Object.values(run.rows).filter((r) => r.state === "skipped").length;
  const pct = run.total ? Math.round((finished / run.total) * 100) : 0;
  const live = isLiveStatus(run.status);
  const [label, tone] = STATUS[run.status];
  const orgTitle = (org: Row) => prospectTitle(org, primaryOf(contactsOf(org.id), schema), schema).title;
  /** A row's line: a prospect's title, or a contact's name and its prospect's. */
  const titleOf = (row: Row) => {
    if (!row.parentId) return orgTitle(row);
    const org = rowById.get(row.parentId);
    return [contactLabel(row, schema), org && orgTitle(org)].filter(Boolean).join(" · ");
  };

  return (
    <div className="rounded-2xl border border-rim/40 bg-paper p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("tag", tone)}>{run.status === "running" && <Loader2 size={11} className="animate-spin" />}{label}</span>
        <span className="text-sm font-semibold">{run.label}{run.test ? " · test" : ""}</span>
        <span className="text-xs text-mud-faint">{PROVIDERS[run.provider].label} · {run.model} · {timeAgo(run.startedAt)}</span>
        <div className="ml-auto flex gap-1.5">
          {run.status === "running" && <Button size="sm" onClick={() => onAction("pause")}><Pause size={12} /> Pause</Button>}
          {run.status === "paused" && <Button size="sm" variant="primary" onClick={() => onAction("resume")}><Play size={12} /> Resume</Button>}
          {live && run.status !== "stopping" && <Button size="sm" variant="ghost" onClick={() => onAction("stop")}><Square size={11} /> Stop</Button>}
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-paper-deep">
        <div className={cn("h-full rounded-full transition-all duration-500", run.status === "failed" ? "bg-rose-400" : "bg-clay")} style={{ width: `${Math.max(pct, live ? 3 : 0)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mud-soft">
        <span><b className="text-mud tabular-nums">{run.completed}</b> of {run.total} done</span>
        {run.failed > 0 && <span className="text-rose-700"><b className="tabular-nums">{run.failed}</b> failed</span>}
        <span><b className="text-mud tabular-nums">{run.suggestions}</b> suggestions</span>
        {run.autoFilled > 0 && <span><b className="text-mud tabular-nums">{run.autoFilled}</b> empty cells filled</span>}
        {pending > 0 && (
          <button onClick={onReview} className="ml-auto font-semibold text-clay-deep hover:underline">Review {pending} →</button>
        )}
      </div>
      {run.error && <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">{run.error}</p>}

      <ul className="mt-3 max-h-64 space-y-0.5 overflow-y-auto scroll-thin">
        {run.rowIds.map((id) => {
          const rs = run.rows[id]!;
          const row = rowById.get(id);
          const t = row ? titleOf(row) : "Deleted row";
          return (
            <li key={id}>
              <button onClick={() => row && onOpenRow(row.parentId ?? id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-paper-deep/60">
                <RowIcon state={rs.state} />
                <span className="w-44 shrink-0 truncate font-medium">{t}</span>
                <span className={cn("min-w-0 flex-1 truncate", rs.state === "error" ? "text-rose-700" : "text-mud-faint")}>
                  {rs.state === "running" ? (
                    <span className="inline-flex items-center gap-1"><Search size={10} /> {rs.step ?? "Working"}</span>
                  ) : rs.state === "done" ? (
                    rs.found ? `${rs.found} found` : "Nothing new"
                  ) : rs.state === "error" ? rs.error : rs.state === "skipped" ? rs.error ?? "Skipped" : "Waiting"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RowIcon({ state }: { state: EnrichRun["rows"][string]["state"] }) {
  if (state === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-clay" />;
  if (state === "done") return <Check size={13} className="shrink-0 text-emerald-600" />;
  if (state === "error") return <AlertCircle size={13} className="shrink-0 text-rose-500" />;
  return <CircleDashed size={13} className="shrink-0 text-rim/50" />;
}
