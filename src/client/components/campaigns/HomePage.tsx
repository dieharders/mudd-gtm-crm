import {
  ArrowRight, CalendarClock, Download, FileSpreadsheet, FolderOpen, MoreHorizontal, Plus, Sparkles, Trash2, Video, Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate } from "react-router-dom";
import { DEAD, MEETING_STAGE, type CampaignSummary, type Meeting } from "../../../shared/types";
import { api } from "../../lib/api";
import { useCampaignList } from "../../lib/campaignList";
import { cn } from "../../lib/cn";
import { formatDateTime, isSameDay, parseLocal, relative, timeAgo } from "../../lib/format";
import { tileFor, toneFor } from "../../lib/stages";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { MenuItem, Popover } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { useImport } from "./ImportFlow";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage({ onNewCampaign }: { onNewCampaign: () => void }) {
  const { campaigns, meetings, refresh } = useCampaignList();
  const [deleting, setDeleting] = useState<CampaignSummary | null>(null);
  const { startImport, busy } = useImport();

  const remove = async (c: CampaignSummary) => {
    await api.deleteCampaign(c.id);
    setDeleting(null);
    toast.success(`Deleted ${c.name}`);
    refresh();
  };

  const totals = (campaigns ?? []).reduce(
    (t, c) => ({ prospects: t.prospects + c.prospects, meetings: t.meetings + (c.byStatus[MEETING_STAGE] ?? 0), signed: t.signed + (c.byStatus.Signed ?? 0) }),
    { prospects: 0, meetings: 0, signed: 0 },
  );

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <div className="mb-7 flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <p className="eyebrow mb-1">{greeting()} 👋</p>
            <h1 className="text-[26px] font-bold tracking-tight">Your campaigns</h1>
          </div>
          <Button onClick={startImport} disabled={busy}>
            <FolderOpen size={16} /> {busy ? "Opening…" : "Import sheet"}
          </Button>
          <Button variant="primary" onClick={onNewCampaign}>
            <Plus size={16} /> New campaign
          </Button>
        </div>

        {campaigns === null ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-zinc-200/60" />)}
          </div>
        ) : campaigns.length === 0 ? (
          <Onboarding onImport={startImport} onCreate={onNewCampaign} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="min-w-0 space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <StatCard tile="bg-violet-100 text-violet-700" icon={<Sparkles size={16} />} value={totals.prospects} label="prospects" />
                <StatCard tile="bg-yellow-100 text-yellow-700" icon={<CalendarClock size={16} />} value={totals.meetings} label="meetings booked" />
                <StatCard tile="bg-emerald-100 text-emerald-700" icon={<Workflow size={16} />} value={totals.signed} label="signed" />
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {campaigns.map((c) => <CampaignCard key={c.id} c={c} onDelete={() => setDeleting(c)} />)}
              </div>
            </div>
            <aside>
              <MeetingsCard meetings={meetings} limit={6} />
            </aside>
          </div>
        )}
      </div>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        subtitle="The campaign, its rows and its templates are removed from Mudd. Spreadsheets you exported are not touched."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && remove(deleting)}><Trash2 size={15} /> Delete</Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">This can't be undone.</p>
      </Modal>
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
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <Tile className={tile}>{icon}</Tile>
      <div>
        <div className="text-xl leading-tight font-bold tabular-nums">{value}</div>
        <div className="text-xs text-ink-faint">{label}</div>
      </div>
    </div>
  );
}

/** First run: the three steps, drawn like Clay's flow diagram. */
function Onboarding({ onImport, onCreate }: { onImport: () => void; onCreate: () => void }) {
  const steps = [
    { tile: "bg-violet-100 text-violet-700", icon: <FileSpreadsheet size={18} />, title: "Bring your sheet", tags: [["Excel", "bg-violet-100 text-violet-800"], ["CSV", "bg-violet-100 text-violet-800"]], body: "Import a tracker, or start from a blank layout." },
    { tile: "bg-sky-100 text-sky-700", icon: <Workflow size={18} />, title: "Work the pipeline", tags: [["Status", "bg-sky-100 text-sky-800"], ["Meetings", "bg-sky-100 text-sky-800"], ["Intro msgs", "bg-sky-100 text-sky-800"]], body: "Edit like a spreadsheet, track every touch." },
    { tile: "bg-yellow-100 text-yellow-700", icon: <Download size={18} />, title: "Export it back", tags: [["Same formatting", "bg-yellow-100 text-yellow-800"], ["Formulas intact", "bg-yellow-100 text-yellow-800"]], body: "Your sheet, with every edit, exactly as it looked." },
  ];
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 via-violet-500 to-fuchsia-400 p-8 text-white shadow-lg">
      <div className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-28 left-10 h-72 w-72 rounded-full bg-yellow-300/20 blur-3xl" />
      <h2 className="relative text-2xl font-bold tracking-tight">Start with a spreadsheet you already have.</h2>
      <p className="relative mt-1 max-w-xl text-sm text-white/80">Everything stays on this computer. Drop a file anywhere on this window, or use the buttons below.</p>
      <div className="relative mt-7 grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
        {steps.map((s, i) => (
          <div key={s.title} className="contents">
            <div className="rounded-2xl bg-white p-4 text-ink shadow-md" style={{ animationDelay: `${i * 0.6}s` }}>
              <div className="flex items-center gap-2.5">
                <Tile className={s.tile}>{s.icon}</Tile>
                <span className="font-semibold">{s.title}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {s.tags.map(([t, c]) => <span key={t} className={cn("tag", c)}>{t}</span>)}
              </div>
              <p className="mt-2.5 text-xs text-ink-soft">{s.body}</p>
            </div>
            {i < steps.length - 1 && <ArrowRight className="hidden self-center text-white/80 md:block" size={20} />}
          </div>
        ))}
      </div>
      <div className="relative mt-7 flex gap-2">
        <button onClick={onImport} className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-brand-700 shadow-[inset_0_-2px_0_rgba(0,0,0,0.08)] transition hover:bg-brand-50 active:translate-y-px">
          <FolderOpen size={16} /> Import sheet
        </button>
        <button onClick={onCreate} className="inline-flex h-10 items-center gap-2 rounded-xl bg-white/15 px-4 text-sm font-semibold text-white ring-1 ring-white/40 transition hover:bg-white/25">
          <Plus size={16} /> Start from scratch
        </button>
      </div>
    </div>
  );
}

