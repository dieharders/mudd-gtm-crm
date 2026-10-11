/**
 * Discover prospects: the panel of a Discovery campaign. Its left rail goes the way the setup
 * goes: Thesis → Find → Inbox → Recent runs. Candidates wait in the inbox until accepted or
 * dismissed; nothing reaches the sheet on its own.
 */
import { ArchiveRestore, Inbox, Radar, ScrollText, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PROVIDERS } from "../../../shared/ai";
import { isLiveStatus } from "../../../shared/sourcing";
import { answeredCount, THESIS_QUESTIONS } from "../../../shared/thesis";
import type { CampaignState } from "../../hooks/useCampaign";
import type { DiscoveryState } from "../../hooks/useDiscovery";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { CandidateCard } from "./CandidateCard";
import { DiscoveryProgress } from "./DiscoveryProgress";
import { FindBox } from "./FindBox";
import { ThesisEditor } from "./ThesisEditor";
import { fire } from "../../lib/fire";

export type DiscoverSection = "thesis" | "find" | "inbox";
type Selection = { kind: DiscoverSection } | { kind: "run"; id: string };

export function DiscoverPanel({ state, enrich, discovery, initial = "thesis", onClose }: {
  state: CampaignState;
  enrich: EnrichmentState;
  discovery: DiscoveryState;
  initial?: DiscoverSection;
  onClose: () => void;
}) {
  const ai = useAi();
  const { status, ready } = useActiveProvider();
  const [sel, setSel] = useState<Selection>({ kind: initial });
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, select") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { thesis, inbox, dismissed, runs } = discovery;
  const firstRun = !runs.some((r) => r.kind === "find");
  const findRun = useMemo(() => runs.find((r) => r.kind === "find" && isLiveStatus(r.status)) ?? runs.find((r) => r.kind === "find") ?? null, [runs]);
  const shownRun = sel.kind === "run" ? runs.find((r) => r.id === sel.id) ?? null : null;
  const typeOptions = useMemo(() => {
    const cs = state.campaign?.schema.contacts;
    return cs?.columns.find((c) => c.key === cs.typeKey)?.options ?? [];
  }, [state.campaign]);
  const highFit = inbox.filter((c) => c.status === "ready" && c.fit === "High");

  const withBusy = async (ids: string[], work: () => Promise<unknown>) => {
    setBusy((b) => new Set([...b, ...ids]));
    try {
      await work();
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };
  const mapAgain = (ids: string[]) => fire(discovery.start({ kind: "map", candidateIds: ids, concurrency: 2 }));

  const rail = (kind: DiscoverSection, icon: React.ReactNode, label: string, hint: string, count?: number) => (
    <button onClick={() => setSel({ kind })}
      className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", sel.kind === kind ? "bg-brand-50 text-brand-800" : "hover:bg-zinc-100")}>
      <span className={cn("shrink-0", sel.kind === kind ? "text-brand-600" : "text-ink-faint")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">{label}{count !== undefined && count > 0 && <span className="rounded-md bg-brand-100 px-1.5 text-[11px] font-semibold text-brand-700 tabular-nums">{count}</span>}</span>
        <span className="block truncate text-[11px] text-ink-faint">{hint}</span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-zinc-900/20 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-full w-[min(1040px,100%)] flex-col bg-canvas shadow-2xl animate-slide-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line bg-panel px-5 py-3">
          <Tile className="bg-gradient-to-br from-emerald-400 to-brand-400 text-white"><Radar size={16} /></Tile>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Discover prospects</h2>
            <p className="text-xs text-ink-soft">Companies that fit your ideal customer, with who to talk to at each. You review every one before it joins the list.</p>
          </div>
          <button onClick={() => ai.setOpen(true)} className={cn("tag", ready ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-800")}>
            {ready ? "●" : <TriangleAlert size={11} />} {ai.settings?.provider ? PROVIDERS[ai.settings.provider].label : "No AI provider chosen"}{status?.auth.plan ? ` · ${status.auth.plan}` : ""}
          </button>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close discover"><X size={16} /></Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 space-y-5 overflow-y-auto border-r border-line bg-panel p-3 scroll-thin">
            <div className="space-y-0.5">
              {rail("thesis", <ScrollText size={16} />, "Thesis", thesis ? `${answeredCount(thesis)} of ${THESIS_QUESTIONS.length} answered` : "")}
              {rail("find", <Radar size={16} />, "Find", findRun && isLiveStatus(findRun.status) ? "Running…" : firstRun ? "Not run yet" : `Last run ${timeAgo(findRun!.startedAt)}`)}
              {rail("inbox", <Inbox size={16} />, "Inbox", inbox.length ? `${inbox.length} to review` : "Nothing waiting", inbox.length)}
            </div>
            {runs.length > 0 && (
              <div>
                <p className="eyebrow mb-1.5 px-1">Recent runs</p>
                <ul className="space-y-0.5">
                  {runs.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      <button onClick={() => setSel({ kind: "run", id: r.id })} className={cn("w-full rounded-lg px-2.5 py-1.5 text-left", sel.kind === "run" && sel.id === r.id ? "bg-brand-50" : "hover:bg-zinc-100")}>
                        <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                          {isLiveStatus(r.status) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />}
                          {r.kind === "thesis" ? "Fill thesis blanks" : r.kind === "map" ? "Map again" : `Find ${r.target}`}
                        </span>
                        <span className="block truncate text-[11px] text-ink-faint">{r.status}{r.kind === "find" ? ` · ${r.ready} ready` : ""} · {timeAgo(r.startedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>

          <div className="min-w-0 flex-1 overflow-y-auto p-5 scroll-thin">
            {sel.kind === "run" && shownRun ? (
              <DiscoveryProgress run={shownRun} candidates={discovery.candidates} onAction={(a) => fire(discovery.action(shownRun.id, a))} />
            ) : sel.kind === "thesis" ? (
              <ThesisEditor discovery={discovery} ready={ready} onSetup={() => ai.setOpen(true)} onNext={firstRun ? () => setSel({ kind: "find" }) : undefined} />
            ) : sel.kind === "find" ? (
              <div className="space-y-5">
                <FindBox discovery={discovery} recipes={enrich.recipes} ready={ready} onSetup={() => ai.setOpen(true)} />
                {findRun && <DiscoveryProgress run={findRun} candidates={discovery.candidates} onAction={(a) => fire(discovery.action(findRun.id, a))} />}
                {findRun && findRun.ready > 0 && inbox.length > 0 && (
                  <div className="text-right">
                    <Button variant="subtle" onClick={() => setSel({ kind: "inbox" })}><Inbox size={14} /> Review {inbox.length} in the inbox</Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {inbox.length === 0 ? (
                  <div className="mx-auto mt-16 max-w-md text-center">
                    <Tile size="lg" className="mx-auto bg-brand-100 text-brand-700"><Inbox size={18} /></Tile>
                    <h3 className="mt-3 text-lg font-semibold">Nothing to review</h3>
                    <p className="mt-1 text-sm text-ink-soft">{firstRun ? "Run Find to look for companies that fit your thesis." : "Every company found has been accepted or dismissed. Run Find again for more."}</p>
                    <Button className="mt-4" variant="primary" onClick={() => setSel({ kind: "find" })}><Radar size={14} /> {firstRun ? "Find prospects" : "Find more"}</Button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm text-ink-soft"><b className="text-ink">{inbox.length}</b> compan{inbox.length === 1 ? "y" : "ies"} to review, best fit first.</p>
                      {highFit.length > 1 && (
                        <Button size="sm" variant="subtle" className="ml-auto" disabled={highFit.some((c) => busy.has(c.id))}
                          onClick={() => fire(withBusy(highFit.map((c) => c.id), () => discovery.accept(highFit.map((c) => ({ id: c.id, contactIds: c.contacts.map((p) => p.id) })))))}>
                          Accept all high fit ({highFit.length})
                        </Button>
                      )}
                    </div>
                    {inbox.map((c) => (
                      <CandidateCard key={c.id} c={c} typeOptions={typeOptions} busy={busy.has(c.id)}
                        onAccept={(contactIds) => fire(withBusy([c.id], () => discovery.accept([{ id: c.id, contactIds }])))}
                        onDismiss={(reason) => fire(withBusy([c.id], () => discovery.dismiss([c.id], reason.trim() || null)))}
                        onMapAgain={() => mapAgain([c.id])} />
                    ))}
                  </>
                )}
                {dismissed.length > 0 && <Dismissed list={dismissed} onRestore={(ids) => fire(discovery.restore(ids))} />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Dismissed({ list, onRestore }: { list: DiscoveryState["dismissed"]; onRestore: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line pt-3">
      <button className="text-xs font-medium text-ink-faint hover:text-ink" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {list.length} dismissed
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {list.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs">
              <span className="font-medium">{c.company}</span>
              <span className="min-w-0 flex-1 truncate text-ink-faint">{c.dismissReason ?? "No reason given"}</span>
              <Button size="sm" variant="ghost" onClick={() => onRestore([c.id])}><ArchiveRestore size={12} /> Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
