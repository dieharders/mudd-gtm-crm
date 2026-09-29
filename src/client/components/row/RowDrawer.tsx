/**
 * The prospect panel: the pipeline stepper, the prospect's contacts, the meeting, the intro
 * message, and the company's own fields. A contact opens in the panel itself, and Back (or Esc)
 * returns to the prospect. A screened-out prospect shows only why it was screened out, with
 * Restore, and its fields and contacts read-only.
 */
import {
  ArchiveRestore, ArrowLeft, Ban, CalendarPlus, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardCopy, Copy, ExternalLink, MoreHorizontal,
  Pencil, Send, Star, Trash2, Undo2, UserPlus, Video, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { mergeTemplate, placeholderNames } from "../../../shared/merge";
import { CONTACT_TYPE_HINTS, contactSchema, prospectSchema } from "../../../shared/schema";
import { DEAD, isScreened, MEETING_STAGE, type CampaignSchema, type CellEdit, type Column, type Row, type Template } from "../../../shared/types";
import { contactLabel, contactOf, orderedContacts, primaryOf, prospectCells, prospectTitle, toLocalInput } from "../../../shared/values";
import { cn } from "../../lib/cn";
import { formatDateTime, isSameDay, parseLocal, relative } from "../../lib/format";
import { contactedStage, shouldAdvanceToMeeting, stageEdits, stageIndex } from "../../lib/pipeline";
import { tileFor, toneFor, typeTone } from "../../lib/stages";
import type { CampaignState } from "../../hooks/useCampaign";
import type { EnrichmentState } from "../../hooks/useEnrichment";
import { AiIntro, RowSuggestions } from "./AiSections";
import { hrefOf, openLink } from "../grid/cells";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
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
  /** The prospect's contacts, in their order. */
  contacts: Row[];
  /** The contact open in the panel, in place of the prospect. */
  openContactId: string | null;
  onOpenContact: (id: string | null) => void;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenTemplates: () => void;
  enrich: EnrichmentState;
}

export function RowDrawer({ row, schema, stages, templates, state, contacts, openContactId, onOpenContact, onClose, onPrev, onNext, onOpenTemplates, enrich }: Props) {
  const primary = primaryOf(contacts, schema);
  const { title, subtitle } = prospectTitle(row, primary, schema);
  const screened = isScreened(row, schema);
  const contact = openContactId ? contacts.find((c) => c.id === openContactId) ?? null : null;
  const inContact = !!contact;
  const special = new Set(
    [schema.statusKey, schema.introKey, schema.meetingAtKey, schema.meetingUrlKey, schema.screenedKey, schema.reasonKey].filter(Boolean),
  );
  const fields = schema.columns.filter((c) => !special.has(c.key));
  const edit = (edits: CellEdit[], label: string, toastMsg?: string) => {
    state.edit(edits, label);
    if (toastMsg) undoToast(toastMsg, () => state.undo());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      // Esc steps back from a contact to its prospect, and only then closes.
      if (e.key === "Escape") {
        if (inContact) onOpenContact(null);
        else onClose();
      }
      if (e.key === "ArrowDown" && e.altKey) onNext?.();
      if (e.key === "ArrowUp" && e.altKey) onPrev?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inContact, onOpenContact, onClose, onNext, onPrev]);

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(460px,100%)] flex-col border-l border-line bg-panel shadow-2xl shadow-zinc-900/10 animate-slide-in">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <p className="truncate text-xs text-ink-soft">
            {subtitle || " "}
            {screened && <span className="ml-2 rounded-sm bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 uppercase">Screened out</span>}
          </p>
        </div>
        {!screened && schema.screenedKey && (
          <ScreenOutButton count={1} align="right" onConfirm={(reason) => {
            if (state.screenOut([row.id], reason)) undoToast("Screened out", () => state.undo());
          }} />
        )}
        <Button size="icon" variant="ghost" onClick={onPrev} disabled={!onPrev} title="Previous (Alt+↑)"><ChevronUp size={16} /></Button>
        <Button size="icon" variant="ghost" onClick={onNext} disabled={!onNext} title="Next (Alt+↓)"><ChevronDown size={16} /></Button>
        <RowMenu row={row} contacts={contacts.length} state={state} onClose={onClose} />
        <Button size="icon" variant="ghost" onClick={onClose} title="Close (Esc)" aria-label="Close prospect"><X size={16} /></Button>
      </div>

      {contact ? (
        <ContactPanel key={`contact-${contact.id}`} contact={contact} orgTitle={title} schema={schema} state={state} enrich={enrich}
          disabled={screened} isPrimary={contact === primary} onBack={() => onOpenContact(null)} />
      ) : (
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 scroll-thin">
          {!screened && <RowSuggestions row={row} contacts={contacts} schema={schema} enrich={enrich} />}
          {screened ? (
            <ScreenedBanner row={row} schema={schema} state={state} />
          ) : (
            schema.statusKey && <Stepper row={row} schema={schema} stages={stages} onEdit={edit} />
          )}

          {/* Sibling sections need keys of their own: with one shared key, React never removes the
              previous prospect's section when the next one opens, and they pile up. */}
          <ContactsSection key={`contacts-${row.id}`} org={row} contacts={contacts} primary={primary} schema={schema} state={state} enrich={enrich}
            disabled={screened} onOpenContact={onOpenContact} />

          {!screened && schema.meetingAtKey && <MeetingSection key={`meeting-${row.id}`} row={row} schema={schema} stages={stages} onEdit={edit} />}

          {!screened && schema.introKey && (
            <IntroSection key={`intro-${row.id}`} row={row} primary={primary} schema={schema} stages={stages} templates={templates} onEdit={edit} onOpenTemplates={onOpenTemplates}
              ai={<AiIntro key={row.id} row={row} schema={schema} templates={templates} enrich={enrich} />} />
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Company</h3>
              {screened && <span className="text-xs text-ink-faint">Restore the prospect to edit</span>}
            </div>
            <div className="space-y-3">
              {fields.map((col) => (
                <Field key={col.key} col={col} row={row} onEdit={edit} disabled={screened || col.key === schema.idKey} />
              ))}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}

function Field({ col, row, onEdit, disabled, autoFocus }: { col: Column; row: Row; onEdit: (e: CellEdit[], l: string) => void; disabled?: boolean; autoFocus?: boolean }) {
  const v = row.cells[col.key];
  const href = (col.type === "url" || col.type === "email") && v ? hrefOf(String(v), col.type) : null;
  return (
    <div>
      <label className="label flex items-center gap-1">
        {col.header}
        {href && (
          <button className="ml-auto rounded-sm p-0.5 text-ink-faint hover:text-brand-700" onClick={() => openLink(href)} title={`Open ${href}`}>
            <ExternalLink size={12} />
          </button>
        )}
      </label>
      <FieldInput col={col} value={v} onCommit={(value) => onEdit([{ rowId: row.id, key: col.key, value }], `Edit ${col.header}`)} rows={2} disabled={disabled} autoFocus={autoFocus} />
    </div>
  );
}

function RowMenu({ row, contacts, state, onClose }: { row: Row; contacts: number; state: CampaignState; onClose: () => void }) {
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
            undoToast(contacts ? `Row and its ${contacts === 1 ? "contact" : `${contacts} contacts`} deleted` : "Row deleted", () => state.undo());
          }}>Delete row</MenuItem>
        </>
      )}
    </Popover>
  );
}

