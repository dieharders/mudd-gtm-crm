/**
 * The reading view: each prospect as a card you can read top to bottom, grouped by tier (or
 * status, or any dropdown). Same rows, filters and prospect panel as the grid. A screened-out
 * prospect's card is greyed out, with the reason, and still opens. Its people are chips, each
 * opening that contact in the prospect panel.
 */
import { AlertTriangle, Ban, CalendarClock, ExternalLink, Mail, MessageSquareText, Phone, Star, Users } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import { contactSchema } from "../../../shared/schema";
import { DEAD, isScreened, type CampaignSchema, type CellValue, type Column, type Row } from "../../../shared/types";
import { contactLabel, orderedContacts, primaryOf, toNumber } from "../../../shared/values";
import { cn } from "../../lib/cn";
import { cueFor } from "../../lib/cues";
import { formatDate, formatDateTime, relative } from "../../lib/format";
import { cardLayout, type CardLayout } from "../../lib/listLayout";
import { tileFor, toneFor, typeTone } from "../../lib/stages";
import { display, hrefOf, openLink, StatusPill } from "../grid/cells";
import { Tile } from "../ui/Logo";

/** Contact chips a card shows before "+N more". */
const CHIPS = 4;

const split = (v: string) => v.split(/\s*;\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);

interface Props {
  rows: Row[];
  schema: CampaignSchema;
  stages: string[];
  groupBy: string | null;
  openRowId: string | null;
  onOpenRow: (id: string) => void;
  /** A prospect's contacts: the same array while they are unchanged. */
  contactsOf: (orgId: string) => Row[];
  onOpenContact: (id: string) => void;
  pending?: Map<string, Set<string>>;
}

