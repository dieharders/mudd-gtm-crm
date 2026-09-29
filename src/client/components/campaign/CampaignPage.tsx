import {
  ArchiveRestore, ArrowLeft, CheckCircle2, Columns3, FileSpreadsheet, Link2, Loader2, MessageSquareText, Plus,
  Loader2 as Spinner, MessageSquarePlus, Rows3, Search, Sparkles, Table2, Trash2, TriangleAlert, Undo2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  DEAD, isChecked, isScreened, stagesOf, type CampaignSchema, type CellEdit, type CellValue, type Column, type Row,
} from "../../../shared/types";
import { sameValue } from "../../../shared/values";
import { useCampaign, type CampaignState } from "../../hooks/useCampaign";
import { useEnrichment, type EnrichmentState } from "../../hooks/useEnrichment";
import { ConsentDialog } from "../enrich/ConsentDialog";
import { EnrichPanel } from "../enrich/EnrichPanel";
import { ReviewPanel } from "../enrich/ReviewPanel";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { stageEdits, stageIndex } from "../../lib/pipeline";
import { tileFor, toneFor } from "../../lib/stages";
import { useCampaignList } from "../../lib/campaignList";
import { Tile } from "../ui/Logo";
import { display } from "../grid/cells";
import { Grid, type GridHandle, type SortState } from "../grid/Grid";
import { ProspectList } from "../list/ProspectList";
import { RowDrawer } from "../row/RowDrawer";
import { cardLayout, groupableColumns } from "../../lib/listLayout";
import { TemplatesPanel } from "../templates/TemplatesPanel";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { undoToast } from "../ui/Toaster";
import { ColumnsDialog } from "./ColumnsDialog";
import { ExportMenu } from "./ExportMenu";
import { ScreenOutButton } from "../row/ScreenOutButton";
import { fire } from "../../lib/fire";

const NOT_SET = "\u0000none";
const fileNameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
// Sorting compares every pair of rows: one collator for all of them, not new options per call.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
// An imported workbook's old Screened-out tab is not part of the campaign: never listed here.
const SCREENED_TAB = /screen|disqual|reject|exclu|do.?not|dnc|dropped/i;
const NO_KEYS = new Set<string>();

export function CampaignPage() {
  const { id } = useParams();
  const state = useCampaign(id!);
  const { campaign, error } = state;
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <TriangleAlert className="text-rose-500" />
        <p className="text-sm text-ink-soft">{error}</p>
        <Link to="/" className="text-sm text-brand-700 hover:underline">Back to campaigns</Link>
      </div>
    );
  }
  if (!campaign) {
    return <div className="flex h-full items-center justify-center text-ink-faint"><Loader2 className="animate-spin" /></div>;
  }
  return <CampaignView key={campaign.id} state={state} />;
}

/** Where a status sorts: the pipeline's order (any case), then stages it doesn't know, then Dead. */
function statusRank(v: CellValue | undefined, stages: string[]): number {
  const s = String(v);
  if (s.toLowerCase() === DEAD.toLowerCase()) return stages.length + 1;
  const i = stageIndex(s, stages);
  return i < 0 ? stages.length : i;
}

function compare(a: Row, b: Row, col: Column | undefined, stages: string[], schema: CampaignSchema): number {
  if (!col) return 0;
  const va = a.cells[col.key];
  const vb = b.cells[col.key];
  const ea = va === undefined || va === null || va === "";
  const eb = vb === undefined || vb === null || vb === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (col.key === schema.statusKey) {
    return statusRank(va, stages) - statusRank(vb, stages) || collator.compare(String(va), String(vb));
  }
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return collator.compare(String(va), String(vb));
}

