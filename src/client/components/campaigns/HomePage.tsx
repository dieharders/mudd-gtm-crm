import { CalendarClock, FileSpreadsheet, FolderOpen, MoreHorizontal, Plus, Trash2, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate } from "react-router-dom";
import { DEAD, MEETING_STAGE, type CampaignSummary, type Meeting } from "../../../shared/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatDateTime, isSameDay, parseLocal, relative, timeAgo } from "../../lib/format";
import { toneFor } from "../../lib/stages";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { useImport } from "./ImportFlow";
import { NewCampaignDialog } from "./NewCampaignDialog";

export function HomePage() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CampaignSummary | null>(null);
  const { startImport, busy } = useImport();

  const load = useCallback(() => {
    api.campaigns().then(setCampaigns).catch((e) => toast.error(e.message));
    api.meetings().then(setMeetings).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const remove = async (c: CampaignSummary) => {
    await api.deleteCampaign(c.id);
    setDeleting(null);
    toast.success(`Deleted ${c.name}`);
    load();
  };

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-8 lg:flex-row">
        <section className="min-w-0 flex-1">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
              <p className="text-sm text-ink-soft">Import a sheet or start one from scratch. Export any time; your formatting comes back intact.</p>
            </div>
            <Button onClick={startImport} disabled={busy}>
              <FolderOpen size={16} /> {busy ? "Opening…" : "Import sheet"}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> New campaign
            </Button>
          </div>

          {campaigns === null ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-stone-200/50" />)}
            </div>
          ) : campaigns.length === 0 ? (
            <EmptyState onImport={startImport} onCreate={() => setCreating(true)} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {campaigns.map((c) => <CampaignCard key={c.id} c={c} onDelete={() => setDeleting(c)} />)}
            </div>
          )}
        </section>

        <aside className="w-full shrink-0 lg:w-80">
          <UpcomingMeetings meetings={meetings} />
        </aside>
      </div>

      <NewCampaignDialog open={creating} onClose={() => setCreating(false)} campaigns={campaigns ?? []} />
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

function EmptyState({ onImport, onCreate }: { onImport: () => void; onCreate: () => void }) {
  return (
    <div className="rounded-3xl border border-dashed border-line-strong bg-panel/60 px-8 py-14 text-center">
      <FileSpreadsheet size={36} className="mx-auto text-clay-400" />
      <h2 className="mt-3 text-lg font-semibold">No campaigns yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
        Import your tracker (.xlsx or .csv) — or drop it anywhere on this window — and edit it here. Everything stays on this computer.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button onClick={onImport}><FolderOpen size={16} /> Import sheet</Button>
        <Button variant="primary" onClick={onCreate}><Plus size={16} /> New campaign</Button>
      </div>
    </div>
  );
}

function CampaignCard({ c, onDelete }: { c: CampaignSummary; onDelete: () => void }) {
  const navigate = useNavigate();
  const stages = [...c.stages, DEAD];
  const total = c.prospects || 1;
  const active = c.prospects - (c.byStatus[DEAD] ?? 0) - (c.byStatus[c.stages[0] ?? ""] ?? 0) - (c.byStatus["Not set"] ?? 0);
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/c/${c.id}`)}
      onKeyDown={(e) => e.key === "Enter" && navigate(`/c/${c.id}`)}
      className="group cursor-pointer rounded-2xl border border-line bg-panel p-5 shadow-xs transition hover:-translate-y-0.5 hover:border-clay-200 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold group-hover:text-clay-700">{c.name}</h3>
          <p className="truncate text-xs text-ink-faint">
            {c.sourceName ? <>From {c.sourceName}</> : "Created in Mudd"} · edited {timeAgo(c.updatedAt)}
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Popover align="right" trigger={({ toggle }) => (
            <button className="rounded-md p-1 text-ink-faint hover:bg-stone-100 hover:text-ink" onClick={toggle} aria-label="Campaign menu">
              <MoreHorizontal size={18} />
            </button>
          )}>
            {(close) => <MenuItem danger icon={<Trash2 size={15} />} onClick={() => { close(); onDelete(); }}>Delete campaign</MenuItem>}
          </Popover>
        </div>
      </div>

      <div className="mt-4 flex items-end gap-6">
        <Stat value={c.prospects} label="prospects" />
        <Stat value={Math.max(0, active)} label="in motion" />
        <Stat value={c.byStatus[MEETING_STAGE] ?? 0} label="meetings" />
        <Stat value={c.screened} label="screened out" muted />
      </div>

      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-stone-100">
        {stages.map((s) => {
          const n = c.byStatus[s] ?? 0;
          if (!n) return null;
          return <div key={s} title={`${s}: ${n}`} className={toneFor(s, c.stages).bar} style={{ width: `${(n / total) * 100}%` }} />;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {stages.filter((s) => c.byStatus[s]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 text-[11px] text-ink-soft">
            <span className={cn("h-1.5 w-1.5 rounded-full", toneFor(s, c.stages).dot)} /> {s} {c.byStatus[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

const Stat = ({ value, label, muted }: { value: number; label: string; muted?: boolean }) => (
  <div>
    <div className={cn("text-xl font-semibold tabular-nums", muted && "text-ink-faint")}>{value}</div>
    <div className="text-[11px] text-ink-faint">{label}</div>
  </div>
);

function UpcomingMeetings({ meetings }: { meetings: Meeting[] }) {
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
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-xs">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <CalendarClock size={16} className="text-clay-500" /> Upcoming meetings
      </h2>
      {soon.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">None booked. Set a prospect to <em>Meeting booked</em> and add the link and time.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {soon.slice(0, 12).map((m) => <MeetingItem key={m.rowId} m={m} />)}
        </ul>
      )}
      {stale.length > 0 && (
        <>
          <h3 className="mt-5 text-xs font-semibold text-ink-soft">Past — still “Meeting booked”</h3>
          <ul className="mt-2 space-y-2">
            {stale.slice(-6).reverse().map((m) => <MeetingItem key={m.rowId} m={m} past />)}
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
    <li className={cn("rounded-xl border p-2.5", today ? "border-amber-200 bg-amber-50/60" : "border-line")}>
      <Link to={`/c/${m.campaignId}?row=${m.rowId}`} className="block hover:text-clay-700">
        <div className="truncate text-sm font-medium">{m.title}</div>
        <div className="truncate text-xs text-ink-faint">{[m.subtitle, m.campaignName].filter(Boolean).join(" · ")}</div>
      </Link>
      <div className="mt-1.5 flex items-center gap-2">
        <span className={cn("text-xs", past ? "text-ink-faint" : "text-ink-soft")}>
          {formatDateTime(m.at)} · <span className={today ? "font-medium text-amber-700" : ""}>{relative(m.at)}</span>
        </span>
        {m.url && !past && (
          <button
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-clay-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-clay-700"
            onClick={() => api.openUrl(m.url!).catch((e) => toast.error(e.message))}
          >
            <Video size={12} /> Join
          </button>
        )}
      </div>
    </li>
  );
}