// ---------- contacts ----------

/** The prospect's people, primary first: each opens in the panel. */
function ContactsSection({ org, contacts, primary, schema, state, enrich, disabled, onOpenContact }: {
  org: Row; contacts: Row[]; primary: Row | undefined; schema: CampaignSchema; state: CampaignState; enrich: EnrichmentState;
  disabled: boolean; onOpenContact: (id: string) => void;
}) {
  const cs = contactSchema(schema);
  const typeCol = cs.columns.find((c) => c.key === cs.typeKey);
  const emailCols = cs.columns.filter((c) => c.type === "email");
  const add = () => onOpenContact(state.addContact(org.id).id);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
          Contacts{contacts.length > 0 && <span className="ml-1.5 font-normal tabular-nums">{contacts.length}</span>}
        </h3>
        {!disabled && contacts.length > 0 && <button className="text-xs text-brand-700 hover:underline" onClick={add}>+ Add contact</button>}
      </div>
      {contacts.length > 0 ? (
        <ul className="space-y-1.5">
          {orderedContacts(contacts, schema).map((c) => {
            const label = contactLabel(c, schema);
            const role = contactOf(c.cells, cs).role;
            const email = emailCols.map((col) => String(c.cells[col.key] ?? "").trim()).find(Boolean) ?? "";
            const type = cs.typeKey ? String(c.cells[cs.typeKey] ?? "").trim() : "";
            const pending = enrich.pendingByRow.get(c.id)?.length ?? 0;
            return (
              <li key={c.id}>
                <button onClick={() => onOpenContact(c.id)}
                  className="group flex w-full items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50/30">
                  <Tile size="sm" className={tileFor(c.id)}>{label[0]?.toUpperCase() ?? "?"}</Tile>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{label}</span>
                      {c === primary && <PrimaryStar />}
                    </span>
                    {(role || email) && <span className="block truncate text-xs text-ink-soft">{[role, email].filter(Boolean).join(" · ")}</span>}
                  </span>
                  {pending > 0 && <span className="tag shrink-0 bg-brand-500 text-white">✨ {pending}</span>}
                  {type && <span className={cn("tag shrink-0", typeTone(type, typeCol?.options))}>{type}</span>}
                  <ChevronRight size={14} className="shrink-0 text-ink-faint group-hover:text-brand-600" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-dashed border-line-strong px-3 py-2.5">
          <span className="text-sm text-ink-faint">No contacts yet</span>
          {!disabled && <Button size="sm" onClick={add}><UserPlus size={13} /> Add contact</Button>}
        </div>
      )}
    </section>
  );
}

function PrimaryStar() {
  return (
    <span className="shrink-0" title="Primary contact: intros and templates address them">
      <Star size={12} className="fill-amber-400 text-amber-400" />
    </span>
  );
}

/** One contact, open in the panel: every field, Make primary and Delete. */
function ContactPanel({ contact, orgTitle, schema, state, enrich, disabled, isPrimary, onBack }: {
  contact: Row; orgTitle: string; schema: CampaignSchema; state: CampaignState; enrich: EnrichmentState;
  disabled: boolean; isPrimary: boolean; onBack: () => void;
}) {
  const cs = contactSchema(schema);
  const label = contactLabel(contact, schema);
  const role = contactOf(contact.cells, cs).role;
  const type = cs.typeKey ? String(contact.cells[cs.typeKey] ?? "").trim() : "";
  // Primary is the button below, not a field.
  const fields = cs.columns.filter((c) => c.key !== cs.primaryKey);
  const onEdit = (edits: CellEdit[], l: string) => state.editContacts(edits, l);
  const remove = () => {
    state.deleteRows([contact.id], "Delete contact");
    onBack();
    undoToast("Contact deleted", () => state.undo());
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scroll-thin">
      <button onClick={onBack} className="mb-3 inline-flex max-w-full items-center gap-1 text-xs font-medium text-ink-soft hover:text-brand-700" title="Back to the prospect (Esc)">
        <ArrowLeft size={13} className="shrink-0" /> <span className="truncate">{orgTitle}</span>
      </button>
      <div className="flex items-start gap-3">
        <Tile size="lg" className={tileFor(contact.id)}>{label[0]?.toUpperCase() ?? "?"}</Tile>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-base font-semibold">
            <span className="truncate">{label}</span>
            {isPrimary && <PrimaryStar />}
          </h3>
          <p className="truncate text-xs text-ink-soft">{[type, role].filter(Boolean).join(" · ") || "Contact"}</p>
        </div>
      </div>
      {!disabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isPrimary ? (
            <span className="tag bg-amber-100 text-amber-800"><Star size={11} className="fill-current" /> Primary contact</span>
          ) : (
            <Button size="sm" variant="subtle" onClick={() => state.makePrimary(contact.id)} title="Intros and templates address the primary contact">
              <Star size={13} /> Make primary
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto text-rose-700 hover:bg-rose-50 hover:text-rose-800" onClick={remove}>
            <Trash2 size={13} /> Delete contact
          </Button>
        </div>
      )}

      <div className="mt-5 space-y-6">
        {!disabled && <RowSuggestions row={contact} contacts={[]} schema={schema} enrich={enrich} />}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Details</h3>
            {disabled && <span className="text-xs text-ink-faint">Restore the prospect to edit</span>}
          </div>
          <div className="space-y-3">
            {fields.map((col) => (
              <div key={col.key}>
                <Field col={col} row={contact} onEdit={onEdit} disabled={disabled} autoFocus={col.key === cs.nameKey && !contact.cells[col.key] && !disabled} />
                {col.key === cs.typeKey && type && CONTACT_TYPE_HINTS[type] && <p className="mt-1 text-[11px] text-ink-faint">{CONTACT_TYPE_HINTS[type]}</p>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
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
          if (state.restore([row.id])) undoToast("Restored", () => state.undo());
        }}>
          <ArchiveRestore size={13} /> Restore
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-soft">It stays in the list, greyed out, until you restore it.</p>
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
    setDraftAt(toLocalInput(at));
  }, [url, at, editing]);

  const save = () => {
    // A date with no time shows as 09:00: saving it unchanged keeps it a date.
    const when = draftAt === toLocalInput(at) ? at : draftAt;
    const edits: CellEdit[] = [{ rowId: row.id, key: schema.meetingAtKey!, value: when || null }];
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
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"), () => toast.error("Could not copy"))}>
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

function IntroSection({ row, primary, schema, stages, templates, onEdit, onOpenTemplates, ai }: {
  row: Row; primary: Row | undefined; schema: CampaignSchema; stages: string[]; templates: Template[];
  onEdit: (e: CellEdit[], l: string, t?: string) => void; onOpenTemplates: () => void; ai?: ReactNode;
}) {
  const introCol = schema.columns.find((c) => c.key === schema.introKey)!;
  const intro = String(row.cells[introCol.key] ?? "");
  const [pick, setPick] = useState(templates[0]?.id ?? "");
  useEffect(() => {
    if (!templates.some((t) => t.id === pick)) setPick(templates[0]?.id ?? "");
  }, [templates, pick]);
  const tpl = templates.find((t) => t.id === pick);
  // {{First name}} and the contact's other columns are the primary contact's.
  const merged = useMemo(() => (tpl ? mergeTemplate(tpl.body, prospectSchema(schema), prospectCells(row, primary)) : null), [tpl, schema, row, primary]);
  const leftovers = placeholderNames(intro);
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
      {ai}
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
        <Button size="sm" disabled={!intro} onClick={() => void navigator.clipboard.writeText(intro).then(() => toast.success("Copied"), () => toast.error("Could not copy"))}>
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
