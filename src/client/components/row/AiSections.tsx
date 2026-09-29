/** The prospect panel's AI parts: findings waiting for review, and "Write with AI" for the intro. */
import { CheckCheck, ExternalLink, Loader2, RotateCcw, Sparkles, Square, Wand2 } from "lucide-react";
import { useState } from "react";
import type { CampaignSchema, Row, Template } from "../../../shared/types";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { hrefOf, openLink } from "../grid/cells";
import { SuggestionItem } from "../enrich/SuggestionItem";
import { Button } from "../ui/Button";
import { fire } from "../../lib/fire";

export function RowSuggestions({ row, schema, enrich }: { row: Row; schema: CampaignSchema; enrich: EnrichmentState }) {
  const list = (enrich.pendingByRow.get(row.id) ?? []).filter((s) => s.key !== schema.introKey);
  if (!list.length) return null;
  return (
    <section className="rounded-2xl border border-brand-200 bg-brand-50/50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-brand-600" />
        <h3 className="text-sm font-semibold text-brand-900">AI found {list.length} update{list.length === 1 ? "" : "s"}</h3>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject(list))}>Reject</Button>
          <Button size="sm" variant="primary" onClick={() => fire(enrich.accept(list))}><CheckCheck size={12} /> Accept all</Button>
        </div>
      </div>
      <div className="space-y-1.5">
        {list.map((s) => (
          <SuggestionItem key={s.id} compact s={s} col={schema.columns.find((c) => c.key === s.key)} onAccept={() => fire(enrich.accept([s]))} onReject={() => fire(enrich.reject([s]))} />
        ))}
      </div>
    </section>
  );
}

/** Write the intro with AI: pick a template (or let it pick), research hooks, review the draft. */
export function AiIntro({ row, schema, templates, enrich }: { row: Row; schema: CampaignSchema; templates: Template[]; enrich: EnrichmentState }) {
  const ai = useAi();
  const { ready } = useActiveProvider();
  const [templateId, setTemplateId] = useState("auto");
  const [guidance, setGuidance] = useState("");
  const [showGuidance, setShowGuidance] = useState(false);
  const draft = (enrich.pendingByRow.get(row.id) ?? []).find((s) => s.key === schema.introKey);
  const run = enrich.activeRuns.find((r) => r.kind === "intro" && r.rows[row.id] && (r.rows[row.id]!.state === "running" || r.rows[row.id]!.state === "pending"));
  const rowState = run?.rows[row.id];
  const lastError = enrich.runs.find((r) => r.kind === "intro" && r.rows[row.id]?.state === "error")?.rows[row.id]?.error;

  const write = () =>
    enrich.start({ kind: "intro", rowIds: [row.id], intro: { templateId, guidance: guidance.trim() || undefined }, concurrency: 1, autoFill: false });

  if (!templates.length) return null;

  if (draft) {
    const hooks = (draft.note ?? "").split("\n").filter((l) => l.startsWith("Hook: ")).map((l) => l.slice(6));
    const template = (draft.note ?? "").split("\n").find((l) => l.startsWith("Template: "))?.slice(10);
    return (
      <div className="mb-3 rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-3">
        <div className="mb-2 flex items-center gap-2">
          <Wand2 size={14} className="text-brand-600" />
          <span className="text-sm font-semibold text-brand-900">AI draft</span>
          {template && <span className="tag bg-white text-ink-soft ring-1 ring-line">from “{template}”</span>}
        </div>
        <p className="rounded-xl bg-white p-3 text-[13px] leading-relaxed whitespace-pre-wrap ring-1 ring-line">{String(draft.value ?? "")}</p>
        {hooks.length > 0 && (
          <ul className="mt-2 space-y-1">
            {hooks.map((h) => {
              // Only hooks with a source are listed there, so never match one by position.
              const src = draft.sources.find((s) => s.title === h);
              const href = src ? hrefOf(src.url, "url") : null;
              return (
                <li key={h} className="flex items-start gap-1.5 text-xs text-ink-soft">
                  <span className="mt-0.5 text-brand-500">•</span>
                  <span className="min-w-0 flex-1">{h}</span>
                  {href && (
                    <button onClick={() => openLink(href)} className="tag shrink-0 bg-sky-50 text-sky-800 hover:bg-sky-100" title={href}>
                      <ExternalLink size={10} /> {href.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" onClick={() => fire(enrich.accept([draft]))}>Use this draft</Button>
          <Button size="sm" onClick={() => fire(enrich.reject([draft]).then(() => write()))} disabled={!!run}><RotateCcw size={12} /> Try again</Button>
          <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject([draft]))}>Discard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-2xl border border-dashed border-brand-200 bg-brand-50/40 p-3">
      {run ? (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={14} className="animate-spin text-brand-600" />
          <span className="min-w-0 flex-1 truncate text-brand-900">{rowState?.state === "pending" ? "Waiting to start…" : rowState?.step ?? "Writing…"}</span>
          <Button size="sm" variant="ghost" onClick={() => fire(enrich.action(run.id, "stop"))}><Square size={11} /> Stop</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select className="field h-8 w-auto flex-1 py-0 text-xs" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="auto">✨ Let AI pick the best template</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {ready ? (
              <Button size="sm" variant="primary" onClick={() => fire(write())}><Wand2 size={13} /> Write with AI</Button>
            ) : (
              <Button size="sm" onClick={() => ai.setOpen(true)}>Set up AI</Button>
            )}
          </div>
          {showGuidance ? (
            <input className="field mt-2 h-8 py-0 text-xs" autoFocus placeholder="Anything to mention? e.g. we met at AUSA, keep it under 80 words" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          ) : (
            <button className="mt-1.5 text-[11px] text-brand-700 hover:underline" onClick={() => setShowGuidance(true)}>+ Add guidance</button>
          )}
          {lastError && <p className="mt-1.5 text-[11px] text-rose-700">Last try failed: {lastError}</p>}
          <p className="mt-1.5 text-[11px] text-ink-faint">Fills your template around this prospect’s Hook, or researches 1–2 hooks when it has none, with sources. You review before it goes in.</p>
        </>
      )}
    </div>
  );
}
