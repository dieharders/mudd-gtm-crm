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
import { Button } from "./Button";
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
      <div className="text-[14px]">
        <div className="flex items-start gap-3">
          <p className="flex-1 font-bold">What's new in {notes.title}</p>
          <button onClick={() => toast.dismiss(id)} className="-mt-0.5 -mr-1 rounded-md p-0.5 text-paper/60 hover:bg-paper/15 hover:text-paper" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
        {notes.changes.length ? (
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-paper/85">
            {notes.changes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        ) : (
          <p className="mt-1.5 text-paper/85">No changes are listed for this version.</p>
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
      "group relative flex h-11 items-center justify-center gap-3 rounded-xl border-2 text-[15px] transition wide:justify-start wide:px-3",
      isActive ? "border-rim bg-paper font-extrabold text-mud shadow-hard-sm" : "border-transparent font-semibold text-mud-soft hover:bg-paper-deep hover:text-mud",
    );

  return (
    <aside className="flex w-16 shrink-0 flex-col border-r-2 border-rim bg-paper wide:w-64">
      <div className="flex h-16 items-center justify-center gap-2.5 px-2 wide:justify-start wide:px-4">
        <Logo size={32} />
        <span className="hidden font-display text-[23px] font-bold tracking-tight wide:inline">mudd</span>
      </div>

      <div className="flex flex-col gap-2.5 px-2.5 pb-4 wide:flex-row wide:px-3">
        <Button variant="primary" size="icon" onClick={onNewCampaign} className="wide:w-auto wide:flex-1 wide:px-3" title="New campaign" aria-label="New campaign">
          <Plus size={18} /> <span className="hidden wide:inline">New campaign</span>
        </Button>
        <Button size="icon" onClick={startImport} disabled={busy} title="Import a spreadsheet" aria-label="Import a spreadsheet">
          <FolderOpen size={18} />
        </Button>
      </div>

      <nav className="space-y-1.5 px-2.5 wide:px-3">
        <NavLink to="/" end className={item} title="Home">
          <Home size={18} /> <span className="hidden wide:inline">Home</span>
        </NavLink>
        <NavLink to="/meetings" className={item} title="Meetings">
          <CalendarClock size={18} /> <span className="hidden wide:inline">Meetings</span>
          {upcoming > 0 && (
            <span className="absolute -top-1 -right-1 rounded-full border border-rim bg-clay px-1.5 font-label text-[11px] leading-5 font-bold text-paper tabular-nums wide:static wide:ml-auto wide:px-2 wide:text-[12px]">
              {upcoming}
            </span>
          )}
        </NavLink>
      </nav>

      <div className="mt-7 hidden px-6 pb-2 wide:block">
        <span className="font-label text-[13px] font-bold text-mud-faint">Campaigns</span>
      </div>
      <nav className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-3 scroll-thin wide:mt-0 wide:px-3">
        {campaigns?.map((c) => (
          <NavLink key={c.id} to={`/c/${c.id}`} className={(s) => cn(item(s), "h-14")} title={c.name}>
            <Tile size="md" className={cn("text-[13px]", paperTileFor(c.id))}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
            <span className="hidden min-w-0 flex-1 truncate wide:inline">{c.name}</span>
            <span className="hidden font-label text-[13px] text-mud-faint tabular-nums wide:inline">{c.prospects}</span>
          </NavLink>
        ))}
        {campaigns && campaigns.length === 0 && <p className="hidden px-3 py-1 font-label text-[13px] text-mud-faint wide:block">No campaigns yet</p>}
      </nav>

      <UpdateNotice info={update} />

      <div className="px-2.5 pb-3 wide:px-3">
        <button
          onClick={() => ai.setOpen(true)}
          title={`${aiLabel} · ${aiState}`}
          className="relative flex w-full items-center justify-center gap-3 rounded-xl border-2 border-rim bg-paper p-1.5 text-left shadow-hard-sm transition hover:bg-paper-deep wide:justify-start wide:px-3 wide:py-2.5"
        >
          {ai.settings?.provider ? (
            <ProviderMark id={ai.settings.provider} className="h-8 w-8" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-clay-soft text-clay-deep"><Sparkles size={16} /></span>
          )}
          <span className="hidden min-w-0 flex-1 wide:block">
            <span className="block truncate text-[15px] font-extrabold">{aiLabel}</span>
            <span className="block truncate font-label text-[11px] text-mud-faint">{aiState}</span>
          </span>
          <span className={cn("absolute top-1 right-1 h-3 w-3 shrink-0 rounded-full border-2 border-rim wide:static", aiReady ? "bg-emerald-400" : "bg-note")} />
        </button>
      </div>

      <div className="border-t-2 border-rim px-2.5 py-3 font-label text-[13px] text-mud-faint wide:px-4 wide:py-3.5">
        {update && (
          <button
            onClick={() => void showReleaseNotes()}
            className="flex w-full items-center justify-center gap-2 transition hover:text-mud wide:justify-start"
            title={`What's new in v${update.current}`}
          >
            <Gift size={14} /> <span className="hidden wide:inline">What's new in <span className="tabular-nums">v{update.current}</span></span>
          </button>
        )}
      </div>
    </aside>
  );
}