function CampaignView({ state }: { state: CampaignState }) {
  const campaign = state.campaign!;
  const schema = campaign.schema;
  const { statusKey, screenedKey } = schema;
  const stages = useMemo(() => stagesOf(schema), [schema]);
  const [params, setParams] = useSearchParams();
  const initialRow = params.get("row");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRowId, setOpenRowId] = useState<string | null>(initialRow);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [showEnrich, setShowEnrich] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const enrich = useEnrichment(state);
  const pendingKeys = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of enrich.suggestions) m.set(s.rowId, new Set([...(m.get(s.rowId) ?? []), s.key]));
    return m;
  }, [enrich.suggestions]);
  const liveRun = enrich.activeRuns[0];
  const grid = useRef<GridHandle>(null);
  const { refresh: refreshList } = useCampaignList();
  const [view, setView] = useStoredState<"table" | "reading">(`mudd:view:${campaign.id}`, "table");
  const groupable = useMemo(() => groupableColumns(schema), [schema]);
  const [groupBy, setGroupBy] = useStoredState<string>(`mudd:group:${campaign.id}`, cardLayout(schema).tierKey ?? "");
  const groupKey = groupable.some((c) => c.key === groupBy) ? groupBy : null;

  // A link to one prospect (?row=, from a meeting on the home page) opens it, then leaves the URL.
  useEffect(() => {
    if (!initialRow) return;
    setOpenRowId(initialRow);
    setParams({}, { replace: true });
  }, [initialRow, setParams]);

  // One list: screened-out prospects stay in it, greyed out, so every visible column shows.
  const columns = useMemo(() => schema.columns.filter((c) => !c.hidden), [schema]);
  // A status as its chip: the stage it names, in any case ("contacted" is Contacted).
  const chipOf = useMemo(() => {
    const byLower = new Map([...stages, DEAD].map((s) => [s.toLowerCase(), s]));
    return (row: Row) => {
      const s = statusKey ? display(row.cells[statusKey]).trim() : "";
      return s ? byLower.get(s.toLowerCase()) ?? s : NOT_SET;
    };
  }, [stages, statusKey]);
  // Chips count the prospects still in play; the screened-out ones are only counted.
  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let screened = 0;
    for (const r of state.rows) {
      if (screenedKey && isChecked(r.cells[screenedKey])) {
        screened++;
        continue;
      }
      if (!statusKey) continue;
      const s = chipOf(r);
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return { byStatus, screened };
  }, [state.rows, statusKey, screenedKey, chipOf]);
  const screenedCount = counts.screened;
  const prospectCount = state.rows.length - screenedCount;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = state.rows;
    if (statusFilter && statusKey) {
      list = list.filter((r) => !isScreened(r, schema) && chipOf(r) === statusFilter);
    }
    if (q) list = list.filter((r) => Object.values(r.cells).some((v) => display(v).toLowerCase().includes(q)));
    if (sort) {
      const col = schema.columns.find((c) => c.key === sort.key);
      const dir = sort.dir === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => compare(a, b, col, stages, schema) * dir);
    }
    return list;
  }, [state.rows, statusFilter, statusKey, query, sort, schema, stages, chipOf]);

  // Selection only ever refers to rows that still exist. It may mix prospects in play with
  // screened-out ones; enrichment and status changes take only the ones in play.
  const selectedRows = useMemo(() => state.rows.filter((r) => selected.has(r.id)), [state.rows, selected]);
  const selectedActiveIds = useMemo(
    () => selectedRows.filter((r) => !isScreened(r, schema)).map((r) => r.id),
    [selectedRows, schema],
  );

  // Ctrl+Z anywhere outside a text field.
  const { undo } = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      e.preventDefault();
      const label = undo();
      if (label) toast(`Undid: ${label}`, { id: "undo" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const openRow = openRowId ? state.rows.find((r) => r.id === openRowId) ?? null : null;
  const openIdx = openRow ? filtered.findIndex((r) => r.id === openRow.id) : -1;
  const closeDrawer = useCallback(() => setOpenRowId(null), []);

  const addRow = () => {
    const cells: Row["cells"] = {};
    if (statusFilter && statusFilter !== NOT_SET && statusKey) cells[statusKey] = statusFilter;
    else if (statusKey && stages[0]) cells[statusKey] = stages[0];
    const row = state.addRow(cells);
    setQuery("");
    setSort(null);
    if (view === "reading") setOpenRowId(row.id);
    else setTimeout(() => grid.current?.focusCell(row.id), 50);
  };

  const { edit, rows } = state;
  /**
   * Grid edits, made the way the prospect panel makes them: a new status also stamps the Sent /
   * Replied / Last touch dates, and unticking Screened out clears the reason, as Restore does.
   * A value typed or pasted in the same batch wins over either.
   */
  const gridEdit = useCallback((edits: CellEdit[], label?: string) => {
    const { reasonKey } = schema;
    const restoring = (e: CellEdit) => e.key === screenedKey && !!reasonKey && !isChecked(e.value);
    if (!edits.some((e) => (e.key === statusKey && e.value) || restoring(e))) return edit(edits, label);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const given = new Set(edits.map((e) => `${e.rowId}\u0000${e.key}`));
    const out = [...edits];
    const add = (e: CellEdit) => {
      if (!given.has(`${e.rowId}\u0000${e.key}`)) out.push(e);
    };
    for (const e of edits) {
      const row = byId.get(e.rowId);
      if (!row) continue;
      if (e.key === statusKey && typeof e.value === "string" && e.value && !sameValue(row.cells[statusKey], e.value)) {
        stageEdits(row, schema, stages, e.value).edits.forEach(add);
      }
      if (restoring(e) && isScreened(row, schema)) add({ rowId: row.id, key: reasonKey!, value: null });
    }
    return edit(out, label);
  }, [edit, rows, schema, screenedKey, stages, statusKey]);
  const isLocked = useCallback((row: Row) => isScreened(row, schema), [schema]);

  const inSheet = useMemo(() => new Set(campaign.sheets.flatMap((s) => Object.keys(s.colMap))), [campaign.sheets]);
  const passthrough = campaign.sheets.filter((s) => s.role === "passthrough" && !SCREENED_TAB.test(s.name)).map((s) => s.name);
  // Every key a row holds a value for, deleted columns' too, so a new column never inherits one.
  const usedKeys = useMemo(() => {
    if (!showColumns) return NO_KEYS;
    const keys = new Set<string>();
    for (const r of state.rows) for (const k of Object.keys(r.cells)) keys.add(k);
    return keys;
  }, [showColumns, state.rows]);

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 pt-5 pb-3">
        <Link to="/" className="rounded-lg p-1.5 text-ink-faint hover:bg-zinc-900/5 hover:text-ink" title="All campaigns"><ArrowLeft size={17} /></Link>
        <Tile size="lg" className={tileFor(campaign.id)}>{campaign.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
        <div className="min-w-0 flex-1">
          <NameInput value={campaign.name} onCommit={(n) => { state.rename(n); setTimeout(refreshList, 400); }} />
          <div className="flex items-center gap-2.5 truncate text-xs text-ink-faint">
            {campaign.sourcePath ? (
              <span className="tag max-w-md truncate bg-emerald-100 text-emerald-800" title={campaign.sourcePath}>
                <FileSpreadsheet size={12} /> <span className="truncate">{fileNameOf(campaign.sourcePath)}</span> <Link2 size={11} />
              </span>
            ) : campaign.sourceName ? (
              <span className="tag bg-zinc-100 text-zinc-600" title="Dropped files are not linked: use Save as to pick where it goes"><FileSpreadsheet size={12} /> {campaign.sourceName} · not linked</span>
            ) : (
              <span className="tag bg-violet-100 text-violet-800">Created in Mudd</span>
            )}
            <SaveIndicator state={state} />
            {passthrough.length > 0 && (
              <span className="truncate" title="These tabs are written back to the file exactly as they were imported">
                Also kept on export: {passthrough.map((p) => <span key={p} className="tag ml-1 bg-zinc-100 text-zinc-600">{p}</span>)}
              </span>
            )}
          </div>
        </div>
        {liveRun && (
          <button onClick={() => setShowEnrich(true)} className="tag h-8 rounded-lg bg-sky-100 px-2.5 text-sky-800 hover:bg-sky-200" title="Open the running enrichment">
            <Spinner size={12} className={liveRun.status === "running" ? "animate-spin" : ""} />
            {liveRun.label}: {liveRun.completed + liveRun.failed}/{liveRun.total}{liveRun.status === "paused" ? " · paused" : ""}
          </button>
        )}
        {enrich.suggestions.length > 0 && (
          <Button onClick={() => setShowReview(true)} className="border-yellow-300 bg-yellow-50 hover:bg-yellow-100">
            Review <span className="rounded-md bg-yellow-300 px-1.5 text-[11px] font-bold text-yellow-900">{enrich.suggestions.length}</span>
          </Button>
        )}
        <Button variant="subtle" onClick={() => setShowEnrich(true)}>
          <Sparkles size={15} /> Enrich
        </Button>
        <Button onClick={() => setShowTemplates(true)}>
          <MessageSquareText size={15} /> Templates
          {state.templates.length > 0 && <span className="rounded-md bg-brand-100 px-1.5 text-[11px] font-semibold text-brand-700">{state.templates.length}</span>}
        </Button>
        <Button onClick={() => setShowColumns(true)}><Columns3 size={15} /> Columns</Button>
        <ExportMenu campaign={campaign} state={state} />
      </div>

      {/* toolbar */}
      <div className="flex min-h-14 flex-wrap items-center gap-2 px-6 py-3">
        {selectedRows.length > 0 ? (
          <BulkBar
            rows={selectedRows}
            schema={schema}
            stages={stages}
            state={state}
            enrich={enrich}
            onEnrich={() => setShowEnrich(true)}
            onDone={() => setSelected(new Set())}
          />
        ) : (
          <>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
              <input
                className="field h-8 w-56 py-0 pl-8 text-xs"
                placeholder="Search prospects"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && <button className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-faint hover:text-ink" onClick={() => setQuery("")}><X size={13} /></button>}
            </div>
            {statusKey && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={!statusFilter} onClick={() => setStatusFilter(null)} label="All" count={prospectCount} tone="bg-brand-100 text-brand-700" />
                {[...stages, DEAD].map((s) => (counts.byStatus[s] ? (
                  <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} label={s} count={counts.byStatus[s]!} tone={toneFor(s, stages).pill} />
                ) : null))}
                {Object.keys(counts.byStatus).filter((s) => s !== NOT_SET && ![...stages, DEAD].includes(s)).map((s) => (
                  <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} label={s} count={counts.byStatus[s]!} tone={toneFor(s, stages).pill} />
                ))}
                {counts.byStatus[NOT_SET] ? <Chip active={statusFilter === NOT_SET} onClick={() => setStatusFilter(statusFilter === NOT_SET ? null : NOT_SET)} label="No status" count={counts.byStatus[NOT_SET]!} tone="bg-zinc-100 text-zinc-600" /> : null}
              </div>
            )}
            {screenedCount > 0 && (
              <span className="text-xs text-ink-faint tabular-nums" title="Screened-out prospects stay in the list, greyed out. Open one to restore it.">
                {screenedCount} screened out
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {view === "reading" && groupable.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-ink-faint">
                  Group by
                  <select className="field h-8 w-auto py-0 pr-7 text-xs" value={groupKey ?? ""} onChange={(e) => setGroupBy(e.target.value)}>
                    <option value="">Nothing</option>
                    {groupable.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
                  </select>
                </label>
              )}
              <ViewToggle view={view} onChange={setView} />
              <Button size="sm" variant="ghost" disabled={!state.canUndo} onClick={() => { const l = state.undo(); if (l) toast(`Undid: ${l}`, { id: "undo" }); }} title="Undo (Ctrl+Z)">
                <Undo2 size={13} /> Undo
              </Button>
              <Button size="sm" variant="primary" onClick={addRow}><Plus size={13} /> Add prospect</Button>
            </div>
          </>
        )}
      </div>

      {/* grid + drawer */}
      <div className="relative mx-6 mb-6 min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(23,22,29,0.04)]">
        {state.rows.length === 0 ? (
          <EmptyList onAdd={addRow} />
        ) : (
          <>
            {view === "reading" ? (
              <ProspectList rows={filtered} schema={schema} stages={stages} groupBy={groupKey} openRowId={openRowId} onOpenRow={setOpenRowId} pending={pendingKeys} />
            ) : (
            <Grid
              ref={grid}
              columns={columns}
              rows={filtered}
              schema={schema}
              stages={stages}
              pinned={Math.min(2, columns.length)}
              selected={selected}
              onSelect={setSelected}
              onEdit={gridEdit}
              onOpenRow={setOpenRowId}
              onResize={(key, width) => state.setSchema({ ...schema, columns: schema.columns.map((c) => (c.key === key ? { ...c, width } : c)) }, "Resize column", false)}
              sort={sort}
              onSort={setSort}
              openRowId={openRowId}
              isLocked={isLocked}
              pending={pendingKeys}
            />
            )}
            {filtered.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-24 text-center text-sm text-ink-faint">No rows match.</div>
            )}
          </>
        )}
        {openRow && (
          <RowDrawer
            row={openRow}
            schema={schema}
            stages={stages}
            templates={state.templates}
            state={state}
            onClose={closeDrawer}
            onPrev={openIdx > 0 ? () => setOpenRowId(filtered[openIdx - 1]!.id) : undefined}
            onNext={openIdx >= 0 && openIdx < filtered.length - 1 ? () => setOpenRowId(filtered[openIdx + 1]!.id) : undefined}
            onOpenTemplates={() => setShowTemplates(true)}
            enrich={enrich}
          />
        )}
      </div>

      {showTemplates && (
        <TemplatesPanel schema={schema} rows={state.rows} templates={state.templates} state={state} previewRowId={openRowId} onClose={() => setShowTemplates(false)} />
      )}
      {showEnrich && (
        <EnrichPanel state={state} enrich={enrich} selectedIds={selectedActiveIds} filteredIds={filtered.filter((r) => !isScreened(r, schema)).map((r) => r.id)}
          onClose={() => setShowEnrich(false)} onOpenReview={() => { setShowEnrich(false); setShowReview(true); }} onOpenRow={(id) => { setShowEnrich(false); setOpenRowId(id); }} />
      )}
      {showReview && <ReviewPanel state={state} enrich={enrich} onClose={() => setShowReview(false)} onOpenRow={setOpenRowId} />}
      <ConsentDialog open={!!enrich.needsConsent} onConfirm={() => enrich.needsConsent?.confirm()} onCancel={() => enrich.needsConsent?.cancel()} />
      <ColumnsDialog open={showColumns} onClose={() => setShowColumns(false)} schema={schema} inSheet={inSheet} usedKeys={usedKeys} onSave={(s) => state.setSchema(s)} />
    </div>
  );
}

