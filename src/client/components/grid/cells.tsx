/** How a cell looks, and how it is edited, by column type. */
import { AlertTriangle, CalendarClock, ExternalLink } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { CampaignSchema, CellValue, Column } from "../../../shared/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { CUE_LABEL, cueFor } from "../../lib/cues";
import { formatDate, formatDateTime } from "../../lib/format";
import { toneFor } from "../../lib/stages";

export const display = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v));

export function hrefOf(text: string, type: Column["type"]): string | null {
  const t = text.trim();
  if (!t) return null;
  if (type === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`;
  return null;
}

export function openLink(url: string) {
  api.openUrl(url).catch((e) => toast.error(e.message));
}

export function StatusPill({ value, stages, className }: { value: string; stages: string[]; className?: string }) {
  if (!value) return <span className="text-ink-faint">—</span>;
  const tone = toneFor(value, stages);
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-xs font-medium", tone.pill, className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className="truncate">{value}</span>
    </span>
  );
}

export function CellView({
  col, cells, schema, stages,
}: {
  col: Column;
  cells: Record<string, CellValue>;
  schema: CampaignSchema;
  stages: string[];
}) {
  const v = cells[col.key];
  const text = display(v);
  const cue = cueFor(col, cells, schema);
  if (col.key === schema.statusKey) return <StatusPill value={text} stages={stages} />;
  if (!text) return null;

  switch (col.type) {
    case "select":
      return <span className="truncate rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-700">{text}</span>;
    case "date":
      return (
        <span className={cn("truncate tabular-nums", cue && "font-medium text-rose-700")} title={cue ? CUE_LABEL[cue] : text}>
          {/^\d{4}-\d{2}-\d{2}/.test(text) ? formatDate(text) : text}
        </span>
      );
    case "datetime":
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate tabular-nums", cue === "past" && "text-ink-faint")}>{formatDateTime(text)}</span>
          {cue === "today" && <span className="rounded bg-yellow-200 px-1 text-[10px] font-semibold text-yellow-900 uppercase">Today</span>}
          {cue === "upcoming" && <CalendarClock size={13} className="shrink-0 text-yellow-600" />}
        </span>
      );
    case "url":
    case "email": {
      const href = hrefOf(text, col.type);
      return (
        <span className="flex min-w-0 items-center gap-1">
          {cue === "unverified" && <AlertTriangle size={13} className="shrink-0 text-rose-500" aria-label={CUE_LABEL.unverified} />}
          <span className={cn("truncate", cue === "unverified" ? "text-rose-700" : "text-brand-700")} title={cue ? CUE_LABEL[cue] : text}>
            {text.replace(/^https?:\/\/(www\.)?/, "")}
          </span>
          {href && (
            <button
              className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 group-hover/cell:opacity-100 hover:bg-zinc-200 hover:text-ink"
              title={`Open ${href}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                openLink(href);
              }}
            >
              <ExternalLink size={12} />
            </button>
          )}
        </span>
      );
    }
    case "number":
      return <span className="ml-auto truncate tabular-nums">{text}</span>;
    case "currency": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
      return <span className="ml-auto truncate tabular-nums">{Number.isFinite(n) ? `$${n.toLocaleString()}` : text}</span>;
    }
    default:
      return <span className="truncate">{text}</span>;
  }
}

// ---------- editors ----------

export type Move = "down" | "right" | "left" | "up";

export interface EditorProps {
  col: Column;
  value: CellValue;
  initial?: string;
  onCommit: (v: CellValue, move?: Move) => void;
  onCancel: () => void;
}

export function coerce(raw: string, col: Column): CellValue {
  const s = raw;
  if (s.trim() === "") return null;
  if (col.type === "number" || col.type === "currency") {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && /\d/.test(s) ? n : s;
  }
  return s;
}

