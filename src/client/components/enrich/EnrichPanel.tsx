/**
 * Enrich with AI — the Altclay-style recipe flow:
 *   1. pick a preset or write a recipe: what to find, which columns to send, which to fill
 *   2. test it on 3 rows and look at what comes back
 *   3. run it on the rest, with pause / resume / stop, and review the suggestions
 */
import { Anchor, Building2, FlaskConical, Globe, Mail, Newspaper, Plus, Rocket, Sparkles, Trash2, UserRound, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { presetRecipe, PRESETS, type Preset } from "../../../shared/presets";
import { isSourcesColumn, recipeMode, type EnrichRun, type Recipe } from "../../../shared/ai";
import { allColumns, columnOf, contactRecordKeys, contactSchema, typeFromHeader } from "../../../shared/schema";
import { COLUMN_TYPES, isScreened, type CampaignSchema, type CellValue, type ColumnType, type Row } from "../../../shared/types";
import { primaryOf, researchedContacts } from "../../../shared/values";
import type { CampaignState } from "../../hooks/useCampaign";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import type { RecipeDraft } from "../../lib/api";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { Button } from "../ui/Button";
import { Panel, railItem } from "../ui/Panel";
import { Tile } from "../ui/Logo";
import { RunProgress } from "./RunProgress";
import { fire } from "../../lib/fire";

const NEW = "__new";
/** A new column among the contact columns: for a person's detail, filled on the primary contact. */
const NEW_CONTACT = "__newcontact";
const isNew = (target: string) => target === NEW || target === NEW_CONTACT;
const PRESET_ICONS = { building: Building2, news: Newspaper, person: UserRound, mail: Mail, hook: Anchor };

interface OutputDraft {
  target: string;
  header: string;
  hint: string;
  type: ColumnType;
  options?: string[];
}

interface Draft {
  name: string;
  instructions: string;
  inputKeys: string[];
  outputs: OutputDraft[];
  webSearch: boolean;
  /** The preset it was started from, kept so Discovery can reuse the saved recipe. */
  presetId?: string;
}

type Selection = { kind: "recipe"; id: string } | { kind: "draft"; from: string } | { kind: "run"; id: string } | null;

/** The type import gives a column with this header. A new column's type follows its header
 *  until the user picks one, so re-importing the export types it the same. */
const headerType = (header: string): ColumnType => typeFromHeader(header)?.type ?? "text";

/** A preset as the editor shows it: the same recipe the server makes from it (presetRecipe). */
function draftFromPreset(p: Preset, schema: CampaignSchema, rows: Row[]): Draft {
  const r = presetRecipe(p, schema, rows);
  return {
    name: r.name,
    instructions: r.instructions,
    inputKeys: r.inputKeys,
    webSearch: r.webSearch,
    presetId: r.presetId,
    outputs: r.outputs.map((o) => ({
      target: o.key ?? (o.contact ? NEW_CONTACT : NEW),
      header: o.header,
      hint: o.hint ?? "",
      type: o.type ?? headerType(o.header),
      options: o.options,
    })),
  };
}

function draftFromRecipe(r: Recipe, schema: CampaignSchema): Draft {
  return {
    name: r.name,
    instructions: r.instructions,
    inputKeys: r.inputKeys,
    webSearch: r.webSearch,
    presetId: r.presetId,
    outputs: r.outputs.map((o) => {
      const col = columnOf(schema, o.key);
      return { target: col ? o.key : NEW, header: col?.header ?? o.header, hint: o.hint ?? "", type: col?.type ?? headerType(o.header) };
    }),
  };
}

const blankDraft = (): Draft => ({ name: "", instructions: "", inputKeys: [], outputs: [{ target: NEW, header: "", hint: "", type: "text" }], webSearch: true });

function toApi(d: Draft): RecipeDraft {
  return {
    name: d.name.trim() || "Untitled recipe",
    instructions: d.instructions,
    inputKeys: d.inputKeys,
    webSearch: d.webSearch,
    ...(d.presetId ? { presetId: d.presetId } : {}),
    outputs: d.outputs
      .filter((o) => o.header.trim())
      .map((o) => ({
        key: isNew(o.target) ? undefined : o.target, header: o.header.trim(), hint: o.hint, type: o.type, options: o.options,
        ...(o.target === NEW_CONTACT ? { contact: true } : {}),
      })),
  };
}

export function EnrichPanel({ state, enrich, selectedIds, selectionLabel, filteredIds, onClose, onOpenReview, onOpenRow }: {
  state: CampaignState;
  enrich: EnrichmentState;
  selectedIds: string[];
  /** What the selection scope is called: "Selected rows" unless said otherwise. */
  selectionLabel?: string;
  filteredIds: string[];
  onClose: () => void;
  onOpenReview: () => void;
  onOpenRow: (id: string) => void;
}) {
  const schema = state.campaign!.schema;
  const ai = useAi();
  const { ready } = useActiveProvider();
  const [sel, setSel] = useState<Selection>(() => {
    const live = enrich.activeRuns.find((r) => r.kind === "enrich");
    if (live?.recipeId) return { kind: "recipe", id: live.recipeId };
    return enrich.recipes[0] ? { kind: "recipe", id: enrich.recipes[0].id } : null;
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const recipe = sel?.kind === "recipe" ? enrich.recipes.find((r) => r.id === sel.id) ?? null : null;
  useEffect(() => {
    if (sel?.kind === "recipe" && recipe) {
      setDraft(draftFromRecipe(recipe, schema));
      setDirty(false);
    }
    // Only when the selection changes, not on every schema tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.kind === "recipe" ? sel.id : null, recipe?.updatedAt]);

  const pick = (s: Selection, d?: Draft) => {
    setSel(s);
    if (d) {
      setDraft(d);
      setDirty(true);
    }
  };
  const change = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  const save = async (): Promise<Recipe | null> => {
    if (!draft) return null;
    if (!draft.instructions.trim()) {
      toast.error("Describe what to find.");
      return null;
    }
    if (!draft.outputs.some((o) => o.header.trim())) {
      toast.error("Add at least one column to fill.");
      return null;
    }
    setSaving(true);
    try {
      const r = await enrich.saveRecipe(toApi(draft), recipe);
      setSel({ kind: "recipe", id: r.id });
      setDraft(draftFromRecipe(r, state.campaign!.schema));
      setDirty(false);
      return r;
    } catch (err) {
      toast.error((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const shownRun: EnrichRun | null = useMemo(() => {
    if (sel?.kind === "run") return enrich.runs.find((r) => r.id === sel.id) ?? null;
    if (recipe) return enrich.runs.find((r) => r.recipeId === recipe.id) ?? null;
    return null;
  }, [sel, recipe, enrich.runs]);

  return (
    <Panel
      onClose={onClose}
      closeLabel="Close enrich"
      icon={<Tile size="lg" className="border-2 border-rim bg-clay-soft text-clay-deep"><Sparkles size={20} /></Tile>}
      title="Enrich with AI"
      subtitle="Research every prospect and fill columns, with a source for each finding."
    >
        <div className="flex min-h-0 flex-1">
          {/* left rail */}
          <aside className="w-64 shrink-0 space-y-5 overflow-y-auto border-r-2 border-rim/40 bg-paper-deep/40 p-3 scroll-thin">
            <div>
              <p className="eyebrow mb-1.5 px-1">Your recipes</p>
              {enrich.recipes.length === 0 && <p className="px-1 text-xs text-mud-faint">None yet. Start from a preset below.</p>}
              <ul className="space-y-0.5">
                {enrich.recipes.map((r) => {
                  const running = enrich.activeRuns.some((x) => x.recipeId === r.id);
                  return (
                    <li key={r.id} className="group relative">
                      <button onClick={() => pick({ kind: "recipe", id: r.id })} className={cn(railItem(sel?.kind === "recipe" && sel.id === r.id), "block pr-9")}>
                        <span className="flex items-center gap-1.5 truncate text-[15px] font-extrabold">
                          {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-clay" />}{r.name}
                        </span>
                        <span className="block truncate text-[11px] text-mud-faint">Fills {r.outputs.map((o) => o.header).join(", ")}</span>
                      </button>
                      <button title="Delete recipe" className="absolute top-2 right-1.5 rounded-sm p-1 text-mud-faint opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600"
                        onClick={() => fire(enrich.deleteRecipe(r.id).then(() => {
                          if (sel?.kind === "recipe" && sel.id === r.id) setSel(null);
                        }))}>
                        <Trash2 size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <p className="eyebrow mb-1.5 px-1">Start from a preset</p>
              <div className="space-y-1.5">
                {PRESETS.map((p) => (
                  <button key={p.id} onClick={() => pick({ kind: "draft", from: p.id }, draftFromPreset(p, schema, [...state.rows, ...state.contacts]))}
                    className={cn("flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition", sel?.kind === "draft" && sel.from === p.id ? "border-clay bg-clay-soft/50" : "border-rim/40 bg-paper hover:border-clay")}>
                    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", p.tone)}>{(() => { const I = PRESET_ICONS[p.icon]; return <I size={14} />; })()}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{p.name}</span>
                      <span className="block text-[11px] leading-snug text-mud-faint">{p.blurb}</span>
                    </span>
                  </button>
                ))}
                <button onClick={() => pick({ kind: "draft", from: "blank" }, blankDraft())}
                  className="flex w-full items-center gap-2 rounded-xl border border-dashed border-rim/60 px-2.5 py-2 text-left text-[13px] text-mud-soft hover:border-clay hover:text-clay-deep">
                  <Plus size={14} /> Blank recipe
                </button>
              </div>
            </div>

            {enrich.runs.length > 0 && (
              <div>
                <p className="eyebrow mb-1.5 px-1">Recent runs</p>
                <ul className="space-y-0.5">
                  {enrich.runs.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      <button onClick={() => setSel({ kind: "run", id: r.id })} className={cn("w-full rounded-lg px-2.5 py-1.5 text-left", sel?.kind === "run" && sel.id === r.id ? "bg-clay-soft/60" : "hover:bg-paper-deep")}>
                        <span className="block truncate text-xs font-medium">{r.label}{r.test ? " · test" : ""}</span>
                        <span className="block truncate text-[11px] text-mud-faint">{r.status} · {r.completed}/{r.total} · {timeAgo(r.startedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>

          {/* main */}
          <div className="min-w-0 flex-1 overflow-y-auto p-5 scroll-thin">
            {sel?.kind === "run" && shownRun ? (
              <RunProgress run={shownRun} rowById={state.rowById} schema={schema} contactsOf={state.contactsOf} onAction={(a) => fire(enrich.action(shownRun.id, a))} onReview={onOpenReview}
                pending={enrich.suggestions.filter((s) => s.runId === shownRun.id).length} onOpenRow={onOpenRow} />
            ) : draft && (sel?.kind === "recipe" || sel?.kind === "draft") ? (
              <div className="space-y-5">
                <RecipeEditor draft={draft} schema={schema} onChange={change} />
                <div className="flex items-center gap-2">
                  {(dirty || !recipe) && (
                    <Button variant={recipe ? "primary" : "secondary"} onClick={() => fire(save())} disabled={saving}>{saving ? "Saving…" : recipe ? "Save changes" : "Save recipe"}</Button>
                  )}
                  {dirty && recipe && <span className="text-xs text-mud-faint">Unsaved changes</span>}
                </div>
                <RunBox
                  draft={draft}
                  schema={schema}
                  rows={state.rows}
                  contactsOf={state.contactsOf}
                  selectedIds={selectedIds}
                  selectionLabel={selectionLabel}
                  filteredIds={filteredIds}
                  ready={ready}
                  onSetup={() => ai.setOpen(true)}
                  onRun={async (rowIds, opts) => {
                    const r = dirty || !recipe ? await save() : recipe;
                    if (!r) return;
                    const run = await enrich.start({ kind: "enrich", recipeId: r.id, rowIds, ...opts });
                    if (run) setSel({ kind: "recipe", id: r.id });
                  }}
                  busy={!!recipe && enrich.activeRuns.some((x) => x.recipeId === recipe.id)}
                />
                {shownRun && (
                  <RunProgress run={shownRun} rowById={state.rowById} schema={schema} contactsOf={state.contactsOf} onAction={(a) => fire(enrich.action(shownRun.id, a))} onReview={onOpenReview}
                    pending={enrich.suggestions.filter((s) => s.runId === shownRun.id).length} onOpenRow={onOpenRow} />
                )}
              </div>
            ) : (
              <div className="mx-auto mt-16 max-w-md text-center">
                <Tile size="lg" className="mx-auto bg-clay-soft text-clay-deep"><Wand2 size={18} /></Tile>
                <h3 className="mt-3 text-lg font-semibold">Pick a preset to begin</h3>
                <p className="mt-1 text-sm text-mud-soft">Each recipe says what to find and which columns to fill. Test it on three prospects, check the results, then run it on the rest.</p>
              </div>
            )}
          </div>
        </div>
    </Panel>
  );
}

function RecipeEditor({ draft, schema, onChange }: { draft: Draft; schema: CampaignSchema; onChange: (p: Partial<Draft>) => void }) {
  const records = new Set(contactRecordKeys(schema));
  const skipInputs = new Set([schema.reasonKey, schema.screenedKey, schema.idKey, schema.contacts?.emailSourceKey, ...records]);
  // The primary contact's columns go along as context too.
  const inputCols = allColumns(schema).filter((c) => !isSourcesColumn(c) && !skipInputs.has(c.key));
  const orgTargets = schema.columns.filter((c) => !isSourcesColumn(c) && c.key !== schema.idKey);
  const contactTargets = contactSchema(schema).columns.filter((c) => !records.has(c.key));
  const [showInputs, setShowInputs] = useState(draft.inputKeys.length > 0);
  const setOutput = (i: number, patch: Partial<OutputDraft>) => onChange({ outputs: draft.outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label className="label" htmlFor="rc-name">Recipe name</label>
          <input id="rc-name" className="field" value={draft.name} placeholder="e.g. Company snapshot" onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 self-end rounded-lg border border-rim/40 bg-paper px-3 py-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-clay" checked={draft.webSearch} onChange={(e) => onChange({ webSearch: e.target.checked })} />
          <Globe size={14} className="text-sky-600" /> Search the web
        </label>
      </div>

      <div>
        <label className="label" htmlFor="rc-ins">What should the AI find?</label>
        <textarea id="rc-ins" rows={3} className="field resize-y leading-relaxed" value={draft.instructions}
          placeholder="e.g. Find the company's most recent government contract award and its value."
          onChange={(e) => onChange({ instructions: e.target.value })} />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label mb-0">Columns to fill</span>
          <span className="text-[11px] text-mud-faint">New columns go after your last column</span>
        </div>
        <div className="space-y-2">
          {draft.outputs.map((o, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border border-rim/40 bg-paper p-2">
              <div className="space-y-1.5">
                <select className="field h-8 py-0 text-xs" value={o.target}
                  onChange={(e) => {
                    const col = columnOf(schema, e.target.value);
                    setOutput(i, col ? { target: col.key, header: col.header, type: col.type } : { target: e.target.value === NEW_CONTACT ? NEW_CONTACT : NEW, header: "", type: "text" });
                  }}>
                  <option value={NEW}>+ New column</option>
                  <option value={NEW_CONTACT}>+ New contact column</option>
                  <optgroup label="Prospect">
                    {orgTargets.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
                  </optgroup>
                  {contactTargets.length > 0 && (
                    <optgroup label="Primary contact">
                      {contactTargets.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
                    </optgroup>
                  )}
                </select>
                {isNew(o.target) && (
                  <div className="flex gap-1">
                    <input className="field h-8 py-0 text-xs" placeholder="Column name" value={o.header}
                      onChange={(e) => setOutput(i, { header: e.target.value, ...(o.type === headerType(o.header) ? { type: headerType(e.target.value) } : {}) })} />
                    <select className="field h-8 w-24 py-0 text-xs" value={o.type} onChange={(e) => setOutput(i, { type: e.target.value as ColumnType })}>
                      {COLUMN_TYPES.filter((t) => t.value !== "select").map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <input className="field h-8 py-0 text-xs" placeholder="Guidance for this field (optional)" value={o.hint} onChange={(e) => setOutput(i, { hint: e.target.value })} />
              <button className="mt-1 rounded-sm p-1 text-mud-faint hover:bg-rose-50 hover:text-rose-600" title="Remove" onClick={() => onChange({ outputs: draft.outputs.filter((_, j) => j !== i) })}>
                <X size={14} />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onChange({ outputs: [...draft.outputs, { target: NEW, header: "", hint: "", type: "text" }] })}>
            <Plus size={13} /> Add a column
          </Button>
        </div>
      </div>

      <div>
        <button className="text-xs font-medium text-clay-deep hover:underline" onClick={() => {
          if (showInputs) onChange({ inputKeys: [] });
          setShowInputs(!showInputs);
        }}>
          {showInputs ? "Send all filled columns instead" : "Sends every filled column as context. Choose specific columns…"}
        </button>
        {showInputs && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {inputCols.map((c) => {
              const on = draft.inputKeys.includes(c.key);
              return (
                <button key={c.key} onClick={() => onChange({ inputKeys: on ? draft.inputKeys.filter((k) => k !== c.key) : [...draft.inputKeys, c.key] })}
                  className={cn("tag border", on ? "border-clay bg-clay-soft text-clay-deep" : "border-rim/40 bg-paper text-mud-soft hover:border-rim")}>
                  {c.header}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RunBox({ draft, schema, rows, contactsOf, selectedIds, selectionLabel = "Selected rows", filteredIds, ready, onSetup, onRun, busy }: {
  draft: Draft;
  schema: CampaignSchema;
  rows: Row[];
  contactsOf: (orgId: string) => Row[];
  selectedIds: string[];
  selectionLabel?: string;
  filteredIds: string[];
  ready: boolean;
  onSetup: () => void;
  onRun: (rowIds: string[], opts: { test: boolean; autoFill: boolean; concurrency: number }) => Promise<void>;
  busy: boolean;
}) {
  // Screened-out prospects are left out of every scope: the run would only skip them.
  const prospects = useMemo(() => rows.filter((r) => !isScreened(r, schema)), [rows, schema]);
  const inPlay = new Set(prospects.map((r) => r.id));
  const selected = selectedIds.filter((id) => inPlay.has(id));
  const filtered = filteredIds.filter((id) => inPlay.has(id));
  // The outputs as Run saves them (an unnamed new column is dropped), so the mode is the run's.
  const outputs = toApi(draft).outputs;
  const targetList = outputs.flatMap((o) => (o.key ? [o.key] : [])).join("\u0000");
  const hasNew = outputs.some((o) => !o.key);
  // Filling in people's details: one turn per person the run researches (see researchedContacts).
  const perContact = recipeMode(outputs, schema) === "contacts";
  // Worked out once per change to the rows or the outputs, not on every keystroke in the recipe.
  const people = useMemo(
    () => (perContact ? new Map(prospects.map((r) => [r.id, researchedContacts(contactsOf(r.id), schema)])) : null),
    [perContact, prospects, contactsOf, schema],
  );
  const missing = useMemo(() => {
    const targets = targetList ? targetList.split("\u0000") : [];
    const contactKeys = new Set(contactSchema(schema).columns.map((c) => c.key));
    const blank = (v: CellValue | undefined) => v === undefined || v === null || v === "";
    const ofContacts = targets.some((k) => contactKeys.has(k));
    return prospects.filter((r) => {
      if (people) {
        const them = people.get(r.id) ?? [];
        if (!them.length) return false;
        if (hasNew) return true;
        return targets.some((k) => (contactKeys.has(k) ? them.some((c) => blank(c.cells[k])) : blank(r.cells[k])));
      }
      if (hasNew) return true;
      // A contact column is missing when the prospect's primary contact lacks it (or it has none).
      const primary = ofContacts ? primaryOf(contactsOf(r.id), schema) : undefined;
      return targets.some((k) => blank(contactKeys.has(k) ? primary?.cells[k] : r.cells[k]));
    });
  }, [people, prospects, hasNew, targetList, schema, contactsOf]);
  const [scope, setScope] = useState(selected.length ? "selected" : "missing");
  // The selection can shrink while this is open (a test's rows leaving the view). Its scope then
  // stays while it is the one chosen, down to none, rather than the run widening to another unasked.
  const scopes = [
    ...(selected.length || scope === "selected" ? [{ id: "selected", label: selectionLabel, ids: selected }] : []),
    { id: "missing", label: "Prospects missing these fields", ids: missing.map((r) => r.id) },
    ...(filtered.length !== prospects.length ? [{ id: "filtered", label: "Rows in the current view", ids: filtered }] : []),
    { id: "all", label: "All prospects", ids: prospects.map((r) => r.id) },
  ];
  const [autoFill, setAutoFill] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [starting, setStarting] = useState(false);
  const chosen = scopes.find((s) => s.id === scope) ?? scopes[0]!;
  const n = chosen.ids.length;
  const researched = people ? chosen.ids.filter((id) => people.get(id)?.length) : chosen.ids;
  const withPeople = researched.length;
  const turns = people ? chosen.ids.reduce((t, id) => t + (people.get(id)?.length ?? 0), 0) : n;
  // A test is of prospects the run researches, not of ones it would skip for having no one.
  const testIds = researched.slice(0, 3);
  const minutes = Math.max(1, Math.round((turns * 25) / 60 / concurrency));
  const go = async (test: boolean) => {
    setStarting(true);
    await onRun(test ? testIds : chosen.ids, { test, autoFill, concurrency });
    setStarting(false);
  };

  return (
    <div className="rounded-2xl border border-clay bg-clay-soft/30 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label className="label" htmlFor="rb-scope">Run on</label>
          <select id="rb-scope" className="field" value={chosen.id} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.ids.length})</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="rb-par">At a time</label>
          <select id="rb-par" className="field w-24" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-clay" checked={autoFill} onChange={(e) => setAutoFill(e.target.checked)} />
        <span>Fill empty cells automatically <span className="block text-xs text-mud-faint">Findings for cells that already have a value always wait for your review.</span></span>
      </label>
      <p className="mt-3 text-xs text-mud-soft">
        {turns} research turn{turns === 1 ? "" : "s"}
        {perContact && <> (one per contact{withPeople < n ? `; ${n - withPeople} prospect${n - withPeople === 1 ? " has" : "s have"} none, and ${n - withPeople === 1 ? "is" : "are"} skipped` : ""})</>}
        {" "}· usually 10–40 seconds each · about {minutes} min for all at {concurrency} at a time. Counts toward your plan's usage.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!ready ? (
          <Button variant="primary" onClick={onSetup}>Set up AI first</Button>
        ) : (
          <>
            <Button onClick={() => fire(go(true))} disabled={!testIds.length || busy || starting}><FlaskConical size={14} /> Test on {testIds.length} row{testIds.length === 1 ? "" : "s"}</Button>
            <Button variant="primary" onClick={() => fire(go(false))} disabled={!n || busy || starting}><Rocket size={14} /> Run on {n} row{n === 1 ? "" : "s"}</Button>
          </>
        )}
        {busy && <span className="self-center text-xs text-clay-deep">This recipe is running…</span>}
      </div>
    </div>
  );
}
