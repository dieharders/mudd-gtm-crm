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
 *
 * Prospects and their contacts live in ONE array here, so an edit, an undo or a queued write
 * treats a contact exactly like a prospect; `rows` and `contacts` are views of it. Deleting a
 * prospect deletes its contacts in the same undo step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { newProspectId } from "../../shared/schema";
import { CHECKED, isChecked, type Campaign, type CampaignSchema, type CellEdit, type CellValue, type Row, type Template, type Thesis } from "../../shared/types";
import { applyCellEdits, sameValue } from "../../shared/values";
import { api } from "../lib/api";
import { saveNote, type SaveState } from "../components/ui/Toaster";

type UndoEntry =
  | { kind: "edits"; label: string; before: CellEdit[] }
  | { kind: "insert"; label: string; ids: string[] }
  | { kind: "delete"; label: string; rows: Row[] }
  | { kind: "schema"; label: string; before: CampaignSchema; after: CampaignSchema };

const newRowId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const EDIT_DEBOUNCE = 350;
const UNDO_LIMIT = 100;
const NO_CONTACTS: Row[] = [];

/** The next free prospect ID among these rows, and past the ones the workbook's Contacts tab reserves. */
function nextId(rows: Row[], schema: CampaignSchema | undefined): Record<string, CellValue> {
  const key = schema?.idKey;
  if (!key) return {};
  const taken: string[] = [...(schema.reservedIds ?? [])];
  for (const r of rows) if (!r.parentId && r.cells[key] !== undefined && r.cells[key] !== null) taken.push(String(r.cells[key]));
  return { [key]: newProspectId(taken) };
}

