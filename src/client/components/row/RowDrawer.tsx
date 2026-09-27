/**
 * The prospect panel: the pipeline stepper, the meeting, the intro message, and every field.
 */
import {
  ArchiveRestore, Ban, CalendarPlus, Check, ChevronDown, ChevronUp, ClipboardCopy, Copy, ExternalLink, MoreHorizontal,
  Pencil, Send, Trash2, Undo2, Video, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { mergeTemplate } from "../../../shared/merge";
import { DEAD, MEETING_STAGE, type CampaignSchema, type CellEdit, type Column, type Row, type Template } from "../../../shared/types";
import { cn } from "../../lib/cn";
import { formatDateTime, isSameDay, parseLocal, relative } from "../../lib/format";
import { contactedStage, rowTitle, shouldAdvanceToMeeting, stageEdits, stageIndex } from "../../lib/pipeline";
import { toneFor } from "../../lib/stages";
import type { CampaignState } from "../../hooks/useCampaign";
import { hrefOf, openLink } from "../grid/cells";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { undoToast } from "../ui/Toaster";
import { FieldInput } from "./FieldInput";
import { ScreenOutButton } from "./ScreenOutButton";

interface Props {
  row: Row;
  schema: CampaignSchema;
  stages: string[];
  templates: Template[];
  state: CampaignState;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenTemplates: () => void;
}

export function RowDrawer({ row, schema, stages, templates, state, onClose, onPrev, onNext, onOpenTemplates }: Props) {
  const { title, subtitle } = rowTitle(row, schema);
  const screened = row.bucket === "screened";
  const special = new Set([schema.statusKey, schema.introKey, schema.meetingAtKey, schema.meetingUrlKey, schema.reasonKey].filter(Boolean));
  const fields = schema.columns.filter((c) => !special.has(c.key));
  const edit = (edits: CellEdit[], label: string, toastMsg?: string) => {
    state.edit(edits, label);
    if (toastMsg) undoToast(toastMsg, () => state.undo());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" && e.altKey) onNext?.();
      if (e.key === "ArrowUp" && e.altKey) onPrev?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onPrev]);

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(460px,100%)] flex-col border-l border-line bg-panel shadow-2xl shadow-zinc-900/10 animate-slide-in">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <p className="truncate text-xs text-ink-soft">
            {subtitle || " "}
            {screened && <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 uppercase">Screened out</span>}
          </p>
        </div>
        {!screened && (
          <ScreenOutButton count={1} align="right" onConfirm={(reason) => {
            state.moveRows([row.id], "screened", reason);
            undoToast("Screened out", () => state.undo());
          }} />
        )}
        <Button size="icon" variant="ghost" onClick={onPrev} disabled={!onPrev} title="Previous (Alt+↑)"><ChevronUp size={16} /></Button>
        <Button size="icon" variant="ghost" onClick={onNext} disabled={!onNext} title="Next (Alt+↓)"><ChevronDown size={16} /></Button>
        <RowMenu row={row} state={state} onClose={onClose} />
        <Button size="icon" variant="ghost" onClick={onClose} title="Close (Esc)" aria-label="Close prospect"><X size={16} /></Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 scroll-thin">
        {screened ? (
          <ScreenedBanner row={row} schema={schema} state={state} />
        ) : (
          schema.statusKey && <Stepper row={row} schema={schema} stages={stages} onEdit={edit} />
        )}

        {!screened && schema.meetingAtKey && <MeetingSection key={row.id} row={row} schema={schema} stages={stages} onEdit={edit} />}

        {schema.introKey && (
          <IntroSection key={row.id} row={row} schema={schema} stages={stages} templates={templates} onEdit={edit} onOpenTemplates={onOpenTemplates} />
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">Details</h3>
          <div className="space-y-3">
            {fields.map((col) => (
              <Field key={col.key} col={col} row={row} onEdit={edit} />
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}

function Field({ col, row, onEdit }: { col: Column; row: Row; onEdit: (e: CellEdit[], l: string) => void }) {
  const v = row.cells[col.key];
  const href = (col.type === "url" || col.type === "email") && v ? hrefOf(String(v), col.type) : null;
  return (
    <div>
      <label className="label flex items-center gap-1">
        {col.header}
        {href && (
          <button className="ml-auto rounded p-0.5 text-ink-faint hover:text-brand-700" onClick={() => openLink(href)} title={`Open ${href}`}>
            <ExternalLink size={12} />
          </button>
        )}
      </label>
      <FieldInput col={col} value={v} onCommit={(value) => onEdit([{ rowId: row.id, key: col.key, value }], `Edit ${col.header}`)} rows={2} />
    </div>
  );
}

function RowMenu({ row, state, onClose }: { row: Row; state: CampaignState; onClose: () => void }) {
  return (
    <Popover align="right" trigger={({ toggle }) => (
      <Button size="icon" variant="ghost" onClick={toggle} title="More"><MoreHorizontal size={16} /></Button>
    )}>
      {(close) => (
        <>
          <MenuItem icon={<Copy size={15} />} onClick={() => { close(); state.duplicateRow(row.id); toast.success("Duplicated"); }}>Duplicate row</MenuItem>
          <MenuItem danger icon={<Trash2 size={15} />} onClick={() => {
            close();
            state.deleteRows([row.id]);
            onClose();
            undoToast("Row deleted", () => state.undo());
          }}>Delete row</MenuItem>
        </>
      )}
    </Popover>
  );
}

// ---------- pipeline ----------

function Stepper({ row, schema, stages, onEdit }: { row: Row; schema: CampaignSchema; stages: string[]; onEdit: (e: CellEdit[], l: string, t?: string) => void }) {
  const status = String(row.cells[schema.statusKey!] ?? "");
  const dead = status === DEAD;
  const cur = stageIndex(status, stages);
  const set = (stage: string) => {
    const { edits, stamped } = stageEdits(row, schema, stages, stage);
    onEdit(edits, "Change stage", `${stage || "Stage cleared"}${stamped.length ? ` · ${stamped.join(", ")} set to today` : ""}`);
  };
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Pipeline</h3>
        {status && cur < 0 && !dead && <span className="text-xs text-ink-soft">Current: {status}</span>}
      </div>
      <ol className={cn("flex items-start", dead && "opacity-40")}>
        {stages.map((s, i) => {
          const done = !dead && cur >= i;
          const here = !dead && cur === i;
          const tone = toneFor(s, stages);
          return (
            <li key={s} className="relative flex min-w-0 flex-1 flex-col items-center">
              {i > 0 && <span className={cn("absolute top-[9px] right-1/2 h-0.5 w-full", done ? tone.bar : "bg-zinc-200")} />}
              <button
                onClick={() => set(here ? "" : s)}
                title={here ? `Clear ${s}` : `Set to ${s}`}
                className={cn(
                  "relative z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 transition",
                  done ? cn("border-transparent text-white", tone.dot) : "border-zinc-300 bg-white hover:border-brand-400",
                  here && "ring-4 ring-brand-100",
                )}
              >
                {done && <Check size={11} strokeWidth={3} />}
              </button>
              <span className={cn("mt-1.5 px-0.5 text-center text-[10.5px] leading-tight", here ? "font-semibold text-ink" : "text-ink-soft")}>{s}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        {dead ? (
          <Button size="sm" variant="subtle" onClick={() => set(stages[Math.max(0, cur)] ?? stages[0]!)}>
            <Undo2 size={13} /> Revive — back to {stages[0]}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50 hover:text-rose-800" onClick={() => set(DEAD)}>
            <Ban size={13} /> Dropped off / dead
          </Button>
        )}
        {dead && <span className="text-xs font-medium text-rose-700">Marked {DEAD}</span>}
      </div>
    </section>
  );
}

function ScreenedBanner({ row, schema, state }: { row: Row; schema: CampaignSchema; state: CampaignState }) {
  const reasonCol = schema.columns.find((c) => c.key === schema.reasonKey);
  return (
    <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center gap-2">
        <Ban size={15} className="text-zinc-500" />
        <h3 className="text-sm font-semibold">Screened out</h3>
        <Button size="sm" className="ml-auto" onClick={() => {
          state.moveRows([row.id], "prospects");
          undoToast("Restored to prospects", () => state.undo());
        }}>
          <ArchiveRestore size={13} /> Restore to prospects
        </Button>
      </div>
      {reasonCol && (
        <div className="mt-3">
          <label className="label">{reasonCol.header}</label>
          <FieldInput col={reasonCol} value={row.cells[reasonCol.key]} rows={3}
            onCommit={(value) => state.edit([{ rowId: row.id, key: reasonCol.key, value }], "Edit reason")} placeholder="Why this prospect fails the filter" />
        </div>
      )}
    </section>
  );
}

// ---------- meeting ----------

function MeetingSection({ row, schema, stages, onEdit }: { row: Row; schema: CampaignSchema; stages: string[]; onEdit: (e: CellEdit[], l: string, t?: string) => void }) {
  const at = String(row.cells[schema.meetingAtKey!] ?? "");
  const url = schema.meetingUrlKey ? String(row.cells[schema.meetingUrlKey] ?? "") : "";
  const status = schema.statusKey ? String(row.cells[schema.statusKey] ?? "") : "";
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftAt, setDraftAt] = useState(at);
  const booked = !!at || !!url;

  // Picking "Meeting booked" in the stepper with no meeting yet opens the form.
  useEffect(() => {
    if (status === MEETING_STAGE && !booked) setEditing(true);
  }, [status, booked]);
  useEffect(() => {
    setDraftUrl(url);
    setDraftAt(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T09:00` : at.slice(0, 16));
  }, [url, at, editing]);

  const save = () => {
    const edits: CellEdit[] = [{ rowId: row.id, key: schema.meetingAtKey!, value: draftAt || null }];
    if (schema.meetingUrlKey) edits.push({ rowId: row.id, key: schema.meetingUrlKey, value: draftUrl.trim() || null });
    const next = shouldAdvanceToMeeting(status, stages);
    let msg = "Meeting saved";
    if (next && schema.statusKey) {
      edits.push(...stageEdits(row, schema, stages, next).edits);
      msg = `Meeting saved · status set to ${next}`;
    }
    onEdit(edits, "Book meeting", msg);
    setEditing(false);
  };
  const clear = () => {
    const edits: CellEdit[] = [{ rowId: row.id, key: schema.meetingAtKey!, value: null }];
    if (schema.meetingUrlKey) edits.push({ rowId: row.id, key: schema.meetingUrlKey, value: null });
    onEdit(edits, "Clear meeting", "Meeting cleared");
  };

  const d = at ? parseLocal(at) : null;
  const now = new Date();
  const past = d && d < now && !isSameDay(d, now);
  const today = d && isSameDay(d, now);
  const heldStage = stages[stageIndex(MEETING_STAGE, stages) + 1];
  const joinHref = url ? hrefOf(url, "url") : null;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">Meeting</h3>
      {editing ? (
        <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3">
          <div>
            <label className="label" htmlFor="m-url">Meeting link</label>
            <input id="m-url" className="field" placeholder="Zoom, Google Meet, Teams or Calendly link" value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="m-at">Date and time</label>
            <input id="m-at" type="datetime-local" className="field" value={draftAt} onChange={(e) => setDraftAt(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={save} disabled={!draftAt && !draftUrl.trim()}>Save meeting</Button>
          </div>
        </div>
      ) : booked ? (
        <div className={cn("rounded-xl border p-3", today ? "border-amber-200 bg-amber-50" : past ? "border-line bg-zinc-50" : "border-line bg-white")}>
          <div className="flex items-start gap-3">
            <div className={cn("rounded-lg p-2", today ? "bg-amber-100 text-amber-700" : "bg-brand-50 text-brand-600")}><Video size={18} /></div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{at ? formatDateTime(at) : "Time not set"}</div>
              <div className={cn("text-xs", today ? "font-medium text-amber-700" : "text-ink-soft")}>
                {at ? relative(at) : ""}{url ? `${at ? " · " : ""}${url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}` : ""}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {joinHref && <Button size="sm" variant="primary" onClick={() => openLink(joinHref)}><Video size={13} /> Join</Button>}
            {url && (
              <Button size="sm" onClick={() => navigator.clipboard.writeText(url).then(() => toast.success("Link copied"), () => toast.error("Could not copy"))}>
                <ClipboardCopy size={13} /> Copy link
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</Button>
            <Button size="sm" variant="ghost" onClick={clear}><X size={13} /> Clear</Button>
          </div>
          {past && status === MEETING_STAGE && heldStage && (
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-xs text-ink-soft">
              <span>This was {relative(at)}. Did it happen?</span>
              <Button size="sm" variant="subtle" className="ml-auto" onClick={() => {
                const { edits } = stageEdits(row, schema, stages, heldStage);
                onEdit(edits, "Change stage", `Status set to ${heldStage}`);
              }}>Mark {heldStage}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Reschedule</Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-dashed border-line-strong px-3 py-2.5">
          <span className="text-sm text-ink-faint">No meeting booked</span>
          <Button size="sm" onClick={() => setEditing(true)}><CalendarPlus size={13} /> Book meeting</Button>
        </div>
      )}
    </section>
  );
}

// ---------- intro message ----------

function IntroSection({ row, schema, stages, templates, onEdit, onOpenTemplates }: {
  row: Row; schema: CampaignSchema; stages: string[]; templates: Template[];
  onEdit: (e: CellEdit[], l: string, t?: string) => void; onOpenTemplates: () => void;
}) {
  const introCol = schema.columns.find((c) => c.key === schema.introKey)!;
  const intro = String(row.cells[introCol.key] ?? "");
  const [pick, setPick] = useState(templates[0]?.id ?? "");
  useEffect(() => {
    if (!templates.some((t) => t.id === pick)) setPick(templates[0]?.id ?? "");
  }, [templates, pick]);
  const tpl = templates.find((t) => t.id === pick);
  const merged = useMemo(() => (tpl ? mergeTemplate(tpl.body, schema, row.cells) : null), [tpl, schema, row.cells]);
  const leftovers = [...intro.matchAll(/\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}/g)].map((m) => m[1]!);
  const status = schema.statusKey ? String(row.cells[schema.statusKey] ?? "") : "";
  const contacted = contactedStage(stages);
  const alreadyContacted = contacted ? stageIndex(status, stages) >= stageIndex(contacted, stages) : false;

  const apply = () => {
    if (!merged) return;
    onEdit([{ rowId: row.id, key: introCol.key, value: merged.text }], "Use template", intro ? `Replaced intro with “${tpl!.name}”` : `Filled from “${tpl!.name}”`);
    if (merged.missing.length) toast(`No value for ${merged.missing.join(", ")} — left blank`, { icon: "⚠️" });
  };
  const markSent = () => {
    if (!contacted || !schema.statusKey) return;
    const { edits, stamped } = stageEdits(row, schema, stages, contacted);
    onEdit(edits, "Mark sent", `Marked ${contacted}${stamped.length ? ` · ${stamped.join(", ")} set to today` : ""}`);
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{introCol.header}</h3>
        <button className="text-xs text-brand-700 hover:underline" onClick={onOpenTemplates}>Manage templates</button>
      </div>
      {templates.length > 0 ? (
        <div className="mb-2 flex gap-2">
          <select className="field h-8 py-0 text-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <Button size="sm" variant="subtle" onClick={apply} disabled={!merged} className="h-8">
            {intro ? "Replace with template" : "Use template"}
          </Button>
        </div>
      ) : (
        <button onClick={onOpenTemplates} className="mb-2 w-full rounded-lg border border-dashed border-line-strong px-3 py-2 text-left text-xs text-ink-soft hover:border-brand-300 hover:text-brand-700">
          No templates yet — add your intro message templates to fill this in one click.
        </button>
      )}
      {merged && merged.unknown.length > 0 && (
        <p className="mb-2 text-xs text-amber-700">This template uses {merged.unknown.map((u) => `{{${u}}}`).join(", ")}, which match no column.</p>
      )}
      <FieldInput col={introCol} value={intro} rows={7} placeholder="The first message you sent (or will send) this prospect."
        onCommit={(value) => onEdit([{ rowId: row.id, key: introCol.key, value }], "Edit intro")} />
      {leftovers.length > 0 && (
        <p className="mt-1.5 text-xs text-amber-700">Still has placeholders: {leftovers.map((l) => `{{${l}}}`).join(", ")}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!intro} onClick={() => navigator.clipboard.writeText(intro).then(() => toast.success("Copied"), () => toast.error("Could not copy"))}>
          <ClipboardCopy size={13} /> Copy
        </Button>
        {!alreadyContacted && contacted && (
          <Button size="sm" variant="ghost" onClick={markSent} disabled={!intro}>
            <Send size={13} /> Mark sent
          </Button>
        )}
        <span className="ml-auto text-[11px] text-ink-faint tabular-nums">{intro.length} chars</span>
      </div>
    </section>
  );
}
