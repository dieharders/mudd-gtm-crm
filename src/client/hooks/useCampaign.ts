/**
 * One campaign's state on the page: rows, schema, templates, autosave and undo.
 *
 * Every change is applied to local state first (so typing never waits on the disk) and then
 * written to the local server through ONE sequential queue. The queue matters: a cell edit
 * followed quickly by a delete of the same row must reach SQLite in that order.
 *
 * Cell edits are batched for a moment before they are sent, so typing a word is one write, not
 * one per keystroke. `flush()` sends whatever is waiting; export calls it first so the file
 * contains the very last edit.
 *
 * Screening a prospect out only ticks its "Screened out" box (and records why), so it is an
 * ordinary cell edit: the row stays where it is, and Undo puts the box back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { CHECKED, type Campaign, type CampaignSchema, type CellEdit, type CellValue, type Row, type Template } from "../../shared/types";
import { applyCellEdits, sameValue } from "../../shared/values";
import { api } from "../lib/api";

export type SaveState = "idle" | "saving" | "saved" | "error";

type UndoEntry =
  | { kind: "edits"; label: string; before: CellEdit[] }
  | { kind: "insert"; label: string; ids: string[] }
  | { kind: "delete"; label: string; rows: Row[] }
  | { kind: "schema"; label: string; before: CampaignSchema; after: CampaignSchema };

const newRowId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const EDIT_DEBOUNCE = 350;
const UNDO_LIMIT = 100;

export function useCampaign(id: string) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<{ state: SaveState; at: number | null }>({ state: "idle", at: null });
  const [undoCount, setUndoCount] = useState(0);

  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const campaignRef = useRef<Campaign | null>(null);
  campaignRef.current = campaign;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef<Map<string, CellEdit>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);
  const undoStack = useRef<UndoEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const b = await api.campaign(id);
      setCampaign(b.campaign);
      setRows(b.rows);
      setTemplates(b.templates);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a server write in order, tracking the Saved indicator. */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    inflight.current++;
    setSave((s) => ({ ...s, state: "saving" }));
    const p = queue.current.then(fn, fn);
    queue.current = p.then(
      () => {
        if (--inflight.current === 0) setSave({ state: "saved", at: Date.now() });
      },
      (err) => {
        inflight.current--;
        setSave((s) => ({ ...s, state: "error" }));
        toast.error(`Not saved: ${(err as Error).message}`, { id: "save-error" });
      },
    );
    return p;
  }, []);

  const flushEdits = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current.size) return;
    const edits = [...pending.current.values()];
    pending.current.clear();
    void enqueue(() => api.editRows(id, edits));
  }, [enqueue, id]);

  const flush = useCallback(async () => {
    flushEdits();
    await queue.current.catch(() => {});
  }, [flushEdits]);

  // Nothing typed is lost to a closed window: send what is waiting on the way out.
  useEffect(() => {
    const onHide = () => flushEdits();
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      flushEdits();
    };
  }, [flushEdits]);

  const pushUndo = useCallback((e: UndoEntry) => {
    undoStack.current.push(e);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, []);

  const applyLocal = useCallback((edits: CellEdit[]) => {
    const byRow = new Map<string, CellEdit[]>();
    for (const e of edits) {
      const list = byRow.get(e.rowId);
      if (list) list.push(e);
      else byRow.set(e.rowId, [e]);
    }
    setRows((prev) =>
      prev.map((r) => {
        const list = byRow.get(r.id);
        return list ? { ...r, cells: applyCellEdits(r.cells, list) } : r;
      }),
    );
  }, []);

  const queueEdits = useCallback((edits: CellEdit[]) => {
    for (const e of edits) pending.current.set(`${e.rowId}\u0000${e.key}`, e);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushEdits, EDIT_DEBOUNCE);
    setSave((s) => ({ ...s, state: "saving" }));
  }, [flushEdits]);

  /** Change cells. One call is one undo step. Returns false when nothing actually changed. */
  const edit = useCallback((edits: CellEdit[], label = "Edit") => {
    const touched = new Set(edits.map((e) => e.rowId));
    const current = new Map<string, Row>();
    for (const r of rowsRef.current) if (touched.has(r.id)) current.set(r.id, r);
    // Tier 1 picked again over a stored 1 is not a change.
    const real = edits.filter((e) => !sameValue(current.get(e.rowId)?.cells[e.key], e.value));
    if (!real.length) return false;
    const before = real.map((e) => ({ ...e, value: current.get(e.rowId)?.cells[e.key] ?? null }));
    pushUndo({ kind: "edits", label, before });
    applyLocal(real);
    queueEdits(real);
    return true;
  }, [applyLocal, pushUndo, queueEdits]);

  const addRow = useCallback((cells: Record<string, CellValue> = {}) => {
    // A loop, not Math.max(...positions): spreading 100k+ arguments throws in V8.
    let maxPos = -1;
    for (const r of rowsRef.current) if (r.position > maxPos) maxPos = r.position;
    const row: Row = { id: newRowId(), position: maxPos + 1, cells, sourceSheet: null, sourceRow: null };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: "Add row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id, pushUndo]);

  const duplicateRow = useCallback((rowId: string) => {
    const src = rowsRef.current.find((r) => r.id === rowId);
    if (!src) return null;
    // Placed straight after the original, halfway to the next row.
    let next = Infinity;
    for (const r of rowsRef.current) if (r.position > src.position && r.position < next) next = r.position;
    const position = next === Infinity ? src.position + 1 : (src.position + next) / 2;
    const cells = { ...src.cells };
    const s = campaignRef.current?.schema;
    for (const k of [s?.introKey, s?.meetingAtKey, s?.meetingUrlKey]) if (k) delete cells[k];
    const row: Row = { id: newRowId(), position, cells, sourceSheet: null, sourceRow: null };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: "Duplicate row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id, pushUndo]);

  const deleteRows = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    const gone = rowsRef.current.filter((r) => drop.has(r.id));
    if (!gone.length) return;
    setRows((prev) => prev.filter((r) => !drop.has(r.id)));
    pushUndo({ kind: "delete", label: gone.length === 1 ? "Delete row" : `Delete ${gone.length} rows`, rows: gone });
    flushEdits();
    void enqueue(() => api.deleteRows(id, ids));
  }, [enqueue, flushEdits, id, pushUndo]);

  /** Screen prospects out: tick their Screened out box and, when one is given, record why. */
  const screenOut = useCallback((ids: string[], reason?: string) => {
    const s = campaignRef.current?.schema;
    if (!s?.screenedKey) return false;
    const why = reason?.trim();
    const edits: CellEdit[] = [];
    for (const rowId of ids) {
      edits.push({ rowId, key: s.screenedKey, value: CHECKED });
      if (why && s.reasonKey) edits.push({ rowId, key: s.reasonKey, value: why });
    }
    return edit(edits, "Screen out");
  }, [edit]);

  /** Bring screened-out prospects back: untick the box and clear the reason. */
  const restore = useCallback((ids: string[]) => {
    const s = campaignRef.current?.schema;
    if (!s?.screenedKey) return false;
    const edits: CellEdit[] = [];
    for (const rowId of ids) {
      edits.push({ rowId, key: s.screenedKey, value: null });
      if (s.reasonKey) edits.push({ rowId, key: s.reasonKey, value: null });
    }
    return edit(edits, "Restore");
  }, [edit]);

  const setSchema = useCallback((schema: CampaignSchema, label = "Change columns", undoable = true) => {
    const c = campaignRef.current;
    if (!c) return;
    if (undoable) pushUndo({ kind: "schema", label, before: c.schema, after: schema });
    setCampaign({ ...c, schema });
    void enqueue(() => api.updateCampaign(id, { schema }));
  }, [enqueue, id, pushUndo]);

  const rename = useCallback((name: string) => {
    const c = campaignRef.current;
    if (!c || !name.trim() || name === c.name) return;
    setCampaign({ ...c, name });
    void enqueue(() => api.updateCampaign(id, { name }));
  }, [enqueue, id]);

  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!e) return null;
    flushEdits();
    switch (e.kind) {
      case "edits":
        applyLocal(e.before);
        queueEdits(e.before);
        break;
      case "insert": {
        const drop = new Set(e.ids);
        setRows((prev) => prev.filter((r) => !drop.has(r.id)));
        void enqueue(() => api.deleteRows(id, e.ids));
        break;
      }
      case "delete":
        setRows((prev) => [...prev, ...e.rows]);
        void enqueue(() => api.insertRows(id, e.rows));
        break;
      case "schema": {
        const c = campaignRef.current;
        if (!c) break;
        // Columns the server added since (an AI recipe's outputs) are in neither snapshot: they
        // stay, at the end, or the recipe would lose the columns it fills.
        const known = new Set([...e.before.columns, ...e.after.columns].map((col) => col.key));
        const added = c.schema.columns.filter((col) => !known.has(col.key));
        const schema = added.length ? { ...e.before, columns: [...e.before.columns, ...added] } : e.before;
        setCampaign({ ...c, schema });
        void enqueue(() => api.updateCampaign(id, { schema }));
        break;
      }
    }
    return e.label;
  }, [applyLocal, enqueue, flushEdits, id, queueEdits]);

  // ----- templates (not part of undo: each has its own delete confirmation) -----

  const addTemplate = useCallback(async (name: string, body: string) => {
    const t = await enqueue(() => api.createTemplate(id, name, body));
    setTemplates((prev) => [...prev, t]);
    return t;
  }, [enqueue, id]);

  const updateTemplate = useCallback((tid: string, patch: { name?: string; body?: string }) => {
    setTemplates((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)));
    void enqueue(() => api.updateTemplate(tid, patch));
  }, [enqueue]);

  const removeTemplate = useCallback((tid: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== tid));
    void enqueue(() => api.deleteTemplate(tid));
  }, [enqueue]);

  /** Cells changed on the server (auto-filled by a run): shown, but not an undo step. */
  const applyRemote = useCallback((edits: CellEdit[]) => {
    applyLocal(edits);
  }, [applyLocal]);

  /** A campaign the server already saved (a recipe added columns): take it as it is. */
  const replaceCampaign = useCallback((c: Campaign) => {
    setCampaign(c);
  }, []);

  const setSource = useCallback((sourcePath: string) => {
    const c = campaignRef.current;
    if (c) setCampaign({ ...c, sourcePath });
  }, []);

  const sorted = useMemo(() => [...rows].sort((a, b) => a.position - b.position), [rows]);

  return {
    campaign, rows: sorted, templates, error, save, canUndo: undoCount > 0,
    reload: load, edit, addRow, duplicateRow, deleteRows, screenOut, restore, setSchema, rename, undo, flush,
    addTemplate, updateTemplate, removeTemplate, setSource, applyRemote, replaceCampaign,
  };
}

export type CampaignState = ReturnType<typeof useCampaign>;
