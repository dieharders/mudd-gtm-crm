/** A Discovery run as it goes: its stages, each search angle, each company's step, and pause / resume / stop. */
import { AlertCircle, Check, CircleDashed, Loader2, Pause, Play, Search, Square } from "lucide-react";
import { isLiveStatus, PROVIDERS } from "../../../shared/ai";
import type { Candidate, DiscoveryRun, DiscoveryStage, JobState } from "../../../shared/sourcing";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { Button } from "../ui/Button";

const STATUS: Record<DiscoveryRun["status"], [string, string]> = {
  running: ["Running", "bg-sky-100 text-sky-800"],
  paused: ["Paused", "bg-yellow-100 text-yellow-800"],
  stopping: ["Stopping…", "bg-paper-deep text-mud-soft"],
  stopped: ["Stopped", "bg-paper-deep text-mud-soft"],
  done: ["Done", "bg-emerald-100 text-emerald-800"],
  failed: ["Failed", "bg-rose-100 text-rose-700"],
};

const STAGES: { id: DiscoveryStage; label: string }[] = [
  { id: "thesis", label: "Thesis" },
  { id: "plan", label: "Plan" },
  { id: "find", label: "Find" },
  { id: "map", label: "Map" },
];

const KIND_LABEL: Record<DiscoveryRun["kind"], string> = { thesis: "Fill thesis blanks", find: "Find prospects", map: "Map buying committee" };

export function DiscoveryProgress({ run, candidates, onAction }: {
  run: DiscoveryRun;
  candidates: Candidate[];
  onAction: (a: "pause" | "resume" | "stop") => void;
}) {
  const live = isLiveStatus(run.status);
  const [label, tone] = STATUS[run.status];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const stageAt = STAGES.findIndex((s) => s.id === run.stage);
  const stages = run.kind === "map" ? STAGES.filter((s) => s.id === "map") : run.kind === "thesis" ? STAGES.filter((s) => s.id === "thesis") : STAGES;
  const mapJobs = Object.entries(run.jobs);
  const finished = mapJobs.filter(([, j]) => j.state === "done" || j.state === "error" || j.state === "skipped").length;
  const pct = run.kind === "find"
    ? Math.round((Math.min(run.found, run.target) / run.target) * 50 + (run.found ? (finished / run.found) * 50 : 0))
    : mapJobs.length ? Math.round((finished / mapJobs.length) * 100) : run.status === "done" ? 100 : 0;

  return (
    <div className="rounded-2xl border border-rim/40 bg-paper p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("tag", tone)}>{run.status === "running" && <Loader2 size={11} className="animate-spin" />}{label}</span>
        <span className="text-sm font-semibold">{KIND_LABEL[run.kind]}</span>
        <span className="text-xs text-mud-faint">{PROVIDERS[run.provider].label} · {run.model} · {timeAgo(run.startedAt)}{run.costUsd !== null ? ` · $${run.costUsd.toFixed(2)}` : ""}</span>
        <div className="ml-auto flex gap-1.5">
          {run.status === "running" && <Button size="sm" onClick={() => onAction("pause")}><Pause size={12} /> Pause</Button>}
          {run.status === "paused" && <Button size="sm" variant="primary" onClick={() => onAction("resume")}><Play size={12} /> Resume</Button>}
          {live && run.status !== "stopping" && <Button size="sm" variant="ghost" onClick={() => onAction("stop")}><Square size={11} /> Stop</Button>}
        </div>
      </div>

      {stages.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {stages.map((s, i) => {
            const idx = STAGES.findIndex((x) => x.id === s.id);
            const state = run.stage === "done" ? "done" : idx < stageAt ? "done" : idx === stageAt ? "running" : "pending";
            return (
              <span key={s.id} className="flex items-center gap-1.5">
                <span className={cn("tag", state === "done" ? "bg-emerald-100 text-emerald-800" : state === "running" ? "bg-sky-100 text-sky-800" : "bg-paper-deep text-mud-faint")}>
                  {state === "running" && live ? <Loader2 size={10} className="animate-spin" /> : state === "done" ? <Check size={10} /> : null} {s.label}
                </span>
                {i < stages.length - 1 && <span className="text-mud-faint">→</span>}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-paper-deep">
        <div className={cn("h-full rounded-full transition-all duration-500", run.status === "failed" ? "bg-rose-400" : "bg-clay")} style={{ width: `${Math.max(pct, live ? 3 : 0)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mud-soft">
        {run.kind === "thesis" ? (
          <span><b className="text-mud tabular-nums">{run.drafted.length}</b> answers drafted</span>
        ) : (
          <>
            {run.kind === "find" && <span><b className="text-mud tabular-nums">{run.found}</b> of {run.target} companies found</span>}
            <span><b className="text-mud tabular-nums">{run.ready}</b> ready to review</span>
            {run.disqualified > 0 && <span><b className="tabular-nums">{run.disqualified}</b> disqualified on a closer look</span>}
            {run.failed > 0 && <span className="text-rose-700"><b className="tabular-nums">{run.failed}</b> failed</span>}
          </>
        )}
      </div>
      {run.error && <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">{run.error}</p>}

      {run.angles.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {run.angles.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs">
              <JobIcon state={a.state} />
              <span className="w-56 shrink-0 truncate font-medium" title={a.query}>{a.label}</span>
              <span className={cn("min-w-0 flex-1 truncate", a.state === "error" ? "text-rose-700" : "text-mud-faint")}>
                {a.state === "running" ? <span className="inline-flex items-center gap-1"><Search size={10} /> {a.step ?? "Searching"}</span>
                  : a.state === "done" ? `${a.found} new compan${a.found === 1 ? "y" : "ies"}`
                  : a.state === "error" ? a.error : a.state === "skipped" ? "Not needed: target reached" : "Waiting"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mapJobs.length > 0 && (
        <ul className="mt-3 max-h-64 space-y-0.5 overflow-y-auto border-t border-rim/40 pt-2 scroll-thin">
          {mapJobs.map(([cid, job]) => {
            const c = byId.get(cid);
            return (
              <li key={cid} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs">
                <JobIcon state={job.state} />
                <span className="w-56 shrink-0 truncate font-medium">{c?.company ?? "A company"}</span>
                <span className={cn("min-w-0 flex-1 truncate", job.state === "error" ? "text-rose-700" : "text-mud-faint")}>
                  {job.state === "running" ? <span className="inline-flex items-center gap-1"><Search size={10} /> {job.step ?? "Mapping the buying committee"}</span>
                    : job.state === "done" ? (c?.status === "dismissed" ? c.dismissReason ?? "Disqualified" : `${c?.contacts.length ?? 0} people`)
                    : job.state === "error" ? job.error : job.state === "skipped" ? job.error ?? "Skipped" : "Waiting"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function JobIcon({ state }: { state: JobState }) {
  if (state === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-clay" />;
  if (state === "done") return <Check size={13} className="shrink-0 text-emerald-600" />;
  if (state === "error") return <AlertCircle size={13} className="shrink-0 text-rose-500" />;
  return <CircleDashed size={13} className="shrink-0 text-rim/50" />;
}
