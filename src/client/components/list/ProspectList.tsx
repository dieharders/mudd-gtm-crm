/**
 * The reading view: each prospect as a card you can read top to bottom, grouped by tier (or
 * status, or any dropdown). Same rows, filters and prospect panel as the grid. A screened-out
 * prospect's card is greyed out, with the reason, and still opens.
 */
import { AlertTriangle, Ban, CalendarClock, ExternalLink, Mail, MessageSquareText, Phone, Users } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import { DEAD, isScreened, type CampaignSchema, type CellValue, type Column, type Row } from "../../../shared/types";
import { toNumber } from "../../../shared/values";
import { cn } from "../../lib/cn";
import { cueFor } from "../../lib/cues";
import { formatDate, formatDateTime, relative } from "../../lib/format";
import { cardLayout, type CardLayout } from "../../lib/listLayout";
import { toneFor } from "../../lib/stages";
import { display, hrefOf, openLink, StatusPill } from "../grid/cells";

const split = (v: string) => v.split(/\s*;\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);

interface Props {
  rows: Row[];
  schema: CampaignSchema;
  stages: string[];
  groupBy: string | null;
  openRowId: string | null;
  onOpenRow: (id: string) => void;
  pending?: Map<string, Set<string>>;
}

export function ProspectList({ rows, schema, stages, groupBy, openRowId, onOpenRow, pending }: Props) {
  const layout = useMemo(() => cardLayout(schema), [schema]);
  const groups = useMemo(() => groupRows(rows, schema, stages, groupBy), [rows, schema, stages, groupBy]);
  const groupCol = schema.columns.find((c) => c.key === groupBy);

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-4xl px-6 py-5">
        {groups.map((g) => (
          <section key={g.label} className="mb-8 last:mb-2">
            {groupCol && (
              <div className="sticky top-0 z-10 -mx-2 mb-3 flex items-center gap-2 bg-white/90 px-2 py-2 backdrop-blur-sm">
                <span className="eyebrow">{groupCol.header}</span>
                {groupCol.key === schema.statusKey ? (
                  <StatusPill value={g.value} stages={stages} />
                ) : (
                  <span className={cn("tag", groupTone(g.index))}>{g.label}</span>
                )}
                <span className="ml-auto text-xs text-ink-faint tabular-nums">{g.rows.length}</span>
              </div>
            )}
            <div className="space-y-3">
              {g.rows.map((row) => (
                <ProspectCard
                  key={row.id}
                  row={row}
                  schema={schema}
                  stages={stages}
                  layout={layout}
                  active={row.id === openRowId}
                  onOpenRow={onOpenRow}
                  hideTier={groupBy === layout.tierKey}
                  pendingCount={pending?.get(row.id)?.size ?? 0}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const GROUP_TONES = ["bg-violet-100 text-violet-800", "bg-sky-100 text-sky-800", "bg-yellow-100 text-yellow-800", "bg-pink-100 text-pink-800", "bg-emerald-100 text-emerald-800", "bg-orange-100 text-orange-800"];
const groupTone = (i: number) => GROUP_TONES[i % GROUP_TONES.length]!;

function groupRows(rows: Row[], schema: CampaignSchema, stages: string[], key: string | null) {
  if (!key) return [{ label: "all", value: "", index: 0, rows }];
  const col = schema.columns.find((c) => c.key === key);
  const order = (key === schema.statusKey ? [...stages, DEAD] : col?.options ?? []).map((o) => o.toLowerCase());
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const v = display(r.cells[key]);
    const group = map.get(v);
    if (group) group.push(r);
    else map.set(v, [r]);
  }
  // The dropdown's order first, then values it doesn't list as they come, and "Not set" last.
  const values = [...map.keys()];
  const rank = new Map<string, number>();
  values.forEach((v, seen) => {
    const i = order.indexOf(v.toLowerCase());
    rank.set(v, !v ? Number.MAX_SAFE_INTEGER : i < 0 ? order.length + seen : i);
  });
  return values
    .sort((a, b) => rank.get(a)! - rank.get(b)!)
    .map((v, index) => ({ label: v || "Not set", value: v, index, rows: map.get(v)! }));
}

// Memoized, with a stable onOpenRow: an edit re-renders only the card whose row changed.
const ProspectCard = memo(function ProspectCard({ row, schema, stages, layout, active, onOpenRow, hideTier, pendingCount }: {
  row: Row; schema: CampaignSchema; stages: string[]; layout: CardLayout; active: boolean; onOpenRow: (id: string) => void; hideTier: boolean; pendingCount: number;
}) {
  const onOpen = () => onOpenRow(row.id);
  const c = row.cells;
  const txt = (k?: string) => (k ? display(c[k]) : "");
  const title = txt(layout.titleKey) || "Untitled prospect";
  const contact = schema.nameKey && schema.nameKey !== layout.titleKey ? txt(schema.nameKey) : "";
  const role = txt(layout.roleKey);
  const others = txt(layout.otherContactsKey);
  const status = txt(schema.statusKey);
  const tier = txt(layout.tierKey);
  const emails = layout.emailKeys.flatMap((k) => split(txt(k)).map((v) => ({ v, col: schema.columns.find((x) => x.key === k)! })));
  const phones = layout.phoneKeys.flatMap((k) => split(txt(k)));
  const links = layout.links.flatMap((col) => split(txt(col.key)).map((v) => ({ v, col })));
  const paragraphs = layout.paragraphs.map((col) => ({ col, v: txt(col.key) })).filter((p) => p.v);
  const facts = layout.facts.map((col) => ({ col, v: txt(col.key) })).filter((f) => f.v);
  const meetingAt = txt(schema.meetingAtKey);
  const intro = txt(schema.introKey);
  const screened = isScreened(row, schema);
  const reason = screened ? txt(schema.reasonKey) : "";
  const dead = status === DEAD;

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 220px" }}
      className={cn(
        "group grid cursor-pointer gap-5 rounded-2xl border bg-white p-5 transition sm:grid-cols-[124px_1fr]",
        active ? "border-brand-300 shadow-[0_0_0_3px_var(--color-brand-100)]" : "border-line hover:border-brand-200 hover:shadow-[0_8px_30px_-14px_rgba(103,68,245,0.35)]",
        screened ? "bg-zinc-50 opacity-60 hover:opacity-80" : dead && "opacity-70",
      )}
    >
      <div className="flex flex-row flex-wrap items-start gap-2 sm:flex-col">
        {screened && <span className="tag bg-zinc-200 text-zinc-700"><Ban size={12} /> Screened out</span>}
        {schema.statusKey && <StatusPill value={status || "No status"} stages={stages} />}
        {tier && !hideTier && <span className="tag bg-zinc-100 text-zinc-700">{schema.columns.find((x) => x.key === layout.tierKey)?.header ?? "Tier"} {tier}</span>}
        {meetingAt && (
          <span className="tag bg-yellow-100 text-yellow-800" title={formatDateTime(meetingAt)}>
            <CalendarClock size={12} /> {relative(meetingAt)}
          </span>
        )}
        {intro && <span className="tag bg-violet-100 text-violet-800"><MessageSquareText size={12} /> Intro drafted</span>}
        {pendingCount > 0 && <span className="tag bg-brand-500 text-white">✨ {pendingCount} to review</span>}
      </div>

      <div className="min-w-0">
        <h3 className="flex items-baseline gap-2 text-[19px] leading-snug font-bold tracking-tight group-hover:text-brand-700">
          {layout.rankKey && txt(layout.rankKey) && <span className="text-xs font-semibold text-ink-faint tabular-nums">#{txt(layout.rankKey)}</span>}
          <span className="min-w-0">{title}</span>
        </h3>
        {layout.subtitleKey && txt(layout.subtitleKey) && <p className="mt-0.5 text-xs font-medium text-brand-600">{txt(layout.subtitleKey)}</p>}

        {reason && (
          <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[13px] leading-relaxed text-rose-900">
            <span className="mr-1 font-semibold">Screened out:</span>{reason}
          </p>
        )}

        {paragraphs.length > 0 && (
          <div className="mt-3 space-y-2.5">
            {paragraphs.map((p, i) => (
              <p key={p.col.key} className={cn("max-w-prose text-[13.5px] leading-relaxed whitespace-pre-line", i === 0 ? "text-ink" : "text-ink-soft")}>
                {paragraphs.length > 1 && <span className="mr-1.5 text-[10.5px] font-semibold tracking-wider text-ink-faint uppercase">{p.col.header}</span>}
                {p.v}
              </p>
            ))}
          </div>
        )}

        {(contact || role || others) && (
          <div className="mt-4 rounded-xl border border-line bg-zinc-50/70 px-3.5 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <Users size={13} className="self-center text-ink-faint" />
              {contact && <span className="text-sm font-semibold">{contact}</span>}
              {role && <span className="text-[13px] text-ink-soft">{role}</span>}
            </div>
            {others && <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">Also: {others}</p>}
          </div>
        )}

        {(emails.length > 0 || phones.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            {emails.map(({ v, col }) => {
              const cue = cueFor(col, c, schema);
              const href = hrefOf(v, "email");
              return (
                <span key={v} className={cn("inline-flex items-center gap-1.5", cue === "unverified" ? "text-rose-700" : "text-ink-soft")} title={cue === "unverified" ? "Pattern email: inferred, verify before sending" : undefined}>
                  {cue === "unverified" ? <AlertTriangle size={13} /> : <Mail size={13} className="text-ink-faint" />}
                  {href ? <LinkText href={href}>{v}</LinkText> : v}
                </span>
              );
            })}
            {phones.map((v) => (
              <span key={v} className="inline-flex items-center gap-1.5 text-ink-soft"><Phone size={13} className="text-ink-faint" />{v}</span>
            ))}
          </div>
        )}

        {links.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {links.map(({ v, col }) => {
              const href = hrefOf(v, "url");
              const host = v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
              return href ? (
                <button
                  key={col.key + v}
                  onClick={(e) => { e.stopPropagation(); openLink(href); }}
                  title={`${col.header}: ${href}`}
                  className="tag max-w-full bg-sky-50 text-sky-800 ring-1 ring-sky-100 hover:bg-sky-100"
                >
                  <ExternalLink size={11} className="shrink-0" /> <span className="truncate">{host.length > 48 ? `${host.slice(0, 46)}…` : host}</span>
                </button>
              ) : (
                <span key={col.key + v} className="tag bg-zinc-100 text-zinc-600">{v}</span>
              );
            })}
          </div>
        )}

        {facts.length > 0 && (
          <dl className="mt-3.5 flex flex-wrap gap-1.5 border-t border-dashed border-line pt-3">
            {facts.map(({ col, v }) => <Fact key={col.key} col={col} v={v} cells={c} schema={schema} />)}
          </dl>
        )}
      </div>
    </article>
  );
});

function Fact({ col, v, cells, schema }: { col: Column; v: string; cells: Record<string, CellValue>; schema: CampaignSchema }) {
  const cue = cueFor(col, cells, schema);
  const amount = col.type === "currency" ? toNumber(v) : null;
  const value = col.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(v) ? formatDate(v) : col.type === "datetime" ? formatDateTime(v) : amount !== null ? `$${amount.toLocaleString()}` : v;
  const tone = col.type === "select" && col.key !== schema.statusKey ? toneFor(v, col.options ?? []).pill : "";
  return (
    <div className={cn("inline-flex max-w-full items-baseline gap-1.5 rounded-lg border px-2 py-1 text-xs", cue === "overdue" || cue === "expired" ? "border-rose-200 bg-rose-50" : "border-line bg-white")}>
      <dt className="shrink-0 text-ink-faint">{col.header}</dt>
      <dd className={cn("min-w-0 truncate font-medium", cue === "overdue" || cue === "expired" ? "text-rose-700" : "text-ink", tone && "rounded-sm px-1", tone)} title={v}>
        {value.length > 60 ? `${value.slice(0, 58)}…` : value}
      </dd>
    </div>
  );
}

function LinkText({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      className="underline decoration-line-strong underline-offset-2 hover:text-brand-700 hover:decoration-brand-300"
      onClick={(e) => { e.stopPropagation(); openLink(href); }}
    >
      {children}
    </button>
  );
}
