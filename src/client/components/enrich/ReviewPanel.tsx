/**
 * Review everything the AI found: accept into the sheet, or reject. Grouped by prospect, a
 * contact's findings under its prospect, named by the contact.
 */
import { CheckCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Suggestion } from "../../../shared/ai";
import { columnOf } from "../../../shared/schema";
import { contactLabel, primaryOf, prospectTitle } from "../../../shared/values";
import type { CampaignState } from "../../hooks/useCampaign";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";
import { Tile } from "../ui/Logo";
import { SuggestionItem } from "./SuggestionItem";
import { fire } from "../../lib/fire";

export function ReviewPanel({ state, enrich, onClose, onOpenRow }: {
  state: CampaignState;
  enrich: EnrichmentState;
  onClose: () => void;
  onOpenRow: (id: string) => void;
}) {
  const schema = state.campaign!.schema;
  const [column, setColumn] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = enrich.suggestions.filter((s) => !column || s.key === column);
  const columns = [...new Set(enrich.suggestions.map((s) => s.key))];
  const { rowById } = state;
  const groups = useMemo(() => {
    const order = new Map(state.rows.map((r, i) => [r.id, i]));
    const map = new Map<string, typeof list>();
    for (const s of list) {
      const org = rowById.get(s.rowId)?.parentId ?? s.rowId;
      map.set(org, [...(map.get(org) ?? []), s]);
    }
    return [...map.entries()].sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }, [list, state.rows, rowById]);
  const colOf = (k: string) => columnOf(schema, k);
  /** A suggestion's column, named for its contact when it is one of a contact's. */
  const colFor = (s: Suggestion) => {
    const col = colOf(s.key);
    const row = rowById.get(s.rowId);
    return col && row?.parentId ? { ...col, header: `${contactLabel(row, schema)} · ${col.header}` } : col;
  };

  return (
    <Panel
      onClose={onClose}
      closeLabel="Close review"
      width="max-w-[780px]"
      icon={<Tile size="lg" className="border-2 border-rim bg-clay-soft text-clay-deep"><Sparkles size={20} /></Tile>}
      title="Review suggestions"
      subtitle={`${enrich.suggestions.length} waiting · nothing changes in your sheet until you accept`}
    >
        {enrich.suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b-2 border-rim/40 bg-paper-deep/40 px-6 py-3">
            <select className="field h-9 w-auto py-0 pr-8 text-[13px]" value={column} onChange={(e) => setColumn(e.target.value)}>
              <option value="">All columns</option>
              {columns.map((k) => <option key={k} value={k}>{colOf(k)?.header ?? k}</option>)}
            </select>
            <span className="text-xs text-mud-faint">{list.length} shown</span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject(list))}>Reject all</Button>
              <Button size="sm" variant="primary" onClick={() => fire(enrich.accept(list))}><CheckCheck size={13} /> Accept all {list.length}</Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">
          {groups.length === 0 ? (
            <div className="mt-16 text-center">
              <Tile size="lg" className="mx-auto bg-emerald-100 text-emerald-700"><CheckCheck size={18} /></Tile>
              <p className="mt-3 font-medium">All caught up</p>
              <p className="mt-1 text-sm text-mud-faint">New findings from enrichment runs show up here.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map(([rowId, items]) => {
                const row = rowById.get(rowId);
                const t = row ? prospectTitle(row, primaryOf(state.contactsOf(rowId), schema), schema) : { title: "Deleted row", subtitle: "" };
                return (
                  <section key={rowId}>
                    <div className="mb-2 flex items-center gap-2">
                      <button className="min-w-0 truncate text-left text-sm font-semibold hover:text-clay-deep" onClick={() => { onOpenRow(rowId); onClose(); }}>
                        {t.title}
                      </button>
                      {t.subtitle && <span className="truncate text-xs text-mud-faint">{t.subtitle}</span>}
                      <div className="ml-auto flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" onClick={() => fire(enrich.reject(items))}>Reject</Button>
                        <Button size="sm" variant="subtle" onClick={() => fire(enrich.accept(items))}>Accept {items.length > 1 ? `all ${items.length}` : ""}</Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {items.map((s) => (
                        <SuggestionItem key={s.id} s={s} col={colFor(s)} onAccept={() => fire(enrich.accept([s]))} onReject={() => fire(enrich.reject([s]))} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
    </Panel>
  );
}