function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="-ml-1 w-full max-w-xl truncate rounded-md border border-transparent bg-transparent px-1 text-base font-semibold outline-none hover:border-line focus:border-brand-300 focus:bg-white"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? onCommit(draft.trim()) : setDraft(value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setDraft(value); e.currentTarget.blur(); }
      }}
      aria-label="Campaign name"
    />
  );
}

function SaveIndicator({ state }: { state: CampaignState }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const { state: s, at } = state.save;
  if (s === "saving") return <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Saving…</span>;
  if (s === "error") return <span className="inline-flex items-center gap-1 text-rose-600"><TriangleAlert size={11} /> Not saved</span>;
  if (s === "saved" && at) return <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={11} /> Saved {timeAgo(at)}</span>;
  return <span>Saved on this computer</span>;
}

function ViewToggle({ view, onChange }: { view: "table" | "reading"; onChange: (v: "table" | "reading") => void }) {
  const opt = (v: "table" | "reading", icon: ReactNode, label: string) => (
    <button
      onClick={() => onChange(v)}
      title={`${label} view`}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition",
        view === v ? "bg-white text-ink shadow-[0_1px_2px_rgba(23,22,29,0.12)]" : "text-ink-faint hover:text-ink",
      )}
    >
      {icon} {label}
    </button>
  );
  return (
    <div className="flex rounded-lg bg-zinc-200/60 p-0.5">
      {opt("table", <Table2 size={13} />, "Table")}
      {opt("reading", <Rows3 size={13} />, "Reading")}
    </div>
  );
}