/** Datetime-local wants "YYYY-MM-DDTHH:mm"; accept a bare date too. */
const toLocalInput = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T09:00` : v.slice(0, 16));

export function CellEditor(props: EditorProps) {
  const { col } = props;
  if (col.type === "select") return <SelectEditor {...props} />;
  if (col.type === "longtext") return <LongTextEditor {...props} />;
  return <InputEditor {...props} />;
}

function InputEditor({ col, value, initial, onCommit, onCancel }: EditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const start = initial ?? display(value);
  const type = col.type === "date" ? "date" : col.type === "datetime" ? "datetime-local" : "text";
  const [draft, setDraft] = useState(type === "datetime-local" && start ? toLocalInput(start) : start);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (type === "text") {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
  }, [type]);
  const commit = (move?: Move) => {
    if (done.current) return;
    done.current = true;
    onCommit(coerce(draft, col), move);
  };
  return (
    <input
      ref={ref}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(e.shiftKey ? "up" : "down"); }
        else if (e.key === "Tab") { e.preventDefault(); commit(e.shiftKey ? "left" : "right"); }
        else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
      }}
      className="h-full w-full min-w-0 bg-white px-2 text-sm outline-none ring-2 ring-brand-400 ring-inset"
    />
  );
}

function LongTextEditor({ value, initial, onCommit, onCancel, col }: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial ?? display(value));
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = (move?: Move) => {
    if (done.current) return;
    done.current = true;
    onCommit(coerce(draft, col), move);
  };
  return (
    <div className="absolute top-0 left-0 z-30 w-[max(100%,380px)] rounded-lg bg-white shadow-xl ring-2 ring-brand-400">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit("down"); }
          else if (e.key === "Tab") { e.preventDefault(); commit(e.shiftKey ? "left" : "right"); }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
        }}
        rows={6}
        className="block w-full resize-y rounded-lg px-2.5 py-2 text-sm leading-relaxed outline-none"
      />
      <div className="border-t border-line px-2.5 py-1 text-[11px] text-ink-faint">Ctrl+Enter to save · Esc to cancel</div>
    </div>
  );
}

function SelectEditor({ col, value, initial, onCommit, onCancel }: EditorProps) {
  const options = col.options ?? [];
  const [filter, setFilter] = useState(initial ?? "");
  const list = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(filter.toLowerCase())),
    [options, filter],
  );
  const cur = display(value);
  const [hi, setHi] = useState(() => Math.max(0, options.indexOf(cur)));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => setHi((h) => Math.min(h, Math.max(0, list.length - 1))), [list.length]);
  const pick = (v: CellValue, move?: Move) => {
    if (done.current) return;
    done.current = true;
    onCommit(v, move);
  };
  return (
    <div className="absolute top-0 left-0 z-30 w-[max(100%,220px)] overflow-hidden rounded-lg bg-white shadow-xl ring-2 ring-brand-400">
      <input
        ref={ref}
        value={filter}
        placeholder={cur || "Choose…"}
        onChange={(e) => { setFilter(e.target.value); setHi(0); }}
        onBlur={() => { if (!done.current) { done.current = true; onCancel(); } }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); if (list[hi] !== undefined) pick(list[hi]!, "down"); else if (!filter) pick(null, "down"); }
          else if (e.key === "Tab") { e.preventDefault(); if (list[hi] !== undefined && filter) pick(list[hi]!, "right"); else { done.current = true; onCancel(); } }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
        }}
        className="h-8 w-full border-b border-line px-2 text-sm outline-none"
      />
      <ul className="max-h-60 overflow-y-auto py-1 scroll-thin">
        {list.map((o, i) => (
          <li key={o}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseEnter={() => setHi(i)}
              className={cn("flex w-full items-center px-2.5 py-1 text-left text-sm", i === hi && "bg-brand-50", o === cur && "font-semibold")}
            >
              {o}
            </button>
          </li>
        ))}
        {!list.length && <li className="px-2.5 py-1.5 text-xs text-ink-faint">No matching option</li>}
        {cur && (
          <li className="border-t border-line">
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null)} className="w-full px-2.5 py-1.5 text-left text-xs text-ink-faint hover:bg-zinc-50">
              Clear
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