function CampaignCard({ c, onDelete }: { c: CampaignSummary; onDelete: () => void }) {
  const navigate = useNavigate();
  const stages = [...c.stages, DEAD];
  const total = c.prospects || 1;
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/c/${c.id}`)}
      onKeyDown={(e) => e.key === "Enter" && navigate(`/c/${c.id}`)}
      className="card group cursor-pointer p-5 transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[0_8px_30px_-12px_rgba(103,68,245,0.35)]"
    >
      <div className="flex items-start gap-3">
        <Tile size="lg" className={tileFor(c.id)}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold group-hover:text-brand-700">{c.name}</h3>
          <p className="truncate text-xs text-ink-faint">
            {c.sourceName ? <>From {c.sourceName}</> : "Created in Mudd"} · {timeAgo(c.updatedAt)}
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Popover align="right" trigger={({ toggle }) => (
            <button className="rounded-md p-1 text-ink-faint hover:bg-zinc-100 hover:text-ink" onClick={toggle} aria-label="Campaign menu">
              <MoreHorizontal size={18} />
            </button>
          )}>
            {(close) => <MenuItem danger icon={<Trash2 size={15} />} onClick={() => { close(); onDelete(); }}>Delete campaign</MenuItem>}
          </Popover>
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-5">
        <div><span className="text-2xl font-bold tabular-nums">{c.prospects}</span> <span className="text-xs text-ink-faint">prospects</span></div>
        <div className="text-xs text-ink-faint"><span className="font-semibold text-ink-soft tabular-nums">{c.screened}</span> screened out</div>
      </div>

      <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-zinc-100">
        {stages.map((s) => {
          const n = c.byStatus[s] ?? 0;
          if (!n) return null;
          return <div key={s} title={`${s}: ${n}`} className={cn("rounded-full", toneFor(s, c.stages).bar)} style={{ width: `${(n / total) * 100}%` }} />;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {stages.filter((s) => c.byStatus[s]).map((s) => (
          <span key={s} className={cn("tag", toneFor(s, c.stages).pill)}>
            {s} <span className="opacity-60 tabular-nums">{c.byStatus[s]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

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
    <div className="card p-4">
      <h2 className="flex items-center gap-2.5 text-sm font-semibold">
        <Tile size="sm" className="bg-yellow-100 text-yellow-700"><CalendarClock size={13} /></Tile> Upcoming meetings
      </h2>
      {soon.length === 0 ? (
        <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-4 text-center text-xs text-ink-faint">
          Nothing booked yet. Set a prospect to <span className="tag bg-yellow-100 text-yellow-800">Meeting booked</span> and add the link and time.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {soon.slice(0, limit ?? 100).map((m) => <MeetingItem key={m.rowId} m={m} />)}
        </ul>
      )}
      {stale.length > 0 && (
        <>
          <h3 className="eyebrow mt-5">Past · still “Meeting booked”</h3>
          <ul className="mt-2 space-y-2">
            {stale.slice(-(limit ?? 100)).reverse().map((m) => <MeetingItem key={m.rowId} m={m} past />)}
          </ul>
        </>
      )}
    </div>
  );
}

function MeetingItem({ m, past }: { m: Meeting; past?: boolean }) {
  const d = parseLocal(m.at);
  const today = d && isSameDay(d, new Date());
  return (
    <li className={cn("rounded-xl border p-2.5 transition hover:border-brand-200", today ? "border-yellow-300 bg-yellow-50" : "border-line bg-white")}>
      <Link to={`/c/${m.campaignId}?row=${m.rowId}`} className="block">
        <div className="truncate text-sm font-medium">{m.title}</div>
        <div className="truncate text-xs text-ink-faint">{[m.subtitle, m.campaignName].filter(Boolean).join(" · ")}</div>
      </Link>
      <div className="mt-1.5 flex items-center gap-2">
        <span className={cn("text-xs", past ? "text-ink-faint" : "text-ink-soft")}>
          {formatDateTime(m.at)} · <span className={today ? "font-semibold text-yellow-800" : ""}>{relative(m.at)}</span>
        </span>
        {m.url && !past && (
          <button
            className="ml-auto inline-flex items-center gap-1 rounded-lg bg-brand-500 px-2 py-0.5 text-xs font-medium text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] hover:bg-brand-600"
            onClick={() => api.openUrl(m.url!).catch((e) => toast.error(e.message))}
          >
            <Video size={12} /> Join
          </button>
        )}
      </div>
    </li>
  );
}