export function useCampaign(id: string) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  /** The ICP thesis; null for a campaign that is not a Discovery campaign. */
  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // The save note in the corner (see saveNote): shown again only when what it says changes. Once
  // the page is left, a "Not saved" still to come goes after a while instead of staying on others.
  const saveId = `save:${id}`;
  const note = useRef<SaveState | null>(null);
  const here = useRef(true);
  const showSave = useCallback((s: SaveState) => {
    if (note.current === s && s === "saving") return;
    note.current = s;
    saveNote(s, saveId, here.current);
  }, [saveId]);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
      if (note.current === "error") toast.dismiss(saveId);
    };
  }, [saveId]);

  const load = useCallback(async () => {
    try {
      const b = await api.campaign(id);
      setCampaign(b.campaign);
      setRows([...b.rows, ...(b.contacts ?? [])]);
      setTemplates(b.templates);
      setThesis(b.thesis ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a server write in order, tracking the save note. A failed one also says why in a toast. */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    inflight.current++;
    showSave("saving");
    const p = queue.current.then(fn, fn);
    queue.current = p.then(
      () => {
        // Not while edits still wait to be sent: they are on their way, and saving.
        if (--inflight.current === 0 && !pending.current.size) showSave("saved");
      },
      (err) => {
        inflight.current--;
        showSave("error");
        toast.error(`Not saved: ${(err as Error).message}`, { id: "save-error" });
      },
    );
    return p;
  }, [showSave]);

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
    showSave("saving");
  }, [flushEdits, showSave]);

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

  /** Add a prospect (with the next free ID), or, with `parentId`, one of its contacts. */
  const addRow = useCallback((cells: Record<string, CellValue> = {}, parentId?: string) => {
    // A loop, not Math.max(...positions): spreading 100k+ arguments throws in V8.
    let maxPos = -1;
    for (const r of rowsRef.current) if (r.position > maxPos) maxPos = r.position;
    const withId = parentId ? cells : { ...cells, ...nextId(rowsRef.current, campaignRef.current?.schema) };
    const row: Row = { id: newRowId(), position: maxPos + 1, cells: withId, sourceSheet: null, sourceRow: null, ...(parentId ? { parentId } : {}) };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: parentId ? "Add contact" : "Add row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id, pushUndo]);

  /**
   * A new contact for a prospect. Not ticked Primary: until someone is, primaryOf addresses the
   * first person, so a channel added first never outranks the people added after it.
   */
  const addContact = useCallback((orgId: string, cells: Record<string, CellValue> = {}) => addRow(cells, orgId), [addRow]);

  const duplicateRow = useCallback((rowId: string) => {
    const src = rowsRef.current.find((r) => r.id === rowId);
    if (!src) return null;
    // Placed straight after the original, halfway to the next row.
    let next = Infinity;
    for (const r of rowsRef.current) if (r.position > src.position && r.position < next) next = r.position;
    const position = next === Infinity ? src.position + 1 : (src.position + next) / 2;
    const s = campaignRef.current?.schema;
    // A copy of a prospect is another prospect: its own ID, and none of its contacts.
    const cells = { ...src.cells, ...(src.parentId ? {} : nextId(rowsRef.current, s)) };
    // A copy of a contact is someone else: the intro was written to the original.
    for (const k of [s?.contacts?.introKey, s?.meetingAtKey, s?.meetingUrlKey]) if (k) delete cells[k];
    const row: Row = { id: newRowId(), position, cells, sourceSheet: null, sourceRow: null, ...(src.parentId ? { parentId: src.parentId } : {}) };
    setRows((prev) => [...prev, row]);
    pushUndo({ kind: "insert", label: "Duplicate row", ids: [row.id] });
    flushEdits();
    void enqueue(() => api.insertRows(id, [row]));
    return row;
  }, [enqueue, flushEdits, id, pushUndo]);

  /** Delete rows; a prospect takes its contacts with it, in the same undo step. */
  const deleteRows = useCallback((ids: string[], label?: string) => {
    const drop = new Set(ids);
    for (const r of rowsRef.current) if (r.parentId && drop.has(r.parentId)) drop.add(r.id);
    const gone = rowsRef.current.filter((r) => drop.has(r.id));
    if (!gone.length) return;
    // The rows asked for, not the contacts that went with them. A Set: a select-all is 100k ids.
    const asked = new Set(ids);
    const named = label ? 0 : gone.reduce((n, r) => n + (asked.has(r.id) ? 1 : 0), 0);
    setRows((prev) => prev.filter((r) => !drop.has(r.id)));
    pushUndo({ kind: "delete", label: label ?? (named === 1 ? "Delete row" : `Delete ${named} rows`), rows: gone });
    flushEdits();
    void enqueue(() => api.deleteRows(id, [...drop]));
  }, [enqueue, flushEdits, id, pushUndo]);

  /**
   * Edit contacts' cells. Ticking a contact Primary unticks the prospect's other contacts in the
   * same step, so a prospect has one Primary contact at most: of several ticked in one batch (a
   * pasted column), the last.
   */
  const editContacts = useCallback((edits: CellEdit[], label = "Edit contact") => {
    const primaryKey = campaignRef.current?.schema.contacts?.primaryKey;
    const ticks = primaryKey ? edits.filter((e) => e.key === primaryKey && isChecked(e.value)) : [];
    if (!ticks.length) return edit(edits, label);
    const { rowById, contactsByOrg } = viewsRef.current;
    const keep = new Map<string, string>();
    for (const e of ticks) {
      const parent = rowById.get(e.rowId)?.parentId;
      if (parent) keep.set(parent, e.rowId);
    }
    const kept = new Set(keep.values());
    const out = edits.map((e) => (e.key === primaryKey && isChecked(e.value) && !kept.has(e.rowId) && rowById.get(e.rowId)?.parentId ? { ...e, value: null } : e));
    const given = new Set(out.map((e) => `${e.rowId}\u0000${e.key}`));
    for (const [parent, id] of keep) {
      for (const c of contactsByOrg.get(parent) ?? []) {
        if (c.id !== id && isChecked(c.cells[primaryKey!]) && !given.has(`${c.id}\u0000${primaryKey}`)) out.push({ rowId: c.id, key: primaryKey!, value: null });
      }
    }
    return edit(out, label);
  }, [edit]);

  /** Make a contact the one intros and templates address. */
  const makePrimary = useCallback((contactId: string) => {
    const primaryKey = campaignRef.current?.schema.contacts?.primaryKey;
    return primaryKey ? editContacts([{ rowId: contactId, key: primaryKey, value: CHECKED }], "Make primary") : false;
  }, [editContacts]);

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
        // A prospect added and then given contacts takes them with it.
        const drop = new Set(e.ids);
        for (const r of rowsRef.current) if (r.parentId && drop.has(r.parentId)) drop.add(r.id);
        setRows((prev) => prev.filter((r) => !drop.has(r.id)));
        void enqueue(() => api.deleteRows(id, [...drop]));
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
        const known = new Set([...e.before.columns, ...e.after.columns, ...(e.before.contacts?.columns ?? []), ...(e.after.contacts?.columns ?? [])].map((col) => col.key));
        const added = c.schema.columns.filter((col) => !known.has(col.key));
        const addedContacts = (c.schema.contacts?.columns ?? []).filter((col) => !known.has(col.key));
        let schema = added.length ? { ...e.before, columns: [...e.before.columns, ...added] } : e.before;
        if (addedContacts.length && schema.contacts) schema = { ...schema, contacts: { ...schema.contacts, columns: [...schema.contacts.columns, ...addedContacts] } };
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

  /**
   * Rows the server added (a run's first contact for a prospect; a Discovery accept's prospect
   * with its contacts): shown, not an undo step. One already here, or whose prospect is neither
   * here nor in the same batch, is left out.
   */
  const applyRemoteRows = useCallback((added: Row[]) => {
    setRows((prev) => {
      const ids = new Set(prev.map((r) => r.id));
      const parents = new Set(ids);
      for (const r of added) if (!r.parentId) parents.add(r.id);
      const fresh = added.filter((r) => !ids.has(r.id) && (!r.parentId || parents.has(r.parentId)));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);

  /** A campaign the server already saved (a recipe added columns): take it as it is. */
  const replaceCampaign = useCallback((c: Campaign) => {
    setCampaign(c);
  }, []);

  const setSource = useCallback((sourcePath: string) => {
    const c = campaignRef.current;
    if (c) setCampaign({ ...c, sourcePath });
  }, []);

  // The views of the one array: the prospects, the contacts, and each prospect's contacts. Each
  // list is the same array as before when its rows are unchanged, so an edit to a contact leaves
  // the prospects (and everything sorted or counted from them) as they were, and a card that
  // shows a prospect's contacts re-renders only when they change.
  const prev = useRef({ prospects: NO_CONTACTS, contacts: NO_CONTACTS, byOrg: new Map<string, Row[]>() });
  const views = useMemo(() => {
    const same = (a: Row[] | undefined, b: Row[]) => !!a && a.length === b.length && a.every((r, i) => r === b[i]);
    const sorted = [...rows].sort((a, b) => a.position - b.position);
    let prospects: Row[] = [];
    let contacts: Row[] = [];
    const lists = new Map<string, Row[]>();
    const rowById = new Map<string, Row>();
    for (const r of sorted) {
      rowById.set(r.id, r);
      if (!r.parentId) {
        prospects.push(r);
        continue;
      }
      contacts.push(r);
      const list = lists.get(r.parentId);
      if (list) list.push(r);
      else lists.set(r.parentId, [r]);
    }
    const contactsByOrg = new Map<string, Row[]>();
    for (const [org, list] of lists) {
      const was = prev.current.byOrg.get(org);
      contactsByOrg.set(org, same(was, list) ? was! : list);
    }
    if (same(prev.current.prospects, prospects)) prospects = prev.current.prospects;
    if (same(prev.current.contacts, contacts)) contacts = prev.current.contacts;
    prev.current = { prospects, contacts, byOrg: contactsByOrg };
    return { prospects, contacts, contactsByOrg, rowById };
  }, [rows]);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const contactsOf = useCallback((orgId: string) => views.contactsByOrg.get(orgId) ?? NO_CONTACTS, [views]);

  return {
    campaign, rows: views.prospects, contacts: views.contacts, contactsOf, rowById: views.rowById, templates, thesis, error, canUndo: undoCount > 0,
    reload: load, edit, editContacts, addRow, addContact, duplicateRow, deleteRows, makePrimary, screenOut, restore, setSchema, rename, undo, flush,
    addTemplate, updateTemplate, removeTemplate, setSource, applyRemote, applyRemoteRows, replaceCampaign, setThesis,
  };
}

export type CampaignState = ReturnType<typeof useCampaign>;
