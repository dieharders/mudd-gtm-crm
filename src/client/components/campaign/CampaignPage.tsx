import {
  ArchiveRestore, Building2, Columns3, FileSpreadsheet, FolderOpen, Inbox, ListChecks, ListFilter, Loader2, MessageSquareText, MoreHorizontal, Plus,
  Loader2 as Spinner, Radar, Rows3, Search, Sparkles, Table2, Trash2, TriangleAlert, Undo2, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { allColumns, contactSchema, orgColumn } from "../../../shared/schema";
import {
  DEAD, isChecked, isScreened, ORG_KEY, STAGES, type CampaignSchema, type CellEdit, type CellValue, type Column, type ContactSchema, type Row,
} from "../../../shared/types";
import { useCampaign, type CampaignState } from "../../hooks/useCampaign";
import { useConsentGate } from "../../hooks/useConsentGate";
import { useDiscovery } from "../../hooks/useDiscovery";
import { useEnrichment, type EnrichmentState } from "../../hooks/useEnrichment";
import { useLeaving } from "../../hooks/useLeaving";
import { useToday } from "../../hooks/useToday";
import { DiscoverPanel, type DiscoverSection } from "../discover/DiscoverPanel";
import { ConsentDialog } from "../enrich/ConsentDialog";
import { EnrichPanel } from "../enrich/EnrichPanel";
import { ReviewPanel } from "../enrich/ReviewPanel";
import { cn } from "../../lib/cn";
import { stageEdits, stageIndex } from "../../lib/pipeline";
import { contactFilters, prospectFilters, runsThrough, type FilterContext, type QuickFilter } from "../../lib/quickFilters";
import { toneFor } from "../../lib/stages";
import { useCampaignList } from "../../lib/campaignList";
import { display } from "../grid/cells";
import { Grid, type GridHandle, type SortState } from "../grid/Grid";
import { ProspectList } from "../list/ProspectList";
import { DRAWER_LEAVE_MS, RowDrawer } from "../row/RowDrawer";
import { cardLayout, groupableColumns, pinnedCount } from "../../lib/listLayout";
import { TemplatesPanel } from "../templates/TemplatesPanel";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { PanelGate } from "../ui/Panel";
import { PinCard, Pinboard, PinGroup, PinToggle, type PinCardProps, type PinToggleProps } from "../ui/Pinboard";
import { undoToast } from "../ui/Toaster";
import { RemoveCampaignDialog } from "../campaigns/RemoveCampaignDialog";
import { ColumnsDialog } from "./ColumnsDialog";
import { ExportMenu } from "./ExportMenu";
import { ScreenOutButton } from "../row/ScreenOutButton";
import { api } from "../../lib/api";
import { fire } from "../../lib/fire";

const NOT_SET = "\u0000none";
/** The status filter that shows only the screened-out prospects. */
const SCREENED = "\u0000screened";
/** The filter that leaves the screened-out prospects out. */
const IN_PLAY = "\u0000inplay";
/** A filter that is one of the quick filters (Needs follow-up…), by its id. */
const QUICK = "\u0000quick:";
/** All's card, keyed apart from every status a sheet could hold. */
const ALL = "\u0000all";
const NO_PICKS: ReadonlySet<string> = new Set();
/** A filter that is a status: a stage, another status the sheet holds, or No status. */
const isStatusPick = (p: string) => p !== IN_PLAY && p !== SCREENED && !p.startsWith(QUICK);
/** The names of the filters that aren't a status the sheet holds or a quick filter. */
const FIXED_LABELS: Record<string, string> = { [ALL]: "All", [IN_PLAY]: "Prospects only", [NOT_SET]: "No status", [SCREENED]: "Screened out" };

/** What a filter is called on its card: a status as the sheet has it, a quick filter by its label. */
function pickLabel(id: string, quick: QuickFilter[]): string {
  return FIXED_LABELS[id] ?? (id.startsWith(QUICK) ? quick.find((f) => QUICK + f.id === id)?.label : undefined) ?? id;
}

/** Turn a filter on or off. Prospects only and Screened out rule each other out: one turns the other off. */
function togglePick(picked: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(picked);
  if (next.delete(id)) return next;
  next.add(id);
  if (id === IN_PLAY) next.delete(SCREENED);
  if (id === SCREENED) next.delete(IN_PLAY);
  return next;
}

/** The picks without any quick filter no longer offered (its column or recipe gone); the same set when none went. */
function keepOffered(picked: ReadonlySet<string>, offered: QuickFilter[]): ReadonlySet<string> {
  const gone = [...picked].filter((p) => p.startsWith(QUICK) && !offered.some((f) => QUICK + f.id === p));
  if (!gone.length) return picked;
  const next = new Set(picked);
  for (const p of gone) next.delete(p);
  return next;
}

/**
 * Let go of the selected rows that leave the list (an edit moving them past the filters, a delete),
 * so none of the selection is left out of sight and out of the header checkbox's reach. The rest
 * stays selected, through rows joining the list, a new order, or a run filling in cells.
 */
function usePruneSelection(rows: Row[], setSelected: (update: (s: Set<string>) => Set<string>) => void) {
  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const shown = new Set(rows.map((r) => r.id));
      const kept = [...s].filter((id) => shown.has(id));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [rows, setSelected]);
}
// Sorting compares every pair of rows: one collator for all of them, not new options per call.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NO_KEYS = new Set<string>();
const NO_ROWS: Row[] = [];
const NO_IDS: string[] = [];
/** What a filter that reads no context is tested with: it never looks. */
const NO_CONTEXT: FilterContext = { contactsOf: () => NO_ROWS, ran: () => false };
/** The Contacts grid's Company column comes from the prospect: read-only there. */
const CONTACT_FIXED = new Set([ORG_KEY]);

type Tab = "prospects" | "contacts";