export function ProspectList({ rows, schema, stages, groupBy, openRowId, onOpenRow, contactsOf, onOpenContact, pending }: Props) {
  const layout = useMemo(() => cardLayout(schema), [schema]);
  const groups = useMemo(() => groupRows(rows, schema, stages, groupBy), [rows, schema, stages, groupBy]);
  const groupCol = schema.columns.find((c) => c.key === groupBy);

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-4xl px-6 py-5">
        {groups.map((g) => (
          <section key={g.label} className="mb-8 last:mb-2">
            {groupCol && (
              <div className="sticky top-0 z-10 -mx-2 mb-3 flex items-center gap-2 bg-paper/90 px-2 py-2 backdrop-blur-sm">
                <span className="eyebrow">{groupCol.header}</span>
                {groupCol.key === schema.statusKey ? (
                  <StatusPill value={g.value} stages={stages} />
                ) : (
                  <span className={cn("tag", groupTone(g.index))}>{g.label}</span>
                )}
                <span className="ml-auto text-xs text-mud-faint tabular-nums">{g.rows.length}</span>
              </div>
            )}
            <div className="space-y-3">
              {g.rows.map((row) => {
                const contacts = contactsOf(row.id);
                const pendingCount = [row, ...contacts].reduce((n, r) => n + (pending?.get(r.id)?.size ?? 0), 0);
                return (
                  <ProspectCard
                    key={row.id}
                    row={row}
                    contacts={contacts}
                    schema={schema}
                    stages={stages}
                    layout={layout}
                    active={row.id === openRowId}
                    onOpenRow={onOpenRow}
                    onOpenContact={onOpenContact}
                    hideTier={groupBy === layout.tierKey}
                    pendingCount={pendingCount}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const GROUP_TONES = ["bg-lake-soft text-lake-deep", "bg-sky-100 text-sky-800", "bg-yellow-100 text-yellow-800", "bg-pink-100 text-pink-800", "bg-emerald-100 text-emerald-800", "bg-orange-100 text-orange-800"];
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

// Memoized, with stable callbacks and contact lists: an edit re-renders only the card whose
// prospect or contacts changed.
const ProspectCard = memo(function ProspectCard({ row, contacts, schema, stages, layout, active, onOpenRow, onOpenContact, hideTier, pendingCount }: {
  row: Row; contacts: Row[]; schema: CampaignSchema; stages: string[]; layout: CardLayout; active: boolean;
  onOpenRow: (id: string) => void; onOpenContact: (id: string) => void; hideTier: boolean; pendingCount: number;
}) {
  const onOpen = () => onOpenRow(row.id);
  const c = row.cells;
  const txt = (k?: string) => (k ? display(c[k]) : "");
  const title = txt(layout.titleKey) || "Untitled prospect";
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
      // Only the card's own keys: Enter on a chip or link inside opens that, not the prospect.
      onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 220px" }}
      className={cn(
        "group grid cursor-pointer gap-5 rounded-2xl border-2 bg-paper p-5 transition sm:grid-cols-[124px_1fr]",
        active ? "border-clay shadow-hard-sm" : "border-rim/40 hover:border-clay hover:shadow-hard-sm",
        screened ? "bg-paper-deep/40 opacity-60 hover:opacity-80" : dead && "opacity-70",
      )}
    >
      <div className="flex flex-row flex-wrap items-start gap-2 sm:flex-col">
        {screened && <span className="tag bg-paper-deep text-mud-soft"><Ban size={12} /> Screened out</span>}
        {schema.statusKey && <StatusPill value={status || "No status"} stages={stages} />}
        {tier && !hideTier && <span className="tag bg-paper-deep text-mud-soft">{schema.columns.find((x) => x.key === layout.tierKey)?.header ?? "Tier"} {tier}</span>}
        {meetingAt && (
          <span className="tag bg-yellow-100 text-yellow-800" title={formatDateTime(meetingAt)}>
            <CalendarClock size={12} /> {relative(meetingAt)}
          </span>
        )}
        {intro && <span className="tag bg-lake-soft text-lake-deep"><MessageSquareText size={12} /> Intro drafted</span>}
        {pendingCount > 0 && <span className="tag bg-clay text-white">✨ {pendingCount} to review</span>}
      </div>

      <div className="min-w-0">
        <h3 className="flex items-baseline gap-2 font-display text-[21px] leading-snug font-bold tracking-tight group-hover:text-clay-deep">
          {layout.rankKey && txt(layout.rankKey) && <span className="text-xs font-semibold text-mud-faint tabular-nums">#{txt(layout.rankKey)}</span>}
          <span className="min-w-0">{title}</span>
        </h3>
        {layout.subtitleKey && txt(layout.subtitleKey) && <p className="mt-0.5 text-xs font-medium text-clay-deep">{txt(layout.subtitleKey)}</p>}

        {reason && (
          <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[13px] leading-relaxed text-rose-900">
            <span className="mr-1 font-semibold">Screened out:</span>{reason}
          </p>
        )}

        {paragraphs.length > 0 && (
          <div className="mt-3 space-y-2.5">
            {paragraphs.map((p, i) => (
              <p key={p.col.key} className={cn("max-w-prose text-[13.5px] leading-relaxed whitespace-pre-line", i === 0 ? "text-mud" : "text-mud-soft")}>
                {paragraphs.length > 1 && <span className="mr-1.5 text-[10.5px] font-semibold tracking-wider text-mud-faint uppercase">{p.col.header}</span>}
                {p.v}
              </p>
            ))}
          </div>
        )}

        {contacts.length > 0 && <ContactChips contacts={contacts} schema={schema} onOpenContact={onOpenContact} onMore={onOpen} />}

        {(emails.length > 0 || phones.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            {emails.map(({ v, col }) => {
              const cue = cueFor(col, c, schema);
              const href = hrefOf(v, "email");
              return (
                <span key={v} className={cn("inline-flex items-center gap-1.5", cue === "unverified" ? "text-rose-700" : "text-mud-soft")} title={cue === "unverified" ? "Pattern email: inferred, verify before sending" : undefined}>
                  {cue === "unverified" ? <AlertTriangle size={13} /> : <Mail size={13} className="text-mud-faint" />}
                  {href ? <LinkText href={href}>{v}</LinkText> : v}
                </span>
              );
            })}
            {phones.map((v) => (
              <span key={v} className="inline-flex items-center gap-1.5 text-mud-soft"><Phone size={13} className="text-mud-faint" />{v}</span>
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
                <span key={col.key + v} className="tag bg-paper-deep text-mud-soft">{v}</span>
              );
            })}
          </div>
        )}

        {facts.length > 0 && (
          <dl className="mt-3.5 flex flex-wrap gap-1.5 border-t border-dashed border-rim/40 pt-3">
            {facts.map(({ col, v }) => <Fact key={col.key} col={col} v={v} cells={c} schema={schema} />)}
          </dl>
        )}
      </div>
    </article>
  );
});

/** The prospect's people as chips, primary first: each opens that contact. */
function ContactChips({ contacts, schema, onOpenContact, onMore }: { contacts: Row[]; schema: CampaignSchema; onOpenContact: (id: string) => void; onMore: () => void }) {
  const cs = contactSchema(schema);
  const options = cs.columns.find((col) => col.key === cs.typeKey)?.options;
  const primary = primaryOf(contacts, schema);
  const list = orderedContacts(contacts, schema);
  const more = list.length - CHIPS;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      <Users size={13} className="mr-0.5 text-mud-faint" aria-label="Contacts" />
      {list.slice(0, CHIPS).map((p) => {
        const label = contactLabel(p, schema);
        const type = cs.typeKey ? display(p.cells[cs.typeKey]).trim() : "";
        return (
          <button
            key={p.id}
            onClick={(e) => { e.stopPropagation(); onOpenContact(p.id); }}
            title={`Open ${label}${type ? ` · ${type}` : ""}${p === primary ? " · primary contact" : ""}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-rim/40 bg-paper py-0.5 pr-2 pl-0.5 text-xs transition hover:border-clay hover:bg-clay-soft/50"
          >
            <Tile size="sm" className={cn("h-5 w-5 rounded-full text-[10px]", tileFor(p.id))}>{label[0]?.toUpperCase() ?? "?"}</Tile>
            <span className="truncate font-medium">{label}</span>
            {p === primary && <Star size={10} className="shrink-0 fill-amber-400 text-amber-400" />}
            {type && <span className={cn("shrink-0 rounded-full px-1.5 text-[10.5px] font-medium", typeTone(type, options))}>{type}</span>}
          </button>
        );
      })}
      {more > 0 && (
        <button onClick={(e) => { e.stopPropagation(); onMore(); }} className="rounded-full px-2 py-0.5 text-xs text-mud-soft hover:bg-paper-deep hover:text-mud">
          +{more} more
        </button>
      )}
    </div>
  );
}

function Fact({ col, v, cells, schema }: { col: Column; v: string; cells: Record<string, CellValue>; schema: CampaignSchema }) {
  const cue = cueFor(col, cells, schema);
  const amount = col.type === "currency" ? toNumber(v) : null;
  const value = col.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(v) ? formatDate(v) : col.type === "datetime" ? formatDateTime(v) : amount !== null ? `$${amount.toLocaleString()}` : v;
  const tone = col.type === "select" && col.key !== schema.statusKey ? toneFor(v, col.options ?? []).pill : "";
  return (
    <div className={cn("inline-flex max-w-full items-baseline gap-1.5 rounded-lg border px-2 py-1 text-xs", cue === "expired" ? "border-rose-200 bg-rose-50" : "border-rim/40 bg-paper")}>
      <dt className="shrink-0 text-mud-faint">{col.header}</dt>
      <dd className={cn("min-w-0 truncate font-medium", cue === "expired" ? "text-rose-700" : "text-mud", tone && "rounded-sm px-1", tone)} title={v}>
        {value.length > 60 ? `${value.slice(0, 58)}…` : value}
      </dd>
    </div>
  );
}

function LinkText({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      className="underline decoration-rim/60 underline-offset-2 hover:text-clay-deep hover:decoration-clay"
      onClick={(e) => { e.stopPropagation(); openLink(href); }}
    >
      {children}
    </button>
  );
}
