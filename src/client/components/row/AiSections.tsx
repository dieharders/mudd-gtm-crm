/** The prospect panel's AI parts: findings waiting for review, and "Write with AI" for a contact's intro. */
import { CheckCheck, ExternalLink, Loader2, RotateCcw, Sparkles, Square, Wand2 } from "lucide-react";
import { useState } from "react";
import { columnOf } from "../../../shared/schema";
import type { CampaignSchema, Row, Template } from "../../../shared/types";
import { contactLabel, isEmptyContact } from "../../../shared/values";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { hrefOf, openLink } from "../grid/cells";
import { SuggestionItem } from "../enrich/SuggestionItem";
import { Button } from "../ui/Button";
import { fire } from "../../lib/fire";

/** Findings waiting for review: the row's own, and its contacts', each named by its contact. */
export function RowSuggestions({ row, contacts, schema, enrich }: { row: Row; contacts: Row[]; schema: CampaignSchema; enrich: EnrichmentState }) {
  const whose = new Map(contacts.map((c) => [c.id, contactLabel(c, schema)]));
  // An intro draft is reviewed in its contact's intro section (AiIntro).
  const list = [row, ...contacts].flatMap((r) => enrich.pendingByRow.get(r.id) ?? []).filter((s) => s.key !== schema.contacts?.introKey);
  if (!list.length) return null;
  const colFor = (rowId: string, key: string) => {
    const col = columnOf(schema, key);
    const name = whose.get(rowId);
    return col && name ? { ...col, header: `${name} · ${col.header}` } : col;
  };
  return (
    <section className="rounded-2xl border border-clay bg-clay-soft/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-clay-deep" />
        <h3 className="text-sm font-semibold text-mud">AI found {list.length} update{list.length === 1 ? "" : "s"}</h3>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject(list))}>Reject</Button>
          <Button size="sm" variant="primary" onClick={() => fire(enrich.accept(list))}><CheckCheck size={12} /> Accept all</Button>
        </div>
      </div>
      <div className="space-y-1.5">
        {list.map((s) => (
          <SuggestionItem key={s.id} compact s={s} col={colFor(s.rowId, s.key)} onAccept={() => fire(enrich.accept([s]))} onReject={() => fire(enrich.reject([s]))} />
        ))}
      </div>
    </section>
  );
}

/**
 * Write a contact's intro with AI: pick a template (or let it pick), review the draft. It is built
 * on the prospect's Hook; a prospect with none gets one researched, kept for all its people.
 */
export function AiIntro({ contact: row, schema, templates, enrich }: { contact: Row; schema: CampaignSchema; templates: Template[]; enrich: EnrichmentState }) {
  const ai = useAi();
  const { ready } = useActiveProvider();
  const [templateId, setTemplateId] = useState("auto");
  const [guidance, setGuidance] = useState("");
  const [showGuidance, setShowGuidance] = useState(false);
  const draft = (enrich.pendingByRow.get(row.id) ?? []).find((s) => s.key === schema.contacts?.introKey);
  // The prospect's Hook, when the draft's own run found it.
  const newHook = draft && enrich.suggestions.find((s) => s.runId === draft.runId && s.rowId === row.parentId);
  const run = enrich.activeRuns.find((r) => r.kind === "intro" && r.rows[row.id] && (r.rows[row.id]!.state === "running" || r.rows[row.id]!.state === "pending"));
  const rowState = run?.rows[row.id];
  const lastError = enrich.runs.find((r) => r.kind === "intro" && r.rows[row.id]?.state === "error")?.rows[row.id]?.error;
  // Nobody to write to yet: no name, no email, nothing.
  const nobody = isEmptyContact(row, schema);

  const write = () =>
    enrich.start({ kind: "intro", rowIds: [row.id], intro: { templateId, guidance: guidance.trim() || undefined }, concurrency: 1, autoFill: false });

  if (!templates.length) return null;

  if (draft) {
    const hooks = (draft.note ?? "").split("\n").filter((l) => l.startsWith("Hook: ")).map((l) => l.slice(6));
    const template = (draft.note ?? "").split("\n").find((l) => l.startsWith("Template: "))?.slice(10);
    return (
      <div className="mb-3 rounded-2xl border border-clay bg-clay-soft/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Wand2 size={14} className="text-clay-deep" />
          <span className="text-sm font-semibold text-mud">AI draft</span>
          {template && <span className="tag bg-paper text-mud-soft ring-1 ring-rim/40">from “{template}”</span>}
        </div>
        <p className="rounded-xl bg-paper p-3 text-[13px] leading-relaxed whitespace-pre-wrap ring-1 ring-rim/40">{String(draft.value ?? "")}</p>
        {hooks.length > 0 && (
          <ul className="mt-2 space-y-1">
            {hooks.map((h) => {
              // Only hooks with a source are listed there, so never match one by position.
              const src = draft.sources.find((s) => s.title === h);
              const href = src ? hrefOf(src.url, "url") : null;
              return (
                <li key={h} className="flex items-start gap-1.5 text-xs text-mud-soft">
                  <span className="mt-0.5 text-clay">•</span>
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
        {newHook && <p className="mt-2 text-[11px] text-mud-faint">Using this draft also makes its hook the prospect’s Hook, for the intros to its other people.</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" onClick={() => fire(enrich.accept(newHook ? [draft, newHook] : [draft]))}>Use this draft</Button>
          <Button size="sm" onClick={() => fire(enrich.reject([draft]).then(() => write()))} disabled={!!run || nobody}><RotateCcw size={12} /> Try again</Button>
          <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject([draft]))}>Discard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-2xl border border-dashed border-clay bg-clay-soft/40 p-3">
      {run ? (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={14} className="animate-spin text-clay-deep" />
          <span className="min-w-0 flex-1 truncate text-mud">{rowState?.state === "pending" ? "Waiting to start…" : rowState?.step ?? "Writing…"}</span>
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
              <Button size="sm" variant="primary" disabled={nobody} title={nobody ? "Add who they are first: a name, or how to reach them" : undefined} onClick={() => fire(write())}>
                <Wand2 size={13} /> Write with AI
              </Button>
            ) : (
              <Button size="sm" onClick={() => ai.setOpen(true)}>Set up AI</Button>
            )}
          </div>
          {showGuidance ? (
            <input className="field mt-2 h-8 py-0 text-xs" autoFocus placeholder="Anything to mention? e.g. we met at AUSA, keep it under 80 words" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          ) : (
            <button className="mt-1.5 text-[11px] text-clay-deep hover:underline" onClick={() => setShowGuidance(true)}>+ Add guidance</button>
          )}
          {lastError && <p className="mt-1.5 text-[11px] text-rose-700">Last try failed: {lastError}</p>}
          <p className="mt-1.5 text-[11px] text-mud-faint">Fills your template for {contactLabel(row, schema)}, around the prospect’s Hook, written to their Role, with your Notes as background only. A prospect with no Hook gets one researched, with its source, and keeps it for its other people. You review before it goes in.</p>
        </>
      )}
    </div>
  );
}
