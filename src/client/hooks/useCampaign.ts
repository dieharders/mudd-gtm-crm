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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { Bucket, Campaign, CampaignSchema, CellEdit, CellValue, Row, Template } from "../../shared/types";
import { api } from "../lib/api";

export type SaveState = "idle" | "saving" | "saved" | "error";

type UndoEntry =
  | { kind: "edits"; label: string; before: CellEdit[] }
  | { kind: "insert"; label: string; ids: string[] }
  | { kind: "delete"; label: string; rows: Row[] }
  | { kind: "move"; label: string; ids: string[]; from: Bucket; edits: CellEdit[]; positions: Record<string, number> }
  | { kind: "schema"; label: string; before: CampaignSchema };

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

  const pushUndo = (e: UndoEntry) => {
    undoStack.current.push(e);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  };

  const applyLocal = (edits: CellEdit[]) => {
    const byRow = new Map<string, CellEdit[]>();
    for (const e of edits) byRow.set(e.rowId, [...(byRow.get(e.rowId) ?? []), e]);
    setRows((prev) =>
      prev.map((r) => {
        const list = byRow.get(r.id);
        if (!list) return r;
        const cells = { ...r.cells };
        for (const e of list) {
          if (e.value === null || e.value === "") delete cells[e.key];
          else cells[e.key] = e.value;
        }
        return { ...r, cells };
      }),
    );
  };

  const queueEdits = (edits: CellEdit[]) => {
    for (const e of edits) pending.current.set(`${e.rowId}\u0000${e.key}`, e);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushEdits, EDIT_DEBOUNCE);
    setSave((s) => ({ ...s, state: "saving" }));
  };

  /** Change cells. One call is one undo step. */
  const edit = useCallback((edits: CellEdit[], label = "Edit") => {
    const current = new Map(rowsRef.current.map((r) => [r.id, r]));
    const real = edits.filter((e) => {
      const before = current.get(e.rowId)?.cells[e.key] ?? null;
      const norm = (v: CellValue) => (v === "" ? null : v);
      return norm(before) !== norm(e.value);
    });
    if (!real.length) return;
    const before = real.map((e) => ({ ...e, value: current.get(e.rowId)?.cells[e.key] ?? null }));
    pushUndo({ kind: "edits", label, before });
    applyLocal(real);
    queueEdits(real);
  }, []);

  const addRow = useCallback((bucket: Bucket, cells: Record<string, CellValue> = {}) => {
    const maxPos = Math.max(-1, ...rowsRef.current.map((r) => r.position));
    const row: Row = { id: newRowId(), bucket, position: maxPos + 1, cells, sourceSheet: null, sourceRow: null };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: "Add row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id]);

  const duplicateRow = useCallback((rowId: string) => {
    const src = rowsRef.current.find((r) => r.id === rowId);
    if (!src) return null;
    // Placed straight after the original, halfway to the next row.
    const sorted = [...rowsRef.current].sort((a, b) => a.position - b.position);
    const i = sorted.findIndex((r) => r.id === rowId);
    const next = sorted[i + 1];
    const position = next ? (src.position + next.position) / 2 : src.position + 1;
    const cells = { ...src.cells };
    const s = campaignRef.current?.schema;
    for (const k of [s?.introKey, s?.meetingAtKey, s?.meetingUrlKey]) if (k) delete cells[k];
    const row: Row = { id: newRowId(), bucket: src.bucket, position, cells, sourceSheet: null, sourceRow: null };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: "Duplicate row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id]);

  const deleteRows = useCallback((ids: string[]) => {
    const gone = rowsRef.current.filter((r) => ids.includes(r.id));
    if (!gone.length) return;
    setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
    pushUndo({ kind: "delete", label: gone.length === 1 ? "Delete row" : `Delete ${gone.length} rows`, rows: gone });
    flushEdits();
    void enqueue(() => api.deleteRows(id, ids));
  }, [enqueue, flushEdits, id]);

  /** Move rows between buckets. Screening out can record a reason; restoring clears it. */
  const moveRows = useCallback((ids: string[], bucket: Bucket, reason?: string) => {
    const moving = rowsRef.current.filter((r) => ids.includes(r.id) && r.bucket !== bucket);
    if (!moving.length) return;
    const reasonKey = campaignRef.current?.schema.reasonKey;
    const from = moving[0]!.bucket;
    const edits: CellEdit[] = [];
    const before: CellEdit[] = [];
    if (reasonKey) {
      for (const r of moving) {
        const value = bucket === "screened" ? (reason?.trim() || (r.cells[reasonKey] ?? null)) : null;
        if ((r.cells[reasonKey] ?? null) !== value) {
          edits.push({ rowId: r.id, key: reasonKey, value });
          before.push({ rowId: r.id, key: reasonKey, value: r.cells[reasonKey] ?? null });
        }
      }
    }
    const movingIds = moving.map((r) => r.id);
    // A moved row goes to the END of the list it joins; undo puts it back where it was.
    const maxPos = Math.max(-1, ...rowsRef.current.map((r) => r.position));
    const positions: Record<string, number> = {};
    const oldPositions: Record<string, number> = {};
    moving.forEach((r, i) => {
      positions[r.id] = maxPos + 1 + i;
      oldPositions[r.id] = r.position;
    });
    setRows((prev) => prev.map((r) => (movingIds.includes(r.id) ? { ...r, bucket, position: positions[r.id]! } : r)));
    if (edits.length) applyLocal(edits);
    pushUndo({ kind: "move", label: bucket === "screened" ? "Screen out" : "Restore", ids: movingIds, from, edits: before, positions: oldPositions });
    flushEdits();
    void enqueue(async () => {
      await api.moveRows(id, movingIds, bucket, positions);
      if (edits.length) await api.editRows(id, edits);
    });
  }, [enqueue, flushEdits, id]);

  const setSchema = useCallback((schema: CampaignSchema, label = "Change columns", undoable = true) => {
    const c = campaignRef.current;
    if (!c) return;
    if (undoable) pushUndo({ kind: "schema", label, before: c.schema });
    setCampaign({ ...c, schema });
    void enqueue(() => api.updateCampaign(id, { schema }));
  }, [enqueue, id]);

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
      case "insert":
        setRows((prev) => prev.filter((r) => !e.ids.includes(r.id)));
        void enqueue(() => api.deleteRows(id, e.ids));
        break;
      case "delete":
        setRows((prev) => [...prev, ...e.rows]);
        void enqueue(() => api.insertRows(id, e.rows));
        break;
      case "move":
        setRows((prev) => prev.map((r) => (e.ids.includes(r.id) ? { ...r, bucket: e.from, position: e.positions[r.id] ?? r.position } : r)));
        if (e.edits.length) applyLocal(e.edits);
        void enqueue(async () => {
          await api.moveRows(id, e.ids, e.from, e.positions);
          if (e.edits.length) await api.editRows(id, e.edits);
        });
        break;
      case "schema": {
        const c = campaignRef.current;
        if (c) setCampaign({ ...c, schema: e.before });
        void enqueue(() => api.updateCampaign(id, { schema: e.before }));
        break;
      }
    }
    return e.label;
  }, [enqueue, flushEdits, id]);

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
  }, []);

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
    reload: load, edit, addRow, duplicateRow, deleteRows, moveRows, setSchema, rename, undo, flush,
    addTemplate, updateTemplate, removeTemplate, setSource, applyRemote, replaceCampaign,
  };
}

export type CampaignState = ReturnType<typeof useCampaign>;
