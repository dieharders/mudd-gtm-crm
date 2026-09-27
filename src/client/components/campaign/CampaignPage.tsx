import {
  ArchiveRestore, ArrowLeft, Ban, CheckCircle2, Columns3, FileSpreadsheet, Link2, Loader2, MessageSquareText, Plus,
  Rows3, Search, Table2, Trash2, TriangleAlert, Undo2, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { DEAD, stagesOf, type Bucket, type CampaignSchema, type Column, type Row } from "../../../shared/types";
import { useCampaign, type CampaignState } from "../../hooks/useCampaign";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { stageEdits } from "../../lib/pipeline";
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

const NOT_SET = "\u0000none";
const fileNameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;

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

function viewColumns(schema: CampaignSchema, bucket: Bucket): Column[] {
  const visible = schema.columns.filter((c) => !c.hidden || (bucket === "screened" && c.key === schema.reasonKey));
  if (bucket === "prospects") return visible.filter((c) => c.key !== schema.reasonKey);
  const reason = visible.find((c) => c.key === schema.reasonKey);
  const rest = visible.filter((c) => c.key !== schema.reasonKey);
  return reason ? [rest[0]!, reason, ...rest.slice(1)].filter(Boolean) : rest;
}

function compare(a: Row, b: Row, col: Column | undefined, stages: string[], schema: CampaignSchema): number {
  if (!col) return 0;
  const va = a.cells[col.key];
  const vb = b.cells[col.key];
  const ea = va === undefined || va === null || va === "";
  const eb = vb === undefined || vb === null || vb === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (col.key === schema.statusKey) {
    const ia = va === DEAD ? 999 : stages.indexOf(String(va));
    const ib = vb === DEAD ? 999 : stages.indexOf(String(vb));
    return ia - ib;
  }
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
}

function CampaignView({ state }: { state: CampaignState }) {
  const campaign = state.campaign!;
  const schema = campaign.schema;
  const stages = useMemo(() => stagesOf(schema), [schema]);
  const [params, setParams] = useSearchParams();
  const initialRow = params.get("row");
  const [bucket, setBucket] = useState<Bucket>(() => state.rows.find((r) => r.id === initialRow)?.bucket ?? "prospects");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRowId, setOpenRowId] = useState<string | null>(initialRow);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const grid = useRef<GridHandle>(null);
  const { refresh: refreshList } = useCampaignList();
  const [view, setView] = useStoredState<"table" | "reading">(`mudd:view:${campaign.id}`, "table");
  const groupable = useMemo(() => groupableColumns(schema), [schema]);
  const [groupBy, setGroupBy] = useStoredState<string>(`mudd:group:${campaign.id}`, cardLayout(schema).tierKey ?? "");
  const groupKey = groupable.some((c) => c.key === groupBy) ? groupBy : null;

  useEffect(() => {
    if (initialRow) setParams({}, { replace: true });
  }, []);

  const columns = useMemo(() => viewColumns(schema, bucket), [schema, bucket]);
  const bucketRows = useMemo(() => state.rows.filter((r) => r.bucket === bucket), [state.rows, bucket]);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!schema.statusKey) return out;
    for (const r of state.rows) {
      if (r.bucket !== "prospects") continue;
      const s = display(r.cells[schema.statusKey]) || NOT_SET;
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  }, [state.rows, schema.statusKey]);
  const screenedCount = state.rows.length - Object.values(counts).reduce((a, b) => a + b, 0);
  const prospectCount = state.rows.length - screenedCount;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = bucketRows;
    if (bucket === "prospects" && statusFilter && schema.statusKey) {
      list = list.filter((r) => (display(r.cells[schema.statusKey!]) || NOT_SET) === statusFilter);
    }
    if (q) list = list.filter((r) => Object.values(r.cells).some((v) => display(v).toLowerCase().includes(q)));
    if (sort) {
      const col = schema.columns.find((c) => c.key === sort.key);
      list = [...list].sort((a, b) => compare(a, b, col, stages, schema) * (sort.dir === "asc" ? 1 : -1));
    }
    return list;
  }, [bucketRows, bucket, statusFilter, query, sort, schema, stages]);

  // Selection only ever refers to rows in the current bucket.
  useEffect(() => setSelected(new Set()), [bucket]);
  const selectedIds = useMemo(() => bucketRows.filter((r) => selected.has(r.id)).map((r) => r.id), [bucketRows, selected]);

  // Ctrl+Z anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      e.preventDefault();
      const label = state.undo();
      if (label) toast(`Undid: ${label}`, { id: "undo" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const openRow = openRowId ? state.rows.find((r) => r.id === openRowId) ?? null : null;
  const openIdx = openRow ? filtered.findIndex((r) => r.id === openRow.id) : -1;
  const closeDrawer = useCallback(() => setOpenRowId(null), []);

  const addRow = () => {
    const cells: Row["cells"] = {};
    if (bucket === "prospects" && statusFilter && statusFilter !== NOT_SET && schema.statusKey) cells[schema.statusKey] = statusFilter;
    else if (bucket === "prospects" && schema.statusKey && stages[0]) cells[schema.statusKey] = stages[0];
    const row = state.addRow(bucket, cells);
    setQuery("");
    setSort(null);
    if (view === "reading") setOpenRowId(row.id);
    else setTimeout(() => grid.current?.focusCell(row.id), 50);
  };

  const inSheet = useMemo(() => new Set(campaign.sheets.flatMap((s) => Object.keys(s.colMap))), [campaign.sheets]);
  const passthrough = campaign.sheets.filter((s) => s.role === "passthrough").map((s) => s.name);

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5 pb-3">
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
          </div>
        </div>
        <Button onClick={() => setShowTemplates(true)}>
          <MessageSquareText size={15} /> Templates
          {state.templates.length > 0 && <span className="rounded-md bg-brand-100 px-1.5 text-[11px] font-semibold text-brand-700">{state.templates.length}</span>}
        </Button>
        <Button onClick={() => setShowColumns(true)}><Columns3 size={15} /> Columns</Button>
        <ExportMenu campaign={campaign} state={state} />
      </div>

      {/* buckets */}
      <div className="flex flex-wrap items-end gap-1 border-b border-line px-6">
        <BucketTab active={bucket === "prospects"} onClick={() => setBucket("prospects")} label="Prospects" count={prospectCount} icon={<Users size={14} />} />
        <BucketTab active={bucket === "screened"} onClick={() => setBucket("screened")} label="Screened out" count={screenedCount} icon={<Ban size={14} />} />
        {passthrough.length > 0 && (
          <span className="ml-auto pb-2.5 text-[11px] text-ink-faint" title="These tabs are written back to the file exactly as they were imported">
            Also kept on export: {passthrough.map((p) => <span key={p} className="tag ml-1 bg-zinc-100 text-zinc-600">{p}</span>)}
          </span>
        )}
      </div>

      {/* toolbar */}
      <div className="flex min-h-14 flex-wrap items-center gap-2 px-6 py-3">
        {selectedIds.length > 0 ? (
          <BulkBar
            ids={selectedIds}
            bucket={bucket}
            schema={schema}
            stages={stages}
            state={state}
            onDone={() => setSelected(new Set())}
          />
        ) : (
          <>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
              <input
                className="field h-8 w-56 py-0 pl-8 text-xs"
                placeholder={`Search ${bucket === "prospects" ? "prospects" : "screened out"}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && <button className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-faint hover:text-ink" onClick={() => setQuery("")}><X size={13} /></button>}
            </div>
            {bucket === "prospects" && schema.statusKey && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={!statusFilter} onClick={() => setStatusFilter(null)} label="All" count={prospectCount} tone="bg-zinc-800 text-white" />
                {[...stages, DEAD].map((s) => (counts[s] ? (
                  <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} label={s} count={counts[s]!} tone={toneFor(s, stages).pill} />
                ) : null))}
                {Object.keys(counts).filter((s) => s !== NOT_SET && ![...stages, DEAD].includes(s)).map((s) => (
                  <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} label={s} count={counts[s]!} tone={toneFor(s, stages).pill} />
                ))}
                {counts[NOT_SET] ? <Chip active={statusFilter === NOT_SET} onClick={() => setStatusFilter(statusFilter === NOT_SET ? null : NOT_SET)} label="No status" count={counts[NOT_SET]!} tone="bg-zinc-100 text-zinc-600" /> : null}
              </div>
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
              <Button size="sm" variant="primary" onClick={addRow}><Plus size={13} /> Add {bucket === "prospects" ? "prospect" : "row"}</Button>
            </div>
          </>
        )}
      </div>

      {/* grid + drawer */}
      <div className="relative mx-6 mb-6 min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(23,22,29,0.04)]">
        {bucketRows.length === 0 ? (
          <EmptyBucket bucket={bucket} onAdd={addRow} />
        ) : (
          <>
            {view === "reading" ? (
              <ProspectList rows={filtered} schema={schema} stages={stages} groupBy={groupKey} openRowId={openRowId} onOpenRow={setOpenRowId} />
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
              onEdit={state.edit}
              onOpenRow={setOpenRowId}
              onResize={(key, width) => state.setSchema({ ...schema, columns: schema.columns.map((c) => (c.key === key ? { ...c, width } : c)) }, "Resize column", false)}
              sort={sort}
              onSort={setSort}
              openRowId={openRowId}
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
          />
        )}
      </div>

      {showTemplates && (
        <TemplatesPanel schema={schema} rows={state.rows} templates={state.templates} state={state} previewRowId={openRowId} onClose={() => setShowTemplates(false)} />
      )}
      <ColumnsDialog open={showColumns} onClose={() => setShowColumns(false)} schema={schema} inSheet={inSheet} onSave={(s) => state.setSchema(s)} />
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

function BucketTab({ active, onClick, label, count, icon }: { active: boolean; onClick: () => void; label: string; count: number; icon: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-2 border-b-2 px-3 pt-1 pb-2.5 text-sm font-medium transition",
        active ? "border-brand-500 text-brand-700" : "border-transparent text-ink-soft hover:text-ink",
      )}
    >
      {icon}
      {label}
      <span className={cn("rounded-md px-1.5 text-[11px] font-semibold tabular-nums", active ? "bg-brand-100 text-brand-700" : "bg-zinc-200/70 text-ink-faint")}>{count}</span>
    </button>
  );
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

function EmptyBucket({ bucket, onAdd }: { bucket: Bucket; onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      {bucket === "prospects" ? <FileSpreadsheet className="text-brand-300" size={32} /> : <Ban className="text-zinc-300" size={32} />}
      <p className="text-sm font-medium">{bucket === "prospects" ? "No prospects yet" : "Nobody screened out"}</p>
      <p className="max-w-sm text-xs text-ink-faint">
        {bucket === "prospects"
          ? "Add your first prospect, or paste rows straight from Excel into the grid."
          : "Prospects that fail your buyer filter land here, with the reason. You can restore them any time."}
      </p>
      {bucket === "prospects" && <Button size="sm" variant="primary" className="mt-2" onClick={onAdd}><Plus size={13} /> Add prospect</Button>}
    </div>
  );
}

function BulkBar({ ids, bucket, schema, stages, state, onDone }: {
  ids: string[]; bucket: Bucket; schema: CampaignSchema; stages: string[]; state: CampaignState; onDone: () => void;
}) {
  const n = ids.length;
  const label = `${n} ${n === 1 ? "row" : "rows"}`;
  const setStatus = (stage: string) => {
    const rows = state.rows.filter((r) => ids.includes(r.id));
    state.edit(rows.flatMap((r) => stageEdits(r, schema, stages, stage).edits), `Set ${label} to ${stage}`);
    undoToast(`${label} set to ${stage}`, () => state.undo());
  };
  return (
    <>
      <span className="text-sm font-medium">{n} selected</span>
      {bucket === "prospects" ? (
        <>
          <ScreenOutButton count={n} onConfirm={(reason) => {
            state.moveRows(ids, "screened", reason);
            onDone();
            undoToast(`Screened out ${label}`, () => state.undo());
          }} />
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
      ) : (
        <Button size="sm" onClick={() => {
          state.moveRows(ids, "prospects");
          onDone();
          undoToast(`Restored ${label}`, () => state.undo());
        }}>
          <ArchiveRestore size={13} /> Restore to prospects
        </Button>
      )}
      <Button size="sm" variant="danger" onClick={() => {
        state.deleteRows(ids);
        onDone();
        undoToast(`Deleted ${label}`, () => state.undo());
      }}>
        <Trash2 size={13} /> Delete
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDone}>Clear selection</Button>
    </>
  );
}