export function CampaignPage() {
  const { id } = useParams();
  const state = useCampaign(id!);
  const { campaign, error } = state;
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <TriangleAlert className="text-rose-500" />
        <p className="text-sm text-mud-soft">{error}</p>
        <Link to="/" className="text-[15px] font-bold text-clay-deep hover:underline">Back to campaigns</Link>
      </div>
    );
  }
  if (!campaign) {
    return <div className="flex h-full items-center justify-center text-mud-faint"><Loader2 className="animate-spin" /></div>;
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

/** Cells that hold the search text (lowercased), in any column. */
const cellsHit = (cells: Row["cells"], q: string) => Object.values(cells).some((v) => display(v).toLowerCase().includes(q));

/** A list sorted by one of the schema's columns, as the grid header asks; the same list unsorted. */
function sortRows(list: Row[], sort: SortState | null, schema: CampaignSchema, stages: string[]): Row[] {
  if (!sort) return list;
  const col = schema.columns.find((c) => c.key === sort.key);
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => compare(a, b, col, stages, schema) * dir);
}

function CampaignView({ state }: { state: CampaignState }) {
  const campaign = state.campaign!;
  const schema = campaign.schema;
  const { statusKey, screenedKey } = schema;
  const stages = STAGES;
  const [params, setParams] = useSearchParams();
  const initialRow = params.get("row");
  const initialDiscover = params.get("discover");
  const [query, setQuery] = useState("");
  // The filters that are on, none being All. Statuses (and Screened out) widen each other, as a
  // prospect has one status; Prospects only and the quick filters each narrow what those leave.
  const [picked, setPicked] = useState<ReadonlySet<string>>(NO_PICKS);
  const pick = (id: string) => setPicked((p) => togglePick(p, id));
  // The Contacts tab's, as `picked` is the Prospects tab's.
  const [contactPicked, setContactPicked] = useState<ReadonlySet<string>>(NO_PICKS);
  const pickContact = (id: string) => setContactPicked((p) => togglePick(p, id));
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRowId, setOpenRowId] = useState<string | null>(initialRow);
  // A contact open in the prospect panel, drilled into from the prospect, a card or the Contacts tab.
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [contactSort, setContactSort] = useState<SortState | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [showEnrich, setShowEnrich] = useState(false);
  const [showReview, setShowReview] = useState(false);
  // The Discover panel, open on one of its sections.
  const [showDiscover, setShowDiscover] = useState<DiscoverSection | null>(null);
  const [removing, setRemoving] = useState(false);
  // The overflow drawer: the campaign's workspaces and file actions, pinned up as cards.
  const [showMore, setShowMore] = useState(false);
  const closeMore = useCallback(() => setShowMore(false), []);
  // The filter drawer: the current tab's filters, pinned up as cards that turn on and off.
  const [showFilters, setShowFilters] = useState(false);
  const closeFilters = useCallback(() => setShowFilters(false), []);
  const navigate = useNavigate();
  // One consent dialog for both: enrichment and Discovery each ask the same thing once.
  const consent = useConsentGate();
  const enrich = useEnrichment(state, consent);
  const discovery = useDiscovery(state, consent);
  const liveDiscovery = discovery.activeRuns[0];
  const pendingKeys = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of enrich.suggestions) m.set(s.rowId, new Set([...(m.get(s.rowId) ?? []), s.key]));
    return m;
  }, [enrich.suggestions]);
  const liveRun = enrich.activeRuns[0];
  // Suggestions to review and companies in the inbox: badged on the overflow button, which holds them.
  const waiting = enrich.suggestions.length + (discovery.enabled ? discovery.inbox.length : 0);
  const grid = useRef<GridHandle>(null);
  const { refresh: refreshList } = useCampaignList();
  const [view, storeView] = useStoredState<"table" | "reading">(`mudd:view:${campaign.id}`, "table");
  // Reading has no checkboxes to untick a selection with: a switch of view lets go of it.
  const setView = (v: "table" | "reading") => {
    if (v !== view) setSelected(new Set());
    storeView(v);
  };
  const [stored, setTab] = useStoredState<Tab>(`mudd:tab:${campaign.id}`, "prospects");
  const tab: Tab = stored === "contacts" ? "contacts" : "prospects";
  const onContacts = tab === "contacts";
  const groupable = useMemo(() => groupableColumns(schema), [schema]);
  const [groupBy, setGroupBy] = useStoredState<string>(`mudd:group:${campaign.id}`, cardLayout(schema).tierKey ?? "");
  const groupKey = groupable.some((c) => c.key === groupBy) ? groupBy : null;
  // What the sheet shows. It rises in on each switch, but not on arriving, as the page already does.
  const sheet = onContacts ? "contacts" : view;
  const firstSheet = useRef(sheet);
  const sheetMoved = useRef(false);
  if (sheet !== firstSheet.current) sheetMoved.current = true;

  // A link to one prospect (?row=, from a meeting on the home page) opens it, then leaves the URL.
  useEffect(() => {
    if (!initialRow) return;
    setOpenRowId(initialRow);
    setParams({}, { replace: true });
  }, [initialRow, setParams]);
  // A new Discovery campaign arrives with ?discover=thesis: the panel opens on the rest of the thesis.
  useEffect(() => {
    if (!initialDiscover) return;
    setShowDiscover(initialDiscover === "find" || initialDiscover === "inbox" ? initialDiscover : "thesis");
    setParams({}, { replace: true });
  }, [initialDiscover, setParams]);

  // One list: screened-out prospects stay in it, greyed out, so every visible column shows.
  const columns = useMemo(() => schema.columns.filter((c) => !c.hidden), [schema]);
  // A status as its filter: the stage it names, in any case ("contacted" is Contacted).
  const statusPickOf = useMemo(() => {
    const byLower = new Map([...stages, DEAD].map((s) => [s.toLowerCase(), s]));
    return (row: Row) => {
      const s = statusKey ? display(row.cells[statusKey]).trim() : "";
      return s ? byLower.get(s.toLowerCase()) ?? s : NOT_SET;
    };
  }, [stages, statusKey]);
  // All counts every prospect, as the list shows them; a status filter counts only those of its
  // status still in play, and the screened-out ones have a filter of their own.
  const counts = useMemo<StatusCounts>(() => {
    const byStatus: Record<string, number> = {};
    let screened = 0;
    for (const r of state.rows) {
      if (screenedKey && isChecked(r.cells[screenedKey])) {
        screened++;
        continue;
      }
      if (!statusKey) continue;
      const s = statusPickOf(r);
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return { byStatus, screened };
  }, [state.rows, statusKey, screenedKey, statusPickOf]);

  const { contactsOf } = state;
  const { recipes, runs, finished } = enrich;
  const today = useToday();
  const ran = useMemo(() => runsThrough(runs, finished), [runs, finished]);
  const filterContext = useMemo<FilterContext>(() => ({ contactsOf, ran }), [contactsOf, ran]);
  const q = query.trim().toLowerCase();
  // Read only while searching: a contact's edit then leaves the prospect list (and its sort) be.
  const searchedContactsOf = q ? contactsOf : null;
  const quick = useMemo(() => prospectFilters(schema, stages, recipes, today), [schema, stages, recipes, today]);
  // The same for the filters: only one that is on and reads the contacts (or the runs) filters the
  // list again on a contact's edit (or a run's progress).
  const reading = new Set(quick.filter((f) => f.reads && picked.has(QUICK + f.id)).map((f) => f.reads));
  const readContactsOf = reading.has("contactsOf") ? contactsOf : null;
  const readRan = reading.has("ran") ? ran : null;
  // Whether a prospect passes the filters that are on; null when All is. The filters are the
  // Prospects tab's: out of reach on the Contacts tab, they filter nothing there.
  const passes = useMemo(() => {
    if (onContacts || !picked.size) return null;
    const statuses = new Set([...picked].filter(isStatusPick));
    const screenedOn = picked.has(SCREENED);
    const inPlayOnly = picked.has(IN_PLAY);
    const tests = quick.filter((f) => picked.has(QUICK + f.id)).map((f) => f.test);
    const ctx: FilterContext = { contactsOf: readContactsOf ?? NO_CONTEXT.contactsOf, ran: readRan ?? NO_CONTEXT.ran };
    return (r: Row) => {
      const screened = isScreened(r, schema);
      if (inPlayOnly && screened) return false;
      if ((statuses.size || screenedOn) && !(screened ? screenedOn : !!statusKey && statuses.has(statusPickOf(r)))) return false;
      return tests.every((t) => t(r, ctx));
    };
  }, [onContacts, picked, quick, schema, statusKey, statusPickOf, readContactsOf, readRan]);
  const filtered = useMemo(() => {
    let list = state.rows;
    if (passes) list = list.filter(passes);
    // A prospect matches on its own cells or any of its people's.
    if (searchedContactsOf) list = list.filter((r) => cellsHit(r.cells, q) || searchedContactsOf(r.id).some((c) => cellsHit(c.cells, q)));
    return sortRows(list, sort, schema, stages);
  }, [state.rows, passes, q, sort, schema, stages, searchedContactsOf]);

  // ----- the Contacts tab: every prospect's people, with the prospect's company beside them -----
  // Worked out only while the tab is open: every contact is copied to add its company. The
  // contacts' own keys come along: the grid flags a Pattern email by their Email source.
  const contactGridSchema = useMemo<CampaignSchema & ContactSchema>(() => {
    const org = orgColumn(schema);
    const cs = contactSchema(schema);
    return { ...cs, columns: org ? [org, ...cs.columns] : cs.columns };
  }, [schema]);
  const contactColumns = useMemo(() => contactGridSchema.columns.filter((c) => !c.hidden), [contactGridSchema]);
  const { rowById } = state;
  const contactRows = useMemo(() => {
    const { companyKey } = schema;
    if (!onContacts) return NO_ROWS;
    if (!companyKey) return state.contacts;
    return state.contacts.map((c) => {
      const org = c.parentId ? rowById.get(c.parentId) : undefined;
      return { ...c, cells: { ...c.cells, [ORG_KEY]: org ? org.cells[companyKey] ?? null : null } };
    });
  }, [onContacts, state.contacts, rowById, schema]);
  const contactQuick = useMemo(() => contactFilters(schema), [schema]);
  // The contacts' filters read only the contact.
  const filteredContacts = useMemo(() => {
    const on = contactQuick.filter((f) => contactPicked.has(QUICK + f.id));
    const list = contactRows.filter((r) => on.every((f) => f.test(r, NO_CONTEXT)) && (!q || cellsHit(r.cells, q)));
    return sortRows(list, contactSort, contactGridSchema, stages);
  }, [contactRows, contactQuick, contactPicked, q, contactSort, contactGridSchema, stages]);
  const hasFilters = onContacts ? contactQuick.length > 0 : !!statusKey || counts.screened > 0 || quick.length > 0;
  // The current tab's filters that are on, by name: their cards are out of sight once the drawer closes.
  const onNames = onContacts ? [...contactPicked].map((p) => pickLabel(p, contactQuick)) : [...picked].map((p) => pickLabel(p, quick));
  // A filter no longer offered can't stay on unseen, filtering by nothing while All shows off.
  useEffect(() => setPicked((p) => keepOffered(p, quick)), [quick]);
  useEffect(() => setContactPicked((p) => keepOffered(p, contactQuick)), [contactQuick]);
  usePruneSelection(filtered, setSelected);
  usePruneSelection(filteredContacts, setSelectedContacts);
  // A screened-out prospect's people are greyed out and read-only, as it is.
  const isContactLocked = useCallback((r: Row) => {
    const org = r.parentId ? rowById.get(r.parentId) : undefined;
    return !!org && isScreened(org, schema);
  }, [rowById, schema]);
  const selectedContactRows = useMemo(
    () => (onContacts && selectedContacts.size ? state.contacts.filter((c) => selectedContacts.has(c.id)) : NO_ROWS),
    [onContacts, state.contacts, selectedContacts],
  );
  const idFixed = useMemo(() => new Set([schema.idKey].filter((k): k is string => !!k)), [schema.idKey]);

  // Selection only ever refers to rows that still exist. It may mix prospects in play with
  // screened-out ones; enrichment and status changes take only the ones in play.
  const selectedRows = useMemo(() => state.rows.filter((r) => selected.has(r.id)), [state.rows, selected]);
  const selectedActiveIds = useMemo(
    () => selectedRows.filter((r) => !isScreened(r, schema)).map((r) => r.id),
    [selectedRows, schema],
  );
  // The prospects in play in the view, for Enrich's scopes: worked out only while it is open.
  const filteredActiveIds = useMemo(
    () => (showEnrich ? filtered.filter((r) => !isScreened(r, schema)).map((r) => r.id) : NO_IDS),
    [showEnrich, filtered, schema],
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
  // Where the open prospect last sat in the list. An edit can take it off the list (a quick
  // filter's to-do, done): Prev and Next then step on from the gap it left.
  const lastAt = useRef<{ id: string; idx: number } | null>(null);
  if (openRow && openIdx >= 0) lastAt.current = { id: openRow.id, idx: openIdx };
  const gap = openRow && openIdx < 0 && lastAt.current?.id === openRow.id ? Math.min(lastAt.current.idx, filtered.length) : -1;
  const prevRow = openIdx > 0 ? filtered[openIdx - 1] : gap > 0 ? filtered[gap - 1] : undefined;
  const nextRow = openIdx >= 0 ? filtered[openIdx + 1] : gap >= 0 ? filtered[gap] : undefined;
  /** Open a prospect in the panel (null closes it), on the prospect itself. */
  const showRow = useCallback((id: string | null) => {
    setOpenRowId(id);
    setOpenContactId(null);
  }, []);
  const closeDrawer = useCallback(() => showRow(null), [showRow]);
  // The panel slides out after it closes, still showing what it last had open.
  const drawer = useLeaving(!!openRow, DRAWER_LEAVE_MS, openRow && { row: openRow, contacts: contactsOf(openRow.id), contactId: openContactId });
  // Read through a ref: a stable callback keeps every card from re-rendering on each edit.
  const rowByIdRef = useRef(rowById);
  rowByIdRef.current = rowById;
  /** Open a contact: its prospect's panel, drilled into that person. */
  const openContact = useCallback((id: string) => {
    const parent = rowByIdRef.current.get(id)?.parentId;
    if (!parent) return;
    setOpenRowId(parent);
    setOpenContactId(id);
  }, []);

  const addRow = () => {
    const cells: Row["cells"] = {};
    // The first status picked, in pipeline order, so the new prospect is among those listed;
    // none when only No status is.
    const status = [...stages, DEAD, ...picked].find((s) => picked.has(s) && s !== NOT_SET && isStatusPick(s)) ?? (picked.has(NOT_SET) ? null : stages[0]);
    if (statusKey && status) cells[statusKey] = status;
    const row = state.addRow(cells);
    setQuery("");
    setSort(null);
    // A blank prospect may still miss the filters that are on (a quick filter, Screened out):
    // back to All, rather than have it vanish as soon as it is added.
    if (passes && !passes(row)) setPicked(NO_PICKS);
    if (view === "reading") showRow(row.id);
    else setTimeout(() => grid.current?.focusCell(row.id), 50);
  };

  const { edit, rows } = state;
  /**
   * Grid edits, made the way the prospect panel makes them: unticking Screened out clears the
   * reason, as Restore does. A value typed or pasted in the same batch wins.
   */
  const gridEdit = useCallback((edits: CellEdit[], label?: string) => {
    const { reasonKey } = schema;
    const restoring = (e: CellEdit) => e.key === screenedKey && !!reasonKey && !isChecked(e.value);
    if (!edits.some(restoring)) return edit(edits, label);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const given = new Set(edits.map((e) => `${e.rowId}\u0000${e.key}`));
    const out = [...edits];
    for (const e of edits) {
      const row = byId.get(e.rowId);
      if (row && restoring(e) && isScreened(row, schema) && !given.has(`${row.id}\u0000${reasonKey}`)) out.push({ rowId: row.id, key: reasonKey!, value: null });
    }
    return edit(out, label);
  }, [edit, rows, schema, screenedKey]);
  const isLocked = useCallback((row: Row) => isScreened(row, schema), [schema]);

  // The columns each tab of the workbook has: kept, not deleted, in the Columns dialog.
  const sheetKeys = useMemo(() => {
    const of = (role: Tab) => new Set(campaign.sheets.filter((s) => s.role === role).flatMap((s) => Object.keys(s.colMap)));
    return { prospects: of("prospects"), contacts: of("contacts") };
  }, [campaign.sheets]);
  const inSheet = sheetKeys[tab];
  // Every key a row holds a value for, deleted columns' too, so a new column never inherits one;
  // and every column's, prospects' and contacts' alike: they share one namespace.
  const usedKeys = useMemo(() => {
    if (!showColumns) return NO_KEYS;
    const keys = new Set(allColumns(schema).map((c) => c.key));
    for (const r of [...state.rows, ...state.contacts]) for (const k of Object.keys(r.cells)) keys.add(k);
    return keys;
  }, [showColumns, state.rows, state.contacts, schema]);

  return (
    <div className="flex h-full flex-col bg-board">
      {/* header. It, the toolbar and the sheet each rise in, not the page: a transform on the page
          would pin the panels and dialogs below to it while it runs. */}
      <div className="flex flex-wrap items-center gap-3 px-6 pt-6 pb-3 motion-safe:animate-page-in">
        <div className="min-w-0 flex-1">
          <NameInput value={campaign.name} onCommit={(n) => { state.rename(n); setTimeout(refreshList, 400); }} />
        </div>
        {liveRun && (
          <button onClick={() => setShowEnrich(true)} className="tag h-9 rounded-lg bg-lake-soft px-3 font-bold text-lake-deep hover:bg-lake-soft/70" title="Open the running enrichment">
            <Spinner size={12} className={liveRun.status === "running" ? "animate-spin" : ""} />
            {liveRun.label}: {liveRun.completed + liveRun.failed}/{liveRun.total}{liveRun.status === "paused" ? " · paused" : ""}
          </button>
        )}
        {discovery.enabled && liveDiscovery && (
          <button onClick={() => setShowDiscover("find")} className="tag h-9 rounded-lg bg-note-mint px-3 font-bold text-mud hover:bg-note-mint/70" title="Open the running Discovery">
            <Spinner size={12} className={liveDiscovery.status === "running" ? "animate-spin" : ""} />
            {liveDiscovery.kind === "find" ? `Discovery: ${liveDiscovery.found}/${liveDiscovery.target} found` : liveDiscovery.kind === "map" ? "Mapping…" : "Drafting thesis…"}{liveDiscovery.status === "paused" ? " · paused" : ""}
          </button>
        )}
        <ExportMenu campaign={campaign} state={state} />
        <span className="relative inline-flex">
          <Button size="icon" variant="ghost" onClick={() => setShowMore(true)} title="More" aria-label="Campaign menu"><MoreHorizontal size={20} /></Button>
          {waiting > 0 && (
            <span className="pointer-events-none absolute -top-1 -right-1 rounded-full border border-rim bg-clay px-1.5 font-label text-[11px] leading-5 font-bold text-paper tabular-nums" title={`${waiting} waiting for you`}>
              {waiting}
            </span>
          )}
        </span>
      </div>
      <Pinboard open={showMore} title={campaign.name} onClose={closeMore}>
          {/* Numbered across both groups, so no two neighbours lean the same way. */}
          {(() => {
            const pick = (open: () => void) => () => { closeMore(); open(); };
            const work: Omit<PinCardProps, "index">[] = [
              ...(enrich.suggestions.length ? [{ tone: "bg-note", icon: <ListChecks size={18} />, label: "Review", count: enrich.suggestions.length, hint: "AI suggestions to accept", onClick: pick(() => setShowReview(true)) }] : []),
              ...(discovery.enabled && discovery.inbox.length ? [{ tone: "bg-note-mint", icon: <Inbox size={18} />, label: "Inbox", count: discovery.inbox.length, hint: "Companies found for you", onClick: pick(() => setShowDiscover("inbox")) }] : []),
              ...(discovery.enabled ? [{ tone: "bg-lake-soft", icon: <Radar size={18} />, label: "Discover", hint: "Find new prospects", onClick: pick(() => setShowDiscover(discovery.inbox.length ? "inbox" : "find")) }] : []),
              { tone: "bg-paper", icon: <MessageSquareText size={18} />, label: "Templates", count: state.templates.length, hint: "Intro/outreach messages", onClick: pick(() => setShowTemplates(true)) },
              { tone: "bg-paper", icon: <Columns3 size={18} />, label: "Columns", hint: onContacts ? "Of the contacts list" : "Of the prospects list", onClick: pick(() => setShowColumns(true)) },
            ];
            const file: Omit<PinCardProps, "index">[] = [
              ...(campaign.sourcePath ? [{ icon: <FolderOpen size={18} />, label: "Show in folder", hint: campaign.sourcePath, title: campaign.sourcePath, onClick: pick(() => fire(api.revealFile(campaign.id))) }] : []),
              { tone: "bg-note-pink", danger: true, icon: <Trash2 size={18} />, label: "Remove from App", hint: "The file stays", onClick: pick(() => setRemoving(true)) },
            ];
            return (
              <>
                <PinGroup label="Work">{work.map((c, i) => <PinCard key={c.label} index={i} {...c} />)}</PinGroup>
                <PinGroup label="File">{file.map((c, i) => <PinCard key={c.label} index={work.length + i} {...c} />)}</PinGroup>
              </>
            );
          })()}
      </Pinboard>

      {/* toolbar: what the sheet shows */}
      <div className="flex min-h-16 flex-wrap items-center gap-3 px-6 pt-3 pb-16 motion-safe:animate-page-in">
        {onContacts && selectedContactRows.length > 0 ? (
          <ContactBulkBar rows={selectedContactRows} state={state} enrich={enrich} onDone={() => setSelectedContacts(new Set())} />
        ) : !onContacts && selectedRows.length > 0 ? (
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
            <TabSwitch tab={tab} onChange={setTab} prospects={state.rows.length} contacts={state.contacts.length} />
            <div className="group relative">
              <Search size={16} className={`pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 transition group-focus-within:text-mud-soft ${query ? "text-mud-soft" : "text-mud-faint/70"}`} />
              {/* Dull at rest; the plain brown rim on cream once focused or filtering, without the clay focus ring. */}
              <input
                className={`field h-10 w-64 py-0 pl-10 text-[14px] focus:border-rim focus:bg-paper focus:ring-0 focus-visible:outline-none ${query ? "" : "border-rim/30 bg-paper/50"}`}
                placeholder={onContacts ? "Search contacts" : "Search prospects"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && <button className="absolute top-1/2 right-3 -translate-y-1/2 text-mud-faint hover:text-mud" onClick={() => setQuery("")}><X size={15} /></button>}
            </div>
            {hasFilters && <FilterButton open={showFilters} on={onNames} onClick={() => setShowFilters(true)} />}
          </>
        )}
      </div>
      {/* The board is drawn (and its filters counted) only while it is shown. */}
      <Pinboard open={showFilters} title={onContacts ? "Filter contacts" : "Filter prospects"} onClose={closeFilters}>
        {onContacts ? (
          <FilterBoard key="contacts" rows={state.contacts} filters={contactQuick} ctx={NO_CONTEXT} picked={contactPicked} onPick={pickContact} onAll={() => setContactPicked(NO_PICKS)} />
        ) : (
          <FilterBoard key="prospects" rows={state.rows} filters={quick} ctx={filterContext} picked={picked} onPick={pick} onAll={() => setPicked(NO_PICKS)} status={{ counts, stages }} />
        )}
      </Pinboard>

      {/* the sheet: one card, its view controls on top and the grid below */}
      <div className="card mx-6 mb-6 flex min-h-0 flex-1 flex-col motion-safe:animate-page-in">
        <div className="flex flex-wrap items-center gap-2 rounded-t-[14px] border-b-2 border-rim/40 bg-paper-deep/40 px-4 py-2.5">
          {!onContacts && <ViewToggle view={view} onChange={setView} />}
          {!onContacts && view === "reading" && groupable.length > 0 && (
            <label className="ml-2 flex items-center gap-2 font-label text-[13px] text-mud-faint">
              Group by
              <select className="field h-9 w-auto py-0 pr-8 text-[13px]" value={groupKey ?? ""} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="">Nothing</option>
                {groupable.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
              </select>
            </label>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={!state.canUndo} onClick={() => { const l = state.undo(); if (l) toast(`Undid: ${l}`, { id: "undo" }); }} title="Undo (Ctrl+Z)">
            <Undo2 size={15} /> Undo
          </Button>
          {!onContacts && <Button size="sm" variant="primary" onClick={addRow}><Plus size={15} /> Add prospect</Button>}
        </div>

        {/* grid + drawer; the card stays unclipped so the toolbar's menus can overhang */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-[14px]">
          {/* Keyed by what it shows, so a new tab or view rises in; the prospect panel stays outside it. */}
          <div key={sheet} className={cn("h-full", sheetMoved.current && "motion-safe:animate-sheet-in")}>
          {onContacts ? (
            state.contacts.length === 0 ? (
              <EmptyContacts />
            ) : (
              <>
                {/* Keyed apart from the Prospects grid: its active cell and scroll are about other rows. */}
                <Grid
                  key="contacts"
                  columns={contactColumns}
                  rows={filteredContacts}
                  schema={contactGridSchema}
                  stages={stages}
                  pinned={Math.min(2, contactColumns.length)}
                  selected={selectedContacts}
                  onSelect={setSelectedContacts}
                  onEdit={state.editContacts}
                  onOpenRow={openContact}
                  onResize={(key, width) => {
                    const cs = contactSchema(schema);
                    if (key !== ORG_KEY) state.setSchema({ ...schema, contacts: { ...cs, columns: cs.columns.map((c) => (c.key === key ? { ...c, width } : c)) } }, "Resize column", false);
                  }}
                  sort={contactSort}
                  onSort={setContactSort}
                  openRowId={openContactId}
                  isLocked={isContactLocked}
                  pending={pendingKeys}
                  readOnlyKeys={CONTACT_FIXED}
                  openLabel="Open contact"
                />
                {filteredContacts.length === 0 && <NoMatch what="contacts" on={onNames} onClear={() => setContactPicked(NO_PICKS)} />}
              </>
            )
          ) : state.rows.length === 0 ? (
            <EmptyList onAdd={addRow} discovery={discovery.enabled ? { waiting: discovery.inbox.length, open: () => setShowDiscover(discovery.inbox.length ? "inbox" : discovery.runs.length ? "find" : "thesis") } : null} />
          ) : (
            <>
              {view === "reading" ? (
                <ProspectList rows={filtered} schema={schema} stages={stages} groupBy={groupKey} openRowId={openRowId} onOpenRow={showRow}
                  contactsOf={contactsOf} onOpenContact={openContact} pending={pendingKeys} />
              ) : (
              <Grid
                key="prospects"
                ref={grid}
                columns={columns}
                rows={filtered}
                schema={schema}
                stages={stages}
                pinned={pinnedCount(columns, schema)}
                selected={selected}
                onSelect={setSelected}
                onEdit={gridEdit}
                onOpenRow={showRow}
                onResize={(key, width) => state.setSchema({ ...schema, columns: schema.columns.map((c) => (c.key === key ? { ...c, width } : c)) }, "Resize column", false)}
                sort={sort}
                onSort={setSort}
                openRowId={openRowId}
                isLocked={isLocked}
                pending={pendingKeys}
                readOnlyKeys={idFixed}
              />
              )}
              {filtered.length === 0 && <NoMatch what="rows" on={onNames} onClear={() => setPicked(NO_PICKS)} />}
            </>
          )}
          </div>
          {drawer.shown && drawer.last && (
            <RowDrawer
              row={drawer.last.row}
              schema={schema}
              stages={stages}
              templates={state.templates}
              state={state}
              contacts={drawer.last.contacts}
              openContactId={drawer.last.contactId}
              leaving={drawer.leaving}
              onOpenContact={setOpenContactId}
              onClose={closeDrawer}
              onPrev={prevRow ? () => showRow(prevRow.id) : undefined}
              onNext={nextRow ? () => showRow(nextRow.id) : undefined}
              onOpenTemplates={() => setShowTemplates(true)}
              enrich={enrich}
            />
          )}
        </div>
      </div>

      <PanelGate open={showTemplates}>
        <TemplatesPanel schema={schema} rows={state.rows} contactsOf={contactsOf} templates={state.templates} thesis={state.thesis} consent={consent} state={state} previewRowId={openRowId} onClose={() => setShowTemplates(false)} />
      </PanelGate>
      <PanelGate open={showEnrich}>
        <EnrichPanel state={state} enrich={enrich} selectedIds={selectedActiveIds} filteredIds={filteredActiveIds}
          onClose={() => setShowEnrich(false)} onOpenReview={() => { setShowEnrich(false); setShowReview(true); }}
          onOpenRow={(id) => {
            setShowEnrich(false);
            // An intro run's rows are contacts: each opens as itself.
            if (rowById.get(id)?.parentId) openContact(id);
            else showRow(id);
          }} />
      </PanelGate>
      <PanelGate open={showReview}>
        <ReviewPanel state={state} enrich={enrich} onClose={() => setShowReview(false)} onOpenRow={showRow} />
      </PanelGate>
      <PanelGate open={!!showDiscover && discovery.enabled}>
        <DiscoverPanel state={state} enrich={enrich} discovery={discovery} initial={showDiscover ?? undefined} onClose={() => setShowDiscover(null)} />
      </PanelGate>
      <RemoveCampaignDialog campaign={removing ? campaign : null} onClose={() => setRemoving(false)}
        beforeRemove={state.flush} onRemoved={() => void navigate("/")} />
      <ConsentDialog open={!!consent.needsConsent} onConfirm={() => consent.needsConsent?.confirm()} onCancel={() => consent.needsConsent?.cancel()} />
      {onContacts ? (
        <ColumnsDialog key="contacts" open={showColumns} onClose={() => setShowColumns(false)} kind="contacts" schema={contactSchema(schema)} inSheet={inSheet} usedKeys={usedKeys}
          onSave={(s) => state.setSchema({ ...schema, contacts: { ...contactSchema(schema), columns: s.columns } })} />
      ) : (
        <ColumnsDialog key="prospects" open={showColumns} onClose={() => setShowColumns(false)} kind="prospects" schema={schema} inSheet={inSheet} usedKeys={usedKeys} onSave={(s) => state.setSchema(s)} />
      )}
    </div>
  );
}

function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="-ml-1.5 w-full max-w-xl truncate rounded-lg border-2 border-transparent bg-transparent px-1.5 font-display text-[26px] leading-tight font-bold outline-none transition hover:border-rim/50 focus:border-clay focus:bg-paper"
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

/** A row of buttons of which one is on: the tab switch and the view toggle. */
function Segmented<T extends string>({ value, onChange, options, tabs }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; icon: ReactNode; label: string; count?: number; title?: string }[];
  /** Tabs (with their ARIA roles), rather than a view setting. */
  tabs?: boolean;
}) {
  return (
    <div role={tabs ? "tablist" : undefined} className="flex gap-1 rounded-xl border-2 border-transparent bg-paper-deep/60 p-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          role={tabs ? "tab" : undefined}
          aria-selected={tabs ? value === o.value : undefined}
          aria-pressed={tabs ? undefined : value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border-2 px-3 text-[13px] font-bold transition",
            value === o.value ? "border-rim/40 bg-paper text-mud shadow-[0_2px_0_0_color-mix(in_oklab,var(--color-rim)_40%,transparent),0_4px_10px_-4px_rgba(43,30,22,0.22)]" : "border-transparent text-mud-faint hover:text-mud",
          )}
        >
          {o.icon} {o.label}{o.count !== undefined && <span className="font-label font-normal opacity-70 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Prospects or their contacts: the two lists of the campaign, as the workbook's two tabs. */
function TabSwitch({ tab, onChange, prospects, contacts }: { tab: Tab; onChange: (t: Tab) => void; prospects: number; contacts: number }) {
  return (
    <Segmented tabs value={tab} onChange={onChange} options={[
      { value: "prospects", icon: <Building2 size={15} />, label: "Prospects", count: prospects },
      { value: "contacts", icon: <Users size={15} />, label: "Contacts", count: contacts },
    ]} />
  );
}

function ViewToggle({ view, onChange }: { view: "table" | "reading"; onChange: (v: "table" | "reading") => void }) {
  return (
    <Segmented value={view} onChange={onChange} options={[
      { value: "table", icon: <Table2 size={15} />, label: "Table", title: "Table view" },
      { value: "reading", icon: <Rows3 size={15} />, label: "Reading", title: "Reading view" },
    ]} />
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

/**
 * Opens the filter drawer: grey at rest, yellow with how many filters are on, as their cards are.
 * `on` names them, for its tooltip.
 */
function FilterButton({ open, on, onClick }: { open: boolean; on: string[]; onClick: () => void }) {
  const n = on.length;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      // Read out as "Filter, 2 on", not "Filter2".
      aria-label={n ? `Filter, ${n} on` : "Filter"}
      title={n ? `On: ${on.join(", ")}` : "Filter the list"}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 rounded-lg border-2 px-3 font-label text-[13px] transition",
        n ? "border-rim bg-note font-bold text-mud shadow-hard-sm" : "border-rim/40 bg-paper-deep text-mud-soft hover:border-rim hover:text-mud",
      )}
    >
      <ListFilter size={15} /> Filter
      {n > 0 && <span className="opacity-70 tabular-nums">{n}</span>}
    </button>
  );
}

/** How many prospects in play hold each status, and how many are screened out. */
interface StatusCounts { byStatus: Record<string, number>; screened: number }
/** A card on the filter board, by the filter it turns on and off. */
type FilterCard = Omit<PinToggleProps, "index"> & { id: string };

/**
 * The filter drawer's board: All and the statuses (the Prospects tab's; the Contacts tab has
 * none), then the quick filters, each a card turned on and off with how many rows it shows.
 * Mounted only while the drawer is, so its counts are worked out only then.
 */
function FilterBoard({ rows, filters, ctx, picked, onPick, onAll, status }: {
  rows: Row[]; filters: QuickFilter[]; ctx: FilterContext; picked: ReadonlySet<string>; onPick: (id: string) => void; onAll: () => void;
  status?: { counts: StatusCounts; stages: string[] };
}) {
  const counted = useQuickCounts(filters, rows, ctx);
  // Like a stage's, a card with nothing to show is left out, unless it is on; and once on the
  // board it stays there until the drawer closes, so turning it off doesn't shift the cards (and
  // their lean) under the pointer. `has` is what it is shown for, when not its own count.
  const kept = useRef(new Set<string>()).current;
  const card = (id: string, count: number, title?: string, has = count): FilterCard[] => {
    if (!has && !picked.has(id) && !kept.has(id)) return [];
    kept.add(id);
    return [{ id, label: pickLabel(id, filters), count, title, active: picked.has(id), onClick: () => onPick(id) }];
  };
  const all: FilterCard = { id: ALL, label: pickLabel(ALL, filters), count: rows.length, active: !picked.size, onClick: onAll };
  const todo = filters.flatMap((f, i) => card(QUICK + f.id, counted[i]!, f.title));
  // Numbered across both groups, so no two neighbours lean the same way.
  const pin = (cards: FilterCard[], from = 0) => cards.map(({ id, ...c }, i) => <PinToggle key={id} index={from + i} {...c} />);
  if (!status) return <PinGroup label="Contacts">{pin([all, ...todo])}</PinGroup>;

  const { counts: { byStatus, screened }, stages } = status;
  // The statuses the sheet holds beyond the pipeline's, and any on (or kept) that no prospect holds any more.
  const known = new Set([...stages, DEAD, NOT_SET]);
  const others = [...new Set([...Object.keys(byStatus), ...picked, ...kept])].filter((s) => isStatusPick(s) && !known.has(s));
  const statuses = [
    all,
    ...card(IN_PLAY, rows.length - screened, "Everything but the screened-out prospects", screened),
    ...[...stages, DEAD, ...others, NOT_SET].flatMap((s) => card(s, byStatus[s] ?? 0)),
    ...card(SCREENED, screened),
  ];
  return (
    <>
      <PinGroup label="Status">{pin(statuses)}</PinGroup>
      {todo.length > 0 && <PinGroup label="Quick filters">{pin(todo, statuses.length)}</PinGroup>}
    </>
  );
}

/**
 * An empty list's note. The filters' cards are out of sight in their drawer: it names the ones on
 * (restoring the last screened-out prospect leaves Screened out on, over nothing) and turns them off.
 */
function NoMatch({ what, on, onClear }: { what: string; on: string[]; onClear: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 flex flex-col items-center gap-3 px-6 text-center text-[15px] text-mud-faint">
      <p>No {what} match.</p>
      {on.length > 0 && (
        <>
          <p className="font-label text-[13px]">Filtered by <span className="font-bold text-mud-soft">{on.join(", ")}</span></p>
          <Button size="sm" className="pointer-events-auto" onClick={onClear}>Clear filters</Button>
        </>
      )}
    </div>
  );
}

/**
 * How many rows pass each quick filter. Counted apart by what each filter reads beyond the row: a
 * run's progress recounts only the filter that reads the runs, and a contact's edit only the one
 * that reads the contacts.
 */
function useQuickCounts(filters: QuickFilter[], rows: Row[], ctx: FilterContext): number[] {
  const { contactsOf, ran } = ctx;
  const byRow = useMemo(() => countPassing(filters, rows, undefined, NO_CONTEXT), [filters, rows]);
  const byContacts = useMemo(() => countPassing(filters, rows, "contactsOf", { ...NO_CONTEXT, contactsOf }), [filters, rows, contactsOf]);
  const byRuns = useMemo(() => countPassing(filters, rows, "ran", { ...NO_CONTEXT, ran }), [filters, rows, ran]);
  return useMemo(() => filters.map((_, i) => byRow[i]! + byContacts[i]! + byRuns[i]!), [filters, byRow, byContacts, byRuns]);
}

/** How many rows pass each filter that reads `reads` (undefined: the row alone); 0 for the others. */
function countPassing(filters: QuickFilter[], rows: Row[], reads: QuickFilter["reads"], ctx: FilterContext): number[] {
  return filters.map((f) => (f.reads === reads ? rows.reduce((n, r) => (f.test(r, ctx) ? n + 1 : n), 0) : 0));
}

/** No prospects yet. A Discovery campaign's come from its inbox; any other's are typed or pasted. */
function EmptyList({ onAdd, discovery }: { onAdd: () => void; discovery: { waiting: number; open: () => void } | null }) {
  if (discovery) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Radar className="text-clay" size={40} strokeWidth={2.2} />
        <p className="font-display text-xl font-bold">{discovery.waiting ? `${discovery.waiting} compan${discovery.waiting === 1 ? "y" : "ies"} waiting in the Discovery inbox` : "Discovery hasn't run yet"}</p>
        <p className="max-w-sm text-[14px] text-mud-faint">Your prospects will appear here once you accept them from the Discovery inbox.</p>
        <div className="mt-3 flex gap-3">
          <Button variant="primary" onClick={discovery.open}><Radar size={16} /> {discovery.waiting ? "Open inbox" : "Open Discover"}</Button>
          <Button variant="ghost" onClick={onAdd}><Plus size={16} /> Add one by hand</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <FileSpreadsheet className="text-clay" size={40} strokeWidth={2.2} />
      <p className="font-display text-xl font-bold">No prospects yet</p>
      <p className="max-w-sm text-[14px] text-mud-faint">Add your first prospect, or paste rows straight from Excel into the grid.</p>
      <Button variant="primary" className="mt-3" onClick={onAdd}><Plus size={16} /> Add prospect</Button>
    </div>
  );
}

function EmptyContacts() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Users className="text-clay" size={40} strokeWidth={2.2} />
      <p className="font-display text-xl font-bold">No contacts yet</p>
      <p className="max-w-sm text-[14px] text-mud-faint">Open a prospect and add its people there: who holds the budget, who evaluates, who uses it. Everyone you add is listed here.</p>
    </div>
  );
}

/** The selection count. */
function SelectionCount({ n }: { n: number }) {
  return <span className="text-[15px] font-extrabold">{n} selected</span>;
}

/** Actions on the selected contacts. */
function ContactBulkBar({ rows, state, enrich, onDone }: { rows: Row[]; state: CampaignState; enrich: EnrichmentState; onDone: () => void }) {
  const n = rows.length;
  const label = `${n} ${n === 1 ? "contact" : "contacts"}`;
  // A contact whose intro is being written stays until it's done.
  const drafting = rows.some((r) => enrich.drafting.has(r.id));
  return (
    <>
      <SelectionCount n={n} />
      <Button size="sm" variant="danger" disabled={drafting} title={drafting ? "An intro to one of them is being written: stop it or wait for it first" : undefined} onClick={() => {
        state.deleteRows(rows.map((r) => r.id), `Delete ${label}`);
        onDone();
        undoToast(`Deleted ${label}`, () => state.undo());
      }}>
        <Trash2 size={13} /> Delete
      </Button>
    </>
  );
}

/**
 * Actions on the selected rows. A selection can mix prospects in play with screened-out ones:
 * Screen out, Set status and Enrich take the ones in play, Restore the screened-out ones, Delete
 * all of them.
 */
function BulkBar({ rows, schema, stages, state, enrich, onEnrich, onDone }: {
  rows: Row[]; schema: CampaignSchema; stages: string[]; state: CampaignState; enrich: EnrichmentState; onEnrich: () => void; onDone: () => void;
}) {
  const active = rows.filter((r) => !isScreened(r, schema));
  const activeIds = active.map((r) => r.id);
  const screenedIds = rows.filter((r) => isScreened(r, schema)).map((r) => r.id);
  // A prospect with an intro being written to one of its contacts stays until it's done.
  const draftingOrgs = new Set([...enrich.drafting].map((id) => state.rowById.get(id)?.parentId));
  const drafting = draftingOrgs.size > 0 && rows.some((r) => draftingOrgs.has(r.id));
  const count = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  const setStatus = (stage: string) => {
    const label = count(active.length);
    onDone();
    if (state.edit(active.flatMap((r) => stageEdits(r, schema, stage)), `Set ${label} to ${stage}`)) {
      undoToast(`${label} set to ${stage}`, () => state.undo());
    }
  };
  return (
    <>
      <SelectionCount n={rows.length} />
      {activeIds.length > 0 && (
        <>
          <ScreenOutButton count={activeIds.length} onConfirm={(reason) => {
            onDone();
            if (state.screenOut(activeIds, reason)) undoToast(`Screened out ${count(activeIds.length)}`, () => state.undo());
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
          <Button size="sm" variant="subtle" onClick={onEnrich}><Sparkles size={13} /> Enrich</Button>
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
      <Button size="sm" variant="danger" disabled={drafting} title={drafting ? "An intro to one of their contacts is being written: stop it or wait for it first" : undefined} onClick={() => {
        state.deleteRows(rows.map((r) => r.id));
        onDone();
        undoToast(`Deleted ${count(rows.length)}`, () => state.undo());
      }}>
        <Trash2 size={13} /> Delete
      </Button>
    </>
  );
}
