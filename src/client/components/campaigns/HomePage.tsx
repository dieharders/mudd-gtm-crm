import {
  ArrowRight, CalendarClock, Download, FileSpreadsheet, FolderOpen, MoreHorizontal, Plus, Sparkles, Trash2, Video, Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEAD, MEETING_STAGE, type CampaignSummary, type Meeting } from "../../../shared/types";
import { api } from "../../lib/api";
import { useCampaignList } from "../../lib/campaignList";
import { cn } from "../../lib/cn";
import { formatDateTime, isSameDay, parseLocal, relative, timeAgo } from "../../lib/format";
import { paperTileFor } from "../../lib/paper";
import { toneFor } from "../../lib/stages";
import { Tile } from "../ui/Logo";
import { MenuItem, Popover } from "../ui/Menu";
import { useImport } from "./ImportFlow";
import { RemoveCampaignDialog } from "./RemoveCampaignDialog";
import { fire } from "../../lib/fire";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The home screen, in the paper look: a board with pinned cards. */
export function HomePage({ onNewCampaign }: { onNewCampaign: () => void }) {
  const { campaigns, meetings } = useCampaignList();
  const [removing, setRemoving] = useState<CampaignSummary | null>(null);
  const { startImport, busy } = useImport();

  const totals = (campaigns ?? []).reduce(
    (t, c) => ({ prospects: t.prospects + c.prospects, meetings: t.meetings + (c.byStatus[MEETING_STAGE] ?? 0), signed: t.signed + (c.byStatus.Signed ?? 0) }),
    { prospects: 0, meetings: 0, signed: 0 },
  );

  return (
    <div className="paper h-full overflow-y-auto bg-board scroll-thin">
      <div className="mx-auto max-w-6xl px-6 py-8 md:px-10 md:py-10">
        <div className="mb-10 flex flex-wrap items-end gap-4">
          <div className="mr-auto">
            <span className="relative mb-5 inline-block -rotate-1 rounded-lg border-2 border-rim bg-note px-4 py-1.5 font-label text-[15px] shadow-hard-sm">
              <span className="pin scale-75" />
              {greeting()} 👋
            </span>
            <h1 className="font-display text-[40px] leading-none font-bold tracking-tight">Your campaigns</h1>
          </div>
          <button className="paper-btn" onClick={startImport} disabled={busy}>
            <FolderOpen size={18} /> {busy ? "Opening…" : "Import sheet"}
          </button>
          <button className="paper-btn paper-btn-primary" onClick={onNewCampaign}>
            <Plus size={18} /> New campaign
          </button>
        </div>

        {campaigns === null ? (
          <div className="grid gap-6 sm:grid-cols-2">
            {[0, 1].map((i) => <div key={i} className="h-48 animate-pulse rounded-2xl border-2 border-dashed border-rim/50 bg-paper-deep" />)}
          </div>
        ) : campaigns.length === 0 ? (
          <Onboarding />
        ) : (
          <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-6">
              <div className="grid gap-5 sm:grid-cols-3">
                <StatCard tile="bg-clay-soft" icon={<Sparkles size={18} />} value={totals.prospects} label="prospects" />
                <StatCard tile="bg-note" icon={<CalendarClock size={18} />} value={totals.meetings} label="meetings booked" />
                <StatCard tile="bg-note-mint" icon={<Workflow size={18} />} value={totals.signed} label="signed" />
              </div>
              <div className="grid gap-6 xl:grid-cols-2">
                {campaigns.map((c) => <CampaignCard key={c.id} c={c} onRemove={() => setRemoving(c)} />)}
              </div>
            </div>
            <aside>
              <MeetingsCard meetings={meetings} limit={6} paper />
            </aside>
          </div>
        )}
      </div>

      <RemoveCampaignDialog campaign={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

export function MeetingsPage() {
  const { meetings } = useCampaignList();
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <p className="eyebrow mb-1">Calendar</p>
        <h1 className="mb-6 text-[26px] font-bold tracking-tight">Meetings</h1>
        <MeetingsCard meetings={meetings} />
      </div>
    </div>
  );
}

function StatCard({ tile, icon, value, label }: { tile: string; icon: ReactNode; value: number; label: string }) {
  return (
    <div className="paper-card flex items-center gap-4 px-5 py-4">
      <Tile size="lg" className={cn("border-2 border-rim text-mud", tile)}>{icon}</Tile>
      <div>
        <div className="font-display text-[30px] leading-none font-bold tabular-nums">{value}</div>
        <div className="mt-1.5 font-label text-sm text-mud-soft">{label}</div>
      </div>
    </div>
  );
}

/** First run: the three steps as sticky notes pinned to a card. The page header has the buttons. */
function Onboarding() {
  const steps = [
    { note: "bg-note -rotate-1", icon: <FileSpreadsheet size={18} />, title: "Bring your sheet", tags: ["Excel", "CSV"], body: "Import a tracker, or start from a blank layout." },
    { note: "bg-note-pink rotate-1", icon: <Workflow size={18} />, title: "Work the pipeline", tags: ["Status", "Meetings", "Intro msgs"], body: "Edit like a spreadsheet, track every touch." },
    { note: "bg-note-mint -rotate-1", icon: <Download size={18} />, title: "Export it back", tags: ["Same formatting", "Formulas intact"], body: "Your sheet, with every edit, exactly as it looked." },
  ];
  return (
    <div className="paper-card p-8 md:p-10">
      <h2 className="font-display text-[28px] leading-tight font-bold tracking-tight">Start with a spreadsheet you already have.</h2>
      <p className="mt-2 max-w-xl text-[15px] text-mud-soft">Everything stays on this computer. Drop a file anywhere on this window, or use Import sheet above.</p>
      <div className="mt-10 grid items-stretch gap-8 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-5">
        {steps.map((s, i) => (
          <div key={s.title} className="contents">
            <div className={cn("note", s.note)}>
              <span className="pin" />
              <div className="flex items-center gap-3">
                <Tile size="lg" className="border-2 border-rim bg-paper text-mud">{s.icon}</Tile>
                <span className="font-display text-lg font-bold">{s.title}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {s.tags.map((t) => <span key={t} className="paper-tag bg-paper/70 font-bold">{t}</span>)}
              </div>
              <p className="mt-3 font-label text-sm text-mud-soft">{s.body}</p>
            </div>
            {i < steps.length - 1 && <ArrowRight className="hidden self-center text-rim md:block" size={26} strokeWidth={2.5} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function CampaignCard({ c, onRemove }: { c: CampaignSummary; onRemove: () => void }) {
  const navigate = useNavigate();
  const stages = [...c.stages, DEAD];
  const total = c.prospects || 1;
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => void navigate(`/c/${c.id}`)}
      onKeyDown={(e) => { if (e.key === "Enter") void navigate(`/c/${c.id}`); }}
      className="paper-card group cursor-pointer p-6 transition hover:-translate-y-0.5 hover:shadow-hard-lg"
    >
      <div className="flex items-start gap-4">
        <Tile size="lg" className={cn("text-lg", paperTileFor(c.id))}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-[21px] leading-tight font-bold group-hover:text-clay-deep">{c.name}</h3>
          <p className="mt-0.5 truncate text-[13px] text-mud-faint">
            {c.sourceName ? <>From {c.sourceName}</> : "Created in Mudd"} · {timeAgo(c.updatedAt)}
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Popover align="right" trigger={({ toggle }) => (
            <button className="rounded-lg border-2 border-transparent p-1.5 text-mud-faint hover:border-rim hover:bg-paper-deep hover:text-mud" onClick={toggle} aria-label="Campaign menu">
              <MoreHorizontal size={20} />
            </button>
          )}>
            {(close) => <MenuItem danger icon={<Trash2 size={15} />} onClick={() => { close(); onRemove(); }} hint="The file stays">Remove from Mudd</MenuItem>}
          </Popover>
        </div>
      </div>

      <div className="mt-5 flex items-baseline gap-6">
        <div><span className="font-display text-[30px] font-bold tabular-nums">{c.prospects}</span> <span className="font-label text-sm text-mud-faint">prospects</span></div>
        <div className="font-label text-sm text-mud-faint"><span className="font-bold text-mud-soft tabular-nums">{c.screened}</span> screened out</div>
      </div>

      <div className="mt-4 flex h-4 gap-0.5 overflow-hidden rounded-full border-2 border-rim bg-paper-deep p-px">
        {stages.map((s) => {
          const n = c.byStatus[s] ?? 0;
          if (!n) return null;
          return <div key={s} title={`${s}: ${n}`} className={cn("rounded-full", toneFor(s, c.stages).bar)} style={{ width: `${(n / total) * 100}%` }} />;
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {stages.filter((s) => c.byStatus[s]).map((s) => (
          <span key={s} className={cn("paper-tag", toneFor(s, c.stages).pill)}>
            <span className="font-bold">{s}</span> <span className="tabular-nums">{c.byStatus[s]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Shared with the Meetings page, which keeps the old look: `paper` switches this one to the home screen's. */
function MeetingsCard({ meetings, limit, paper }: { meetings: Meeting[]; limit?: number; paper?: boolean }) {
  const now = new Date();
  const soon = meetings.filter((m) => {
    const d = parseLocal(m.at);
    return d && (d >= now || isSameDay(d, now));
  });
  const stale = meetings.filter((m) => {
    const d = parseLocal(m.at);
    return d && d < now && !isSameDay(d, now) && m.status === MEETING_STAGE;
  });
  return (
    <div className={paper ? "paper-card p-5" : "card p-4"}>
      <h2 className={cn("flex items-center gap-2.5 text-sm font-semibold", paper && "gap-3 font-display text-lg font-bold")}>
        <Tile size={paper ? "md" : "sm"} className={paper ? "border-2 border-rim bg-note text-mud" : "bg-yellow-100 text-yellow-700"}><CalendarClock size={paper ? 16 : 13} /></Tile> Upcoming meetings
      </h2>
      {soon.length === 0 ? (
        <div className={paper ? "mt-4 rounded-xl border-2 border-dashed border-rim/50 px-4 py-5 text-center font-label text-[13px] leading-relaxed text-mud-soft" : "mt-3 rounded-xl bg-zinc-50 px-3 py-4 text-center text-xs text-ink-faint"}>
          Nothing booked yet. Set a prospect to <span className={paper ? "paper-tag bg-note" : "tag bg-yellow-100 text-yellow-800"}>Meeting booked</span> and add the link and time.
        </div>
      ) : (
        <ul className={paper ? "mt-4 space-y-3" : "mt-3 space-y-2"}>
          {soon.slice(0, limit ?? 100).map((m) => <MeetingItem key={m.rowId} m={m} paper={paper} />)}
        </ul>
      )}
      {stale.length > 0 && (
        <>
          <h3 className={paper ? "mt-6 font-label text-[13px] text-mud-faint" : "eyebrow mt-5"}>Past · still “Meeting booked”</h3>
          <ul className={paper ? "mt-3 space-y-3" : "mt-2 space-y-2"}>
            {stale.slice(-(limit ?? 100)).reverse().map((m) => <MeetingItem key={m.rowId} m={m} past paper={paper} />)}
          </ul>
        </>
      )}
    </div>
  );
}

function MeetingItem({ m, past, paper }: { m: Meeting; past?: boolean; paper?: boolean }) {
  const d = parseLocal(m.at);
  const today = d && isSameDay(d, new Date());
  return (
    <li
      className={
        paper
          ? cn("rounded-xl border-2 border-rim p-3.5 shadow-hard-sm transition", today ? "bg-lake-soft" : "bg-paper")
          : cn("rounded-xl border p-2.5 transition hover:border-brand-200", today ? "border-yellow-300 bg-yellow-50" : "border-line bg-white")
      }
    >
      <Link to={`/c/${m.campaignId}?row=${m.rowId}`} className="block">
        <div className={cn("truncate text-sm font-medium", paper && "text-[15px] font-extrabold")}>{m.title}</div>
        <div className={cn("truncate text-xs", paper ? "text-[13px] text-mud-faint" : "text-ink-faint")}>{[m.subtitle, m.campaignName].filter(Boolean).join(" · ")}</div>
      </Link>
      <div className={cn("mt-1.5 flex items-center gap-2", paper && "mt-2.5")}>
        <span className={cn("text-xs", paper && "text-[13px]", paper ? (past ? "text-mud-faint" : "text-mud-soft") : (past ? "text-ink-faint" : "text-ink-soft"))}>
          {formatDateTime(m.at)} · <span className={today ? (paper ? "font-bold text-lake-deep" : "font-semibold text-yellow-800") : ""}>{relative(m.at)}</span>
        </span>
        {m.url && !past && (
          <button
            className={
              paper
                ? "paper-btn paper-btn-primary ml-auto h-8 gap-1.5 rounded-lg px-3 text-[13px]"
                : "ml-auto inline-flex items-center gap-1 rounded-lg bg-brand-500 px-2 py-0.5 text-xs font-medium text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] hover:bg-brand-600"
            }
            onClick={() => fire(api.openUrl(m.url!))}
          >
            <Video size={paper ? 14 : 12} /> Join
          </button>
        )}
      </div>
    </li>
  );
}
