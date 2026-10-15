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
import { campaignTileFor, toneFor } from "../../lib/stages";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { PageTitle } from "../ui/PageTitle";
import { MenuItem, Popover } from "../ui/Menu";
import { useImport } from "./ImportFlow";
import { RemoveCampaignDialog } from "./RemoveCampaignDialog";
import { fire } from "../../lib/fire";
import { toggleFidget } from "../../lib/fidget";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The home screen: a board with pinned cards. */
export function HomePage({ onNewCampaign }: { onNewCampaign: () => void }) {
  const { campaigns, meetings } = useCampaignList();
  const [removing, setRemoving] = useState<CampaignSummary | null>(null);
  const { startImport, busy } = useImport();

  const totals = (campaigns ?? []).reduce(
    (t, c) => ({ prospects: t.prospects + c.prospects, meetings: t.meetings + (c.byStatus[MEETING_STAGE] ?? 0), signed: t.signed + (c.byStatus.Signed ?? 0) }),
    { prospects: 0, meetings: 0, signed: 0 },
  );

  return (
    <div className="h-full overflow-y-auto bg-board scroll-thin">
      {/* The content rises in, not the page: a transform would pin the dialogs below to it while it runs. */}
      {/* Breakpoints are container queries: the page sits beside the sidebar, so the viewport overstates its width. */}
      <div className="@container mx-auto max-w-6xl px-6 py-8 motion-safe:animate-page-in md:px-10 md:py-10">
        <div className="mb-10 flex flex-wrap items-end gap-x-4 gap-y-8">
          <div className="mr-auto">
            <PageTitle kicker={`${greeting()} 👋`} onClick={toggleFidget}>Campaigns</PageTitle>
          </div>
          <div className="flex flex-wrap gap-4">
            <Button onClick={startImport} disabled={busy}>
              <FolderOpen size={18} /> {busy ? "Opening…" : "Import sheet"}
            </Button>
            <Button variant="primary" onClick={onNewCampaign}>
              <Plus size={18} /> New campaign
            </Button>
          </div>
        </div>

        {campaigns === null ? (
          <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-2">
            {[0, 1].map((i) => <div key={i} className="h-48 animate-pulse rounded-2xl border-2 border-dashed border-rim/50 bg-paper-deep" />)}
          </div>
        ) : campaigns.length === 0 ? (
          <Onboarding />
        ) : (
          <div className="grid grid-cols-1 gap-8 @4xl:grid-cols-[minmax(0,1fr)_21.25rem]">
            <div className="@container min-w-0 space-y-6">
              <div className="grid gap-5 @sm:grid-cols-3">
                <StatCard tile="bg-clay-soft" icon={<Sparkles size={18} />} value={totals.prospects} label="total prospects" />
                <StatCard tile="bg-note" icon={<CalendarClock size={18} />} value={totals.meetings} label="meetings booked" />
                <StatCard tile="bg-note-mint" icon={<Workflow size={18} />} value={totals.signed} label="signed" />
              </div>
              <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-2">
                {campaigns.map((c) => <CampaignCard key={c.id} c={c} onRemove={() => setRemoving(c)} />)}
              </div>
            </div>
            <aside>
              <MeetingsCard meetings={meetings} limit={6} />
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
    <div className="h-full overflow-y-auto bg-board scroll-thin">
      <div className="mx-auto max-w-3xl px-6 py-8 motion-safe:animate-page-in md:px-10 md:py-10">
        <PageTitle className="mb-8">Meetings</PageTitle>
        <MeetingsCard meetings={meetings} />
      </div>
    </div>
  );
}

function StatCard({ tile, icon, value, label }: { tile: string; icon: ReactNode; value: number; label: string }) {
  return (
    // Narrow cards stack the tile over the number rather than squeezing them side by side.
    <div className="card @container min-w-0 px-5 py-4">
      <div className="flex flex-col items-start gap-3 @[12rem]:flex-row @[12rem]:items-center @[12rem]:gap-4">
        <Tile size="lg" className={cn("border-2 border-rim text-mud", tile)}>{icon}</Tile>
        <div className="min-w-0">
          <div className="font-display text-[30px] leading-none font-bold tabular-nums">{value}</div>
          <div className="mt-1.5 font-label text-sm text-mud-soft">{label}</div>
        </div>
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
    <div className="card p-8 @3xl:p-10">
      <h2 className="font-display text-[28px] leading-tight font-bold tracking-tight">Start with a spreadsheet you already have.</h2>
      <p className="mt-2 max-w-xl text-[15px] text-mud-soft">Everything stays on this computer. Drop a file anywhere on this window, or use Import sheet above.</p>
      <div className="mt-10 grid grid-cols-1 items-stretch gap-8 @3xl:grid-cols-[1fr_auto_1fr_auto_1fr] @3xl:gap-5">
        {steps.map((s, i) => (
          <div key={s.title} className="contents">
            <div className={cn("note", s.note)}>
              <span className="pin" />
              <div className="flex items-center gap-3">
                <Tile size="lg" className="border-2 border-rim bg-paper text-mud">{s.icon}</Tile>
                <span className="font-display text-lg font-bold">{s.title}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {s.tags.map((t) => <span key={t} className="tag bg-paper/70 font-bold">{t}</span>)}
              </div>
              <p className="mt-3 font-label text-sm text-mud-soft">{s.body}</p>
            </div>
            {i < steps.length - 1 && <ArrowRight className="hidden self-center text-rim @3xl:block" size={26} strokeWidth={2.5} />}
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
      className="card group cursor-pointer p-6 transition hover:-translate-y-0.5 hover:shadow-hard-lg"
    >
      <div className="flex items-start gap-4">
        <Tile size="lg" className={cn("text-lg", campaignTileFor(c.id))}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-[21px] leading-tight font-bold group-hover:text-clay-deep">{c.name}</h3>
          <p className="mt-0.5 truncate text-[13px] text-mud-faint">
            {c.sourceName ? <>From {c.sourceName}</> : "Created in Mudd"} · {timeAgo(c.updatedAt)}
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Popover align="right" trigger={({ toggle }) => (
            <Button size="icon" variant="ghost" className="-mt-2 -mr-2" onClick={toggle} aria-label="Campaign menu"><MoreHorizontal size={20} /></Button>
          )}>
            {(close) => <MenuItem danger icon={<Trash2 size={15} />} onClick={() => { close(); onRemove(); }} hint="The file stays">Remove from App</MenuItem>}
          </Popover>
        </div>
      </div>

      <div className="mt-5">
        <span className="font-display text-[30px] font-bold tabular-nums">{c.prospects}</span> <span className="font-label text-sm text-mud-faint">prospects</span>
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
          <span key={s} className={cn("tag", toneFor(s, c.stages).pill)}>
            <span className="font-bold">{s}</span> <span className="tabular-nums">{c.byStatus[s]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Upcoming meetings across every campaign, and those still marked booked after their time. */
function MeetingsCard({ meetings, limit }: { meetings: Meeting[]; limit?: number }) {
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
    <div className="card p-5">
      <h2 className="flex items-center gap-3 font-display text-lg font-bold">
        <Tile className="border-2 border-rim bg-note text-mud"><CalendarClock size={16} /></Tile> Upcoming meetings
      </h2>
      {soon.length === 0 ? (
        <div className="mt-4 rounded-xl border-2 border-dashed border-rim/50 px-4 py-5 text-center font-label text-[13px] leading-relaxed text-mud-soft">
          Nothing booked yet. Set a prospect to <span className="tag bg-note">Meeting booked</span> and add the link and time.
        </div>
      ) : (
        <ul className="mt-6 space-y-5 px-1">
          {soon.slice(0, limit ?? 100).map((m, i) => <MeetingItem key={m.rowId} m={m} tilt={i} />)}
        </ul>
      )}
      {stale.length > 0 && (
        <>
          <h3 className="mt-6 font-label text-[13px] text-mud-faint">Past · still “Meeting booked”</h3>
          <ul className="mt-5 space-y-5 px-1">
            {stale.slice(-(limit ?? 100)).reverse().map((m, i) => <MeetingItem key={m.rowId} m={m} past tilt={i} />)}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One meeting, pinned to the card like a note; `tilt` alternates the lean down the list. Today's
 * is a yellow note, so the one to join today stands out from the blue ones still to come.
 */
function MeetingItem({ m, past, tilt = 0 }: { m: Meeting; past?: boolean; tilt?: number }) {
  const d = parseLocal(m.at);
  const today = !past && !!d && isSameDay(d, new Date());
  const ink = past ? "text-mud-faint" : today ? "text-mud-soft" : "text-lake-deep";
  return (
    <li className={cn("relative rounded-xl border-2 border-rim p-3.5 pt-4 shadow-hard transition", past ? "bg-paper" : today ? "bg-note" : "bg-lake-soft", tilt % 2 ? "rotate-[0.8deg]" : "-rotate-[0.8deg]")}>
      <span className="pin scale-75" />
      <Link to={`/c/${m.campaignId}?row=${m.rowId}`} className="block">
        <div className="truncate text-[15px] font-extrabold">{m.title}</div>
        <div className={cn("truncate text-[13px]", ink)}>{[m.subtitle, m.campaignName].filter(Boolean).join(" · ")}</div>
      </Link>
      <div className="mt-2.5 flex items-center gap-2">
        <span className={cn("text-[13px]", ink)}>
          {formatDateTime(m.at)} · <span className={past ? "" : today ? "font-bold text-clay-deep" : "font-bold"}>{relative(m.at)}</span>
        </span>
        {m.url && !past && (
          <Button size="xs" variant="primary" className="ml-auto" onClick={() => fire(api.openUrl(m.url!))}>
            <Video size={14} /> Join
          </Button>
        )}
      </div>
    </li>
  );
}
