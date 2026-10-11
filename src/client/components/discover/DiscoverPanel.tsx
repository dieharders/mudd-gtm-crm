/**
 * Discover prospects: the panel of a Discovery campaign. Its left rail goes the way the setup
 * goes: Thesis → Find → Inbox → Recent runs. Candidates wait in the inbox until accepted or
 * dismissed; nothing reaches the sheet on its own.
 */
import { ArchiveRestore, Inbox, Radar, ScrollText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isLiveStatus, PROVIDERS } from "../../../shared/ai";
import { answeredCount, THESIS_QUESTIONS } from "../../../shared/thesis";
import type { CampaignState } from "../../hooks/useCampaign";
import type { DiscoveryState } from "../../hooks/useDiscovery";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { Button } from "../ui/Button";
import { AiStatusTag, Panel, railItem } from "../ui/Panel";
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
    <button onClick={() => setSel({ kind })} className={railItem(sel.kind === kind)}>
      <span className={cn("shrink-0", sel.kind === kind ? "text-clay-deep" : "text-mud-faint")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[15px] font-extrabold">{label}{count !== undefined && count > 0 && <span className="rounded-md border border-rim/60 bg-clay-soft px-1.5 font-label text-[12px] font-bold text-clay-deep tabular-nums">{count}</span>}</span>
        <span className="block truncate font-label text-[12px] font-normal text-mud-faint">{hint}</span>
      </span>
    </button>
  );

  return (
    <Panel
      onClose={onClose}
      closeLabel="Close discover"
      icon={<Tile size="lg" className="border-2 border-rim bg-note-mint text-mud"><Radar size={20} /></Tile>}
      title="Discover prospects"
      subtitle="Companies that fit your ideal customer, with who to talk to at each. You review every one before it joins the list."
      actions={<AiStatusTag ready={ready} onClick={() => ai.setOpen(true)} label={`${ai.settings?.provider ? PROVIDERS[ai.settings.provider].label : "No AI provider chosen"}${status?.auth.plan ? ` · ${status.auth.plan}` : ""}`} />}
    >
        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 space-y-5 overflow-y-auto border-r-2 border-rim/40 bg-paper-deep/40 p-3 scroll-thin">
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
                      <button onClick={() => setSel({ kind: "run", id: r.id })} className={cn("w-full rounded-lg px-2.5 py-1.5 text-left", sel.kind === "run" && sel.id === r.id ? "bg-clay-soft/60" : "hover:bg-paper-deep")}>
                        <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                          {isLiveStatus(r.status) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-clay" />}
                          {r.kind === "thesis" ? "Fill thesis blanks" : r.kind === "map" ? "Map again" : `Find ${r.target}`}
                        </span>
                        <span className="block truncate text-[11px] text-mud-faint">{r.status}{r.kind === "find" ? ` · ${r.ready} ready` : ""} · {timeAgo(r.startedAt)}</span>
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
                    <Tile size="lg" className="mx-auto bg-clay-soft text-clay-deep"><Inbox size={18} /></Tile>
                    <h3 className="mt-3 text-lg font-semibold">Nothing to review</h3>
                    <p className="mt-1 text-sm text-mud-soft">{firstRun ? "Run Find to look for companies that fit your thesis." : "Every company found has been accepted or dismissed. Run Find again for more."}</p>
                    <Button className="mt-4" variant="primary" onClick={() => setSel({ kind: "find" })}><Radar size={14} /> {firstRun ? "Find prospects" : "Find more"}</Button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm text-mud-soft"><b className="text-mud">{inbox.length}</b> compan{inbox.length === 1 ? "y" : "ies"} to review, best fit first.</p>
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
    </Panel>
  );
}

function Dismissed({ list, onRestore }: { list: DiscoveryState["dismissed"]; onRestore: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-rim/40 pt-3">
      <button className="text-xs font-medium text-mud-faint hover:text-mud" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {list.length} dismissed
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {list.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg bg-paper-deep/40 px-2.5 py-1.5 text-xs">
              <span className="font-medium">{c.company}</span>
              <span className="min-w-0 flex-1 truncate text-mud-faint">{c.dismissReason ?? "No reason given"}</span>
              <Button size="sm" variant="ghost" onClick={() => onRestore([c.id])}><ArchiveRestore size={12} /> Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