/** A per-browser preference (view, grouping). Storage may be unavailable; then it just resets. */
function useStoredState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* private mode: keep it for this session only */
    }
  };
  return [value, set];
}

function Chip({ active, onClick, label, count, tone }: { active: boolean; onClick: () => void; label: string; count: number; tone: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition",
        active ? cn(tone, "shadow-[inset_0_0_0_1.5px_currentColor]") : "border border-line bg-white text-ink-soft hover:border-line-strong hover:text-ink",
      )}
    >
      {label}
      <span className="opacity-60 tabular-nums">{count}</span>
    </button>
  );
}

function EmptyList({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <FileSpreadsheet className="text-brand-300" size={32} />
      <p className="text-sm font-medium">No prospects yet</p>
      <p className="max-w-sm text-xs text-ink-faint">Add your first prospect, or paste rows straight from Excel into the grid.</p>
      <Button size="sm" variant="primary" className="mt-2" onClick={onAdd}><Plus size={13} /> Add prospect</Button>
    </div>
  );
}

/**
 * Actions on the selected rows. A selection can mix prospects in play with screened-out ones:
 * Screen out, Enrich, Draft intros and Set status take the ones in play, Restore the screened-out
 * ones, Delete all of them.
 */
function BulkBar({ rows, schema, stages, state, enrich, onEnrich, onDone }: {
  rows: Row[]; schema: CampaignSchema; stages: string[]; state: CampaignState; enrich: EnrichmentState; onEnrich: () => void; onDone: () => void;
}) {
  const active = rows.filter((r) => !isScreened(r, schema));
  const activeIds = active.map((r) => r.id);
  const screenedIds = rows.filter((r) => isScreened(r, schema)).map((r) => r.id);
  const count = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  const setStatus = (stage: string) => {
    const label = count(active.length);
    if (state.edit(active.flatMap((r) => stageEdits(r, schema, stages, stage).edits), `Set ${label} to ${stage}`)) {
      undoToast(`${label} set to ${stage}`, () => state.undo());
    }
  };
  return (
    <>
      <span className="text-sm font-medium">{rows.length} selected</span>
      {activeIds.length > 0 && screenedIds.length > 0 && <span className="text-xs text-ink-faint">({screenedIds.length} screened out)</span>}
      {activeIds.length > 0 && (
        <>
          <ScreenOutButton count={activeIds.length} onConfirm={(reason) => {
            onDone();
            if (state.screenOut(activeIds, reason)) undoToast(`Screened out ${count(activeIds.length)}`, () => state.undo());
          }} />
          <Button size="sm" variant="subtle" onClick={onEnrich}><Sparkles size={13} /> Enrich</Button>
          {schema.introKey && (
            <Button size="sm" variant="subtle" disabled={!state.templates.length} title={state.templates.length ? "Write an intro for each selected prospect from your templates" : "Add an intro template first"}
              onClick={() => fire(enrich.start({ kind: "intro", rowIds: activeIds, intro: { templateId: "auto" }, concurrency: 2 }).then((run) => {
                if (run) toast.success(`Drafting ${activeIds.length} intro${activeIds.length === 1 ? "" : "s"}. They'll appear under Review.`);
              }))}>
              <MessageSquarePlus size={13} /> Draft intros
            </Button>
          )}
          {schema.statusKey && (
            <Popover trigger={({ toggle }) => <Button size="sm" onClick={toggle}>Set status</Button>}>
              {(close) => (
                <>
                  {[...stages, DEAD].map((s) => (
                    <MenuItem key={s} icon={<span className={cn("block h-2 w-2 rounded-full", toneFor(s, stages).dot)} />} onClick={() => { close(); setStatus(s); }}>{s}</MenuItem>
                  ))}
                </>
              )}
            </Popover>
          )}
        </>
      )}
      {screenedIds.length > 0 && (
        <Button size="sm" onClick={() => {
          onDone();
          if (state.restore(screenedIds)) undoToast(`Restored ${count(screenedIds.length)}`, () => state.undo());
        }}>
          <ArchiveRestore size={13} /> Restore{activeIds.length > 0 ? ` ${screenedIds.length}` : ""}
        </Button>
      )}
      <Button size="sm" variant="danger" onClick={() => {
        state.deleteRows(rows.map((r) => r.id));
        onDone();
        undoToast(`Deleted ${count(rows.length)}`, () => state.undo());
      }}>
        <Trash2 size={13} /> Delete
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDone}>Clear selection</Button>
    </>
  );
}
