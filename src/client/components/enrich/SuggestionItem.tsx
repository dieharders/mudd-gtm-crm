/** One AI suggestion: what the cell has, what the research found, where it came from. */
import { Check, ExternalLink, Info, X } from "lucide-react";
import type { Suggestion } from "../../../shared/ai";
import type { Column } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { formatDate } from "../../lib/format";
import { display, hrefOf, openLink } from "../grid/cells";

/** The tag colours for a finding's confidence, wherever one is shown (a suggestion, a person in the Discovery inbox). */
export const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-zinc-100 text-zinc-600",
};

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/)[0] ?? url;

/** A source link as a small chip: the page's host, opening the page outside the app. */
export function SourceChip({ url, title, className }: { url: string; title?: string; className?: string }) {
  const href = hrefOf(url, "url");
  if (!href) return null;
  return (
    <button onClick={() => openLink(href)} title={title ?? url} className={cn("tag max-w-[16rem] bg-sky-50 text-sky-800 ring-1 ring-sky-100 hover:bg-sky-100", className)}>
      <ExternalLink size={10} className="shrink-0" /> <span className="truncate">{host(url)}</span>
    </button>
  );
}

function show(v: Suggestion["value"], col?: Column): string {
  const t = display(v);
  return col?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(t) ? formatDate(t) : t;
}

export function SuggestionItem({ s, col, onAccept, onReject, compact }: {
  s: Suggestion;
  col?: Column;
  onAccept: () => void;
  onReject: () => void;
  compact?: boolean;
}) {
  const long = (col?.type === "longtext") || String(s.value ?? "").length > 90;
  return (
    <div className={cn("group rounded-xl border border-line bg-white p-3 transition hover:border-brand-200", compact && "p-2.5")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">{col?.header ?? s.key}</span>
            {s.confidence && <span className={cn("tag text-[10.5px]", CONFIDENCE_TONE[s.confidence])}>{s.confidence}</span>}
          </div>
          {s.previous !== null && s.previous !== "" && (
            <p className="mt-1 truncate text-xs text-ink-faint line-through" title={display(s.previous)}>{show(s.previous, col)}</p>
          )}
          <p className={cn("mt-0.5 text-[13.5px] font-medium text-ink", long ? "leading-relaxed whitespace-pre-line" : "truncate")} title={long ? undefined : display(s.value)}>
            {show(s.value, col)}
          </p>
          {(s.sources.length > 0 || s.note) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {s.sources.slice(0, 4).map((src) => <SourceChip key={src.url} url={src.url} title={src.title} />)}
              {s.note && (
                <span className="inline-flex max-w-full items-start gap-1 text-[11.5px] leading-snug text-ink-soft">
                  <Info size={11} className="mt-0.5 shrink-0 text-ink-faint" /> <span className="whitespace-pre-line">{s.note}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onReject} title="Reject" className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-ink-faint hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600">
            <X size={14} />
          </button>
          <button onClick={onAccept} title="Accept into the sheet" className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)] hover:bg-brand-600">
            <Check size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
