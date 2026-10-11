/** The left rail: brand, primary actions, and every campaign one click away. */
import { CalendarClock, FolderOpen, Gift, Home, Plus, Sparkles } from "lucide-react";
import { PROVIDERS } from "../../../shared/ai";
import { api } from "../../lib/api";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { NavLink } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useCampaignList } from "../../lib/campaignList";
import { todayString } from "../../lib/format";
import { tileFor } from "../../lib/stages";
import { ProviderMark } from "../ai/BrandMarks";
import { useImport } from "../campaigns/ImportFlow";
import { Logo, Tile } from "./Logo";
import { UpdateNotice, useUpdateCheck } from "./UpdateNotice";

export function Sidebar({ onNewCampaign }: { onNewCampaign: () => void }) {
  const { campaigns, meetings } = useCampaignList();
  const { startImport, busy } = useImport();
  const ai = useAi();
  const { status: aiStatus, ready: aiReady } = useActiveProvider();
  const upcoming = meetings.filter((m) => m.at.slice(0, 10) >= todayString()).length;
  const update = useUpdateCheck();

  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      "group flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] transition",
      isActive ? "bg-white font-medium text-ink shadow-[0_1px_2px_rgba(23,22,29,0.08)]" : "text-ink-soft hover:bg-zinc-900/5 hover:text-ink",
    );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-4">
        <Logo />
        <span className="text-[16px] font-bold tracking-tight">mudd</span>
      </div>

      <div className="flex gap-1.5 px-3 pb-3">
        <button
          onClick={onNewCampaign}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-500 text-[13px] font-medium text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)] transition hover:bg-brand-600 active:translate-y-px"
        >
          <Plus size={15} /> New campaign
        </button>
        <button
          onClick={startImport}
          disabled={busy}
          title="Import a spreadsheet"
          className="flex h-8 w-9 items-center justify-center rounded-lg border border-line-strong bg-white text-ink-soft shadow-[0_1px_0_rgba(23,22,29,0.06)] transition hover:text-ink active:translate-y-px"
        >
          <FolderOpen size={15} />
        </button>
      </div>

      <nav className="space-y-0.5 px-3">
        <NavLink to="/" end className={item}>
          <Home size={15} className="text-ink-faint group-hover:text-ink" /> Home
        </NavLink>
        <NavLink to="/meetings" className={item}>
          <CalendarClock size={15} className="text-ink-faint group-hover:text-ink" /> Meetings
          {upcoming > 0 && <span className="ml-auto rounded-full bg-yellow-200 px-1.5 text-[11px] font-semibold text-yellow-900">{upcoming}</span>}
        </NavLink>
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1.5">
        <span className="eyebrow">Campaigns</span>
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 scroll-thin">
        {campaigns?.map((c) => (
          <NavLink key={c.id} to={`/c/${c.id}`} className={item} title={c.name}>
            <Tile size="sm" className={tileFor(c.id)}>{c.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-[11px] text-ink-faint tabular-nums">{c.prospects}</span>
          </NavLink>
        ))}
        {campaigns && campaigns.length === 0 && <p className="px-2 py-1 text-xs text-ink-faint">No campaigns yet</p>}
      </nav>

      <UpdateNotice info={update} />

      <div className="px-3 pb-2">
        <button
          onClick={() => ai.setOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-white px-2.5 py-2 text-left shadow-[0_1px_0_rgba(23,22,29,0.05)] transition hover:border-brand-200"
        >
          {ai.settings?.provider ? (
            <ProviderMark id={ai.settings.provider} className="h-7 w-7" />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700"><Sparkles size={14} /></span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">{ai.settings?.provider ? PROVIDERS[ai.settings.provider].label : "AI"}</span>
            <span className="block truncate text-[11px] text-ink-faint">
              {ai.settings && !ai.settings.provider ? "No AI provider chosen" : ai.loading && !aiStatus ? "Checking…" : aiReady ? `${aiStatus?.auth.plan ? `${aiStatus.auth.plan[0]!.toUpperCase()}${aiStatus.auth.plan.slice(1)} · ` : ""}ready` : !aiStatus?.installed ? "Not set up" : "Sign in needed"}
            </span>
          </span>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", aiReady ? "bg-emerald-500" : "bg-yellow-400")} />
        </button>
      </div>

      <div className="border-t border-line px-4 py-3 text-[11px] text-ink-faint">
        {update && (
          <button onClick={() => void api.openUrl(update.notesUrl).catch(() => {})} className="flex items-center gap-2 transition hover:text-ink">
            <Gift size={12} /> What's new in <span className="tabular-nums">v{update.current}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
