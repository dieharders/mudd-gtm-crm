import {
  ArchiveRestore, Building2, Columns3, FileSpreadsheet, FolderOpen, Inbox, ListChecks, Loader2, MessageSquareText, MoreHorizontal, Plus,
  Loader2 as Spinner, MessageSquarePlus, Radar, Rows3, Search, Sparkles, Table2, Trash2, TriangleAlert, Undo2, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { allColumns, contactSchema, orgColumn } from "../../../shared/schema";
import {
  DEAD, isChecked, isScreened, ORG_KEY, stagesOf, type CampaignSchema, type CellEdit, type CellValue, type Column, type Row,
} from "../../../shared/types";
import { sameValue } from "../../../shared/values";
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
import { campaignTileFor, toneFor } from "../../lib/stages";
import { useCampaignList } from "../../lib/campaignList";
import { Tile } from "../ui/Logo";
import { display } from "../grid/cells";
import { Grid, type GridHandle, type SortState } from "../grid/Grid";
import { ProspectList } from "../list/ProspectList";
import { DRAWER_LEAVE_MS, RowDrawer } from "../row/RowDrawer";
import { cardLayout, groupableColumns, pinnedCount } from "../../lib/listLayout";
import { TemplatesPanel } from "../templates/TemplatesPanel";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { PinCard, Pinboard, PinGroup, type PinCardProps } from "../ui/Pinboard";
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
const NO_PICKS: ReadonlySet<string> = new Set();
/** A chip that is a status: a stage, another status the sheet holds, or No status. */
const isStatusPick = (p: string) => p !== IN_PLAY && p !== SCREENED && !p.startsWith(QUICK);

/** Turn a chip on or off. In play and Screened out rule each other out: one turns the other off. */
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
 * Let go of the selection whenever rows join or leave the list (an edit moving them past the
 * chips, a delete, an add), so none of it is left out of sight and out of the header checkbox's
 * reach. A new order, or a run filling in cells, keeps it.
 */
function useClearOnNewRows(rows: Row[], setSelected: (update: (s: Set<string>) => Set<string>) => void) {
  const shown = useRef<Set<string> | null>(null);
  useEffect(() => {
    const was = shown.current;
    shown.current = new Set(rows.map((r) => r.id));
    if (was && (was.size !== rows.length || rows.some((r) => !was.has(r.id)))) setSelected((s) => (s.size ? new Set() : s));
  }, [rows, setSelected]);
}
// Sorting compares every pair of rows: one collator for all of them, not new options per call.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NO_KEYS = new Set<string>();
const NO_ROWS: Row[] = [];
/** What a chip that reads no context is tested with: it never looks. */
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
  const stages = useMemo(() => stagesOf(schema), [schema]);
  const [params, setParams] = useSearchParams();
  const initialRow = params.get("row");
  const initialDiscover = params.get("discover");
  const [query, setQuery] = useState("");
  // The chips that are on, none being All. Statuses (and Screened out) widen each other, as a
  // prospect has one status; In play and the quick filters each narrow what those leave.
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
  const [view, setView] = useStoredState<"table" | "reading">(`mudd:view:${campaign.id}`, "table");
  const [stored, setTab] = useStoredState<Tab>(`mudd:tab:${campaign.id}`, "prospects");
  const tab: Tab = stored === "contacts" ? "contacts" : "prospects";
  const onContacts = tab === "contacts";
  const groupable = useMemo(() => groupableColumns(schema), [schema]);
  const [groupBy, setGroupBy] = useStoredState<string>(`mudd:group:${campaign.id}`, cardLayout(schema).tierKey ?? "");
  const groupKey = groupable.some((c) => c.key === groupBy) ? groupBy : null;

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
  // A status as its chip: the stage it names, in any case ("contacted" is Contacted).
  const chipOf = useMemo(() => {
    const byLower = new Map([...stages, DEAD].map((s) => [s.toLowerCase(), s]));
    return (row: Row) => {
      const s = statusKey ? display(row.cells[statusKey]).trim() : "";
      return s ? byLower.get(s.toLowerCase()) ?? s : NOT_SET;
    };
  }, [stages, statusKey]);
  // All counts every prospect, as the list shows them; a status chip counts only those of its
  // status still in play, and the screened-out ones have a chip of their own.
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

  // The statuses the sheet holds beyond the pipeline's, and any picked one no prospect holds any
  // more: like a stage's, its chip stays while it is on.
  const otherStatuses = useMemo(() => {
    const known = new Set([...stages, DEAD, NOT_SET]);
    return [...new Set([...Object.keys(counts.byStatus), ...[...picked].filter(isStatusPick)])].filter((s) => !known.has(s));
  }, [counts, picked, stages]);

  const { contactsOf } = state;
  const { recipes, runs } = enrich;
  const today = useToday();
  const ran = useMemo(() => runsThrough(runs), [runs]);
  const filterContext = useMemo<FilterContext>(() => ({ contactsOf, ran }), [contactsOf, ran]);
  const q = query.trim().toLowerCase();
  // Read only while searching: a contact's edit then leaves the prospect list (and its sort) be.
  const searchedContactsOf = q ? contactsOf : null;
  const quick = useMemo(() => prospectFilters(schema, stages, recipes, today), [schema, stages, recipes, today]);
  // The same for the chips: only one that is on and reads the contacts (or the runs) filters the
  // list again on a contact's edit (or a run's progress).
  const reading = new Set(quick.filter((f) => f.reads && picked.has(QUICK + f.id)).map((f) => f.reads));
  const readContactsOf = reading.has("contactsOf") ? contactsOf : null;
  const readRan = reading.has("ran") ? ran : null;
  // Whether a prospect passes the chips that are on; null when All is. The chips are the
  // Prospects tab's: hidden on the Contacts tab, they filter nothing there.
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
      if ((statuses.size || screenedOn) && !(screened ? screenedOn : !!statusKey && statuses.has(chipOf(r)))) return false;
      return tests.every((t) => t(r, ctx));
    };
  }, [onContacts, picked, quick, schema, statusKey, chipOf, readContactsOf, readRan]);
  const filtered = useMemo(() => {
    let list = state.rows;
    if (passes) list = list.filter(passes);
    // A prospect matches on its own cells or any of its people's.
    if (searchedContactsOf) list = list.filter((r) => cellsHit(r.cells, q) || searchedContactsOf(r.id).some((c) => cellsHit(c.cells, q)));
    return sortRows(list, sort, schema, stages);
  }, [state.rows, passes, q, sort, schema, stages, searchedContactsOf]);

  // ----- the Contacts tab: every prospect's people, with the prospect's company beside them -----
  // Worked out only while the tab is open: every contact is copied to add its company.
  const contactGridSchema = useMemo<CampaignSchema>(() => {
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
  // The contacts' chips read only the contact.
  const filteredContacts = useMemo(() => {
    const on = contactQuick.filter((f) => contactPicked.has(QUICK + f.id));
    const list = contactRows.filter((r) => on.every((f) => f.test(r, NO_CONTEXT)) && (!q || cellsHit(r.cells, q)));
    return sortRows(list, contactSort, contactGridSchema, stages);
  }, [contactRows, contactQuick, contactPicked, q, contactSort, contactGridSchema, stages]);
  // A chip no longer offered can't stay on unseen, filtering by nothing while All shows off.
  useEffect(() => setPicked((p) => keepOffered(p, quick)), [quick]);
  useEffect(() => setContactPicked((p) => keepOffered(p, contactQuick)), [contactQuick]);
  useClearOnNewRows(filtered, setSelected);
  useClearOnNewRows(filteredContacts, setSelectedContacts);
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
  const drawer = useLeaving(!!openRow, DRAWER_LEAVE_MS);
  const lastOpen = useRef<{ row: Row; contacts: Row[]; contactId: string | null } | null>(null);
  if (openRow) lastOpen.current = { row: openRow, contacts: contactsOf(openRow.id), contactId: openContactId };
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
    // A blank prospect may still miss the chips that are on (a quick filter, Screened out):
    // back to All, rather than have it vanish as soon as it is added.
    if (passes && !passes(row)) setPicked(NO_PICKS);
    if (view === "reading") showRow(row.id);
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
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 px-6 pt-6 pb-3">
        <Tile size="lg" className={cn("text-lg", campaignTileFor(campaign.id))}>{campaign.name.trim()[0]?.toUpperCase() ?? "?"}</Tile>
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
              ...(discovery.enabled ? [{ tone: "bg-clay-soft", icon: <Radar size={18} />, label: "Discover", hint: "Find new prospects", onClick: pick(() => setShowDiscover(discovery.inbox.length ? "inbox" : "find")) }] : []),
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
      <div className="flex min-h-16 flex-wrap items-center gap-3 px-6 pt-3 pb-16">
        {onContacts && selectedContactRows.length > 0 ? (
          <ContactBulkBar rows={selectedContactRows} state={state} onDone={() => setSelectedContacts(new Set())} />
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
            {!onContacts && (statusKey || counts.screened > 0 || quick.length > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                <Chip active={!picked.size} onClick={() => setPicked(NO_PICKS)} label="All" count={state.rows.length} />
                {counts.screened > 0 || picked.has(IN_PLAY) ? (
                  <Chip active={picked.has(IN_PLAY)} onClick={() => pick(IN_PLAY)} label="In play" count={state.rows.length - counts.screened} title="Everything but the screened-out prospects" />
                ) : null}
                {[...stages, DEAD].map((s) => (counts.byStatus[s] || picked.has(s) ? (
                  <Chip key={s} active={picked.has(s)} onClick={() => pick(s)} label={s} count={counts.byStatus[s] ?? 0} />
                ) : null))}
                {otherStatuses.map((s) => (
                  <Chip key={s} active={picked.has(s)} onClick={() => pick(s)} label={s} count={counts.byStatus[s] ?? 0} />
                ))}
                {counts.byStatus[NOT_SET] || picked.has(NOT_SET) ? <Chip active={picked.has(NOT_SET)} onClick={() => pick(NOT_SET)} label="No status" count={counts.byStatus[NOT_SET] ?? 0} /> : null}
                {/* Kept while it is on: restoring the last one leaves an empty list, still explained. */}
                {counts.screened > 0 || picked.has(SCREENED) ? (
                  <Chip active={picked.has(SCREENED)} onClick={() => pick(SCREENED)} label="Screened out" count={counts.screened} />
                ) : null}
                <QuickChips filters={quick} rows={state.rows} ctx={filterContext} picked={picked} onPick={pick} />
              </div>
            )}
            {onContacts && contactQuick.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Chip active={!contactPicked.size} onClick={() => setContactPicked(NO_PICKS)} label="All" count={state.contacts.length} />
                <QuickChips filters={contactQuick} rows={state.contacts} ctx={NO_CONTEXT} picked={contactPicked} onPick={pickContact} />
              </div>
            )}
          </>
        )}
      </div>

      {/* the sheet: one card, its view controls on top and the grid below */}
      <div className="card mx-6 mb-6 flex min-h-0 flex-1 flex-col">
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
                {filteredContacts.length === 0 && (
                  <div className="pointer-events-none absolute inset-x-0 top-24 text-center text-[15px] text-mud-faint">No contacts match.</div>
                )}
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
              {filtered.length === 0 && (
                <div className="pointer-events-none absolute inset-x-0 top-24 text-center text-[15px] text-mud-faint">No rows match.</div>
              )}
            </>
          )}
          {drawer.shown && lastOpen.current && (
            <RowDrawer
              row={lastOpen.current.row}
              schema={schema}
              stages={stages}
              templates={state.templates}
              state={state}
              contacts={lastOpen.current.contacts}
              openContactId={lastOpen.current.contactId}
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

      {showTemplates && (
        <TemplatesPanel schema={schema} rows={state.rows} contactsOf={contactsOf} templates={state.templates} thesis={state.thesis} consent={consent} state={state} previewRowId={openRowId} onClose={() => setShowTemplates(false)} />
      )}
      {showEnrich && (
        <EnrichPanel state={state} enrich={enrich} selectedIds={selectedActiveIds} filteredIds={filtered.filter((r) => !isScreened(r, schema)).map((r) => r.id)}
          onClose={() => setShowEnrich(false)} onOpenReview={() => { setShowEnrich(false); setShowReview(true); }} onOpenRow={(id) => { setShowEnrich(false); showRow(id); }} />
      )}
      {showReview && <ReviewPanel state={state} enrich={enrich} onClose={() => setShowReview(false)} onOpenRow={showRow} />}
      {showDiscover && discovery.enabled && (
        <DiscoverPanel state={state} enrich={enrich} discovery={discovery} initial={showDiscover} onClose={() => setShowDiscover(null)} />
      )}
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

/** A filter chip: grey at rest, yellow while it is on. */
function Chip({ active, onClick, label, count, title }: { active: boolean; onClick: () => void; label: string; count: number; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-lg border-2 px-3 font-label text-[13px] transition",
        active ? "border-rim bg-note font-bold text-mud shadow-hard-sm" : "border-rim/40 bg-paper-deep text-mud-soft hover:border-rim hover:text-mud",
      )}
    >
      {label}
      <span className="opacity-70 tabular-nums">{count}</span>
    </button>
  );
}

