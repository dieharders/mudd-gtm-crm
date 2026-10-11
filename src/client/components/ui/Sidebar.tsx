/** The left rail: brand, primary actions, and every campaign one click away. Folds to icons below `wide`. */
import { CalendarClock, FolderOpen, Gift, Home, Plus, Sparkles, X } from "lucide-react";
import { PROVIDERS } from "../../../shared/ai";
import { api } from "../../lib/api";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import toast from "react-hot-toast";
import { NavLink } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useCampaignList } from "../../lib/campaignList";
import { todayString } from "../../lib/format";
import { paperTileFor } from "../../lib/paper";
import { ProviderMark } from "../ai/BrandMarks";
import { useImport } from "../campaigns/ImportFlow";
import { Logo, Tile } from "./Logo";
import { UpdateNotice, useUpdateCheck } from "./UpdateNotice";

/**
 * What changed in this version, from its GitHub release, in a toast rather than a browser tab.
 * One toast id, so clicking again replaces it rather than stacking another.
 */
async function showReleaseNotes() {
  const id = toast.loading("Loading what's new…", { id: "release-notes" });
  try {
    const notes = await api.releaseNotes();
    toast(
      <div className="text-[13px]">
        <div className="flex items-start gap-3">
          <p className="flex-1 font-semibold">What's new in {notes.title}</p>
          <button onClick={() => toast.dismiss(id)} className="-mt-0.5 -mr-1 rounded-md p-0.5 text-ink-faint hover:bg-zinc-900/5 hover:text-ink" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
        {notes.changes.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-soft">
            {notes.changes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-ink-soft">No changes are listed for this version.</p>
        )}
      </div>,
      { id, duration: 30_000 },
    );
  } catch (err) {
    toast.error((err as Error).message, { id });
  }
}

export function Sidebar({ onNewCampaign }: { onNewCampaign: () => void }) {
  const { campaigns, meetings } = useCampaignList();
  const { startImport, busy } = useImport();
  const ai = useAi();
  const { status: aiStatus, ready: aiReady } = useActiveProvider();
  const upcoming = meetings.filter((m) => m.at.slice(0, 10) >= todayString()).length;
  const update = useUpdateCheck();

  const aiLabel = ai.settings?.provider ? PROVIDERS[ai.settings.provider].label : "AI";
  const aiState =
    ai.settings && !ai.settings.provider ? "No AI provider chosen"
    : ai.loading && !aiStatus ? "Checking…"
    : aiReady ? `${aiStatus?.auth.plan ? `${aiStatus.auth.plan[0]!.toUpperCase()}${aiStatus.auth.plan.slice(1)} · ` : ""}ready`
    : !aiStatus?.installed ? "Not set up"
    : "Sign in needed";

  // Icon-only and centred in the rail; label, count and a left-aligned row when wide.
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      "group relative flex h-9 items-center justify-center gap-2.5 rounded-xl border-2 text-[13px] font-bold transition wide:justify-start wide:px-2.5",
      isActive ? "border-mud bg-paper text-mud shadow-hard-sm" : "border-transparent text-mud-soft hover:bg-paper-deep hover:text-mud",
    );

  return (
    <aside className="paper flex w-14 shrink-0 flex-col border-r-2 border-mud bg-paper wide:w-60">
      <div className="flex h-14 items-center justify-center gap-2 px-2 wide:justify-start wide:px-4">
        <Logo size={28} />
        <span className="hidden font-display text-[19px] font-bold tracking-tight wide:inline">mudd</span>
      </div>

      <div className="flex flex-col gap-2 px-2 pb-3 wide:flex-row wide:px-3">
        <button onClick={onNewCampaign} className="paper-btn paper-btn-primary paper-btn-icon wide:w-auto wide:flex-1 wide:px-3" title="New campaign" aria-label="New campaign">
          <Plus size={16} /> <span className="hidden wide:inline">New campaign</span>
        </button>
        <button onClick={startImport} disabled={busy} title="Import a spreadsheet" aria-label="Import a spreadsheet" className="paper-btn paper-btn-icon">
          <FolderOpen size={16} />
        </button>
      </div>

      <nav className="space-y-1 px-2 wide:px-3">
        <NavLink to="/" end className={item} title="Home">
          <Home size={16} /> <span className="hidden wide:inline">Home</span>
        </NavLink>
        <NavLink to="/meetings" className={item} title="Meetings">
          <CalendarClock size={16} /> <span className="hidden wide:inline">Meetings</span>
          {upcoming > 0 && (
            <span className="absolute -top-1 -right-1 rounded-full border border-mud bg-clay px-1 font-label text-[10px] leading-4 text-paper tabular-nums wide:static wide:ml-auto wide:px-1.5">
              {upcoming}
            </span>
          )}
        </NavLink>
      </nav>

      <div className="mt-5 hidden px-5 pb-1.5 wide:block">
        <span className="font-label text-xs text-mud-faint">Campaigns</span>
      </div>
      <nav className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3 scroll-thin wide:mt-0 wide:px-3">
        {campaigns?.map((c) => (
          <NavLink key={c.id} to={`/c/${c.id}`} className={item} title={c.name}>
            <Tile size="sm" className={paperTileFor(c.id)}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
            <span className="hidden min-w-0 flex-1 truncate wide:inline">{c.name}</span>
            <span className="hidden font-label text-[11px] text-mud-faint tabular-nums wide:inline">{c.prospects}</span>
          </NavLink>
        ))}
        {campaigns && campaigns.length === 0 && <p className="hidden px-2 py-1 font-label text-xs text-mud-faint wide:block">No campaigns yet</p>}
      </nav>

      <div className="hidden wide:block">
        <UpdateNotice info={update} />
      </div>

      <div className="px-2 pb-2 wide:px-3">
        <button
          onClick={() => ai.setOpen(true)}
          title={`${aiLabel} · ${aiState}`}
          className="relative flex w-full items-center justify-center gap-2.5 rounded-xl border-2 border-mud bg-paper p-1 text-left shadow-hard-sm transition hover:bg-paper-deep wide:justify-start wide:px-2.5 wide:py-2"
        >
          {ai.settings?.provider ? (
            <ProviderMark id={ai.settings.provider} className="h-7 w-7" />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-clay-soft text-clay-deep"><Sparkles size={14} /></span>
          )}
          <span className="hidden min-w-0 flex-1 wide:block">
            <span className="block truncate text-[12.5px] font-bold">{aiLabel}</span>
            <span className="block truncate font-label text-[11px] text-mud-faint">{aiState}</span>
          </span>
          <span className={cn("absolute top-0.5 right-0.5 h-2.5 w-2.5 shrink-0 rounded-full border border-mud wide:static", aiReady ? "bg-emerald-400" : "bg-note")} />
        </button>
      </div>

      <div className="hidden border-t-2 border-mud px-4 py-3 font-label text-[12px] text-mud-faint wide:block">
        {update && (
          <button onClick={() => void showReleaseNotes()} className="flex items-center gap-2 transition hover:text-mud">
            <Gift size={12} /> What's new in <span className="tabular-nums">v{update.current}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