/**
 * The quick filters' chips, among the status chips and turned on and off the same way.
 * Like a stage's, a chip with nothing to show is left out, unless it is on.
 */
function QuickChips({ filters, rows, ctx, picked, onPick }: {
  filters: QuickFilter[]; rows: Row[]; ctx: FilterContext; picked: ReadonlySet<string>; onPick: (id: string) => void;
}) {
  const counts = useMemo(() => filters.map((f) => rows.reduce((n, r) => (f.test(r, ctx) ? n + 1 : n), 0)), [filters, rows, ctx]);
  return filters.map((f, i) => {
    const id = QUICK + f.id;
    if (!counts[i] && !picked.has(id)) return null;
    return <Chip key={f.id} active={picked.has(id)} onClick={() => onPick(id)} label={f.label} count={counts[i]!} title={f.title} />;
  });
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
function ContactBulkBar({ rows, state, onDone }: { rows: Row[]; state: CampaignState; onDone: () => void }) {
  const n = rows.length;
  const label = `${n} ${n === 1 ? "contact" : "contacts"}`;
  return (
    <>
      <SelectionCount n={n} />
      <Button size="sm" variant="danger" onClick={() => {
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
 * Screen out, Set status, Enrich and Draft intros take the ones in play, Restore the screened-out
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
    onDone();
    if (state.edit(active.flatMap((r) => stageEdits(r, schema, stages, stage).edits), `Set ${label} to ${stage}`)) {
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
          {schema.introKey && (
            <Button size="sm" variant="subtle" disabled={!state.templates.length} title={state.templates.length ? "Write an intro for each selected prospect from your templates" : "Add an intro template first"}
              onClick={() => fire(enrich.start({ kind: "intro", rowIds: activeIds, intro: { templateId: "auto" }, concurrency: 2 }).then((run) => {
                if (run) toast.success(`Drafting ${activeIds.length} intro${activeIds.length === 1 ? "" : "s"}. They'll appear under Review.`);
              }))}>
              <MessageSquarePlus size={13} /> Draft intros
            </Button>
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
    </>
  );
}
