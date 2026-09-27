/**
 * Intro-message templates for one campaign: as many as you like, with {{Column}} placeholders
 * and a live preview against any prospect.
 */
import { Braces, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeTemplate, placeholdersFor, tokenize } from "../../../shared/merge";
import type { CampaignSchema, Row, Template } from "../../../shared/types";
import type { CampaignState } from "../../hooks/useCampaign";
import { cn } from "../../lib/cn";
import { rowTitle } from "../../lib/pipeline";
import { Button } from "../ui/Button";

const STARTER = `Hi {{First name}},

I came across {{Company}} and noticed {{Hook|what you're working on}}.

[Why you're reaching out, in one or two sentences.]

Would a 15-minute call next week be useful?

Best,
[Your name]`;

export function TemplatesPanel({ schema, rows, templates, state, onClose, previewRowId }: {
  schema: CampaignSchema;
  rows: Row[];
  templates: Template[];
  state: CampaignState;
  onClose: () => void;
  previewRowId?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(templates[0]?.id ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const prospects = rows.filter((r) => r.bucket === "prospects");
  const [previewId, setPreviewId] = useState<string>(previewRowId ?? prospects[0]?.id ?? "");
  const tpl = templates.find((t) => t.id === selected) ?? null;

  useEffect(() => {
    if (!tpl && templates[0]) setSelected(templates[0].id);
  }, [tpl, templates]);
  useEffect(() => setConfirmDelete(false), [selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("textarea, input") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    const t = await state.addTemplate(`Template ${templates.length + 1}`, STARTER);
    setSelected(t.id);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-stone-900/20 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-full w-[min(980px,100%)] flex-col bg-panel shadow-2xl animate-slide-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <div className="flex-1">
            <h2 className="text-base font-semibold">Intro message templates</h2>
            <p className="text-xs text-ink-soft">Write it once; each prospect's panel fills in the placeholders from that row.</p>
          </div>
          <Button variant="primary" size="sm" onClick={create}><Plus size={14} /> New template</Button>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close templates"><X size={16} /></Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <ul className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-line p-2 scroll-thin">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setSelected(t.id)}
                  className={cn("w-full rounded-lg px-2.5 py-2 text-left", t.id === selected ? "bg-clay-50 text-clay-800" : "hover:bg-stone-100")}
                >
                  <div className="truncate text-sm font-medium">{t.name || "Untitled"}</div>
                  <div className="truncate text-xs text-ink-faint">{t.body.replace(/\s+/g, " ").slice(0, 60) || "Empty"}</div>
                </button>
              </li>
            ))}
            {!templates.length && (
              <li className="px-2 py-6 text-center text-xs text-ink-faint">
                No templates yet.
                <button className="mt-2 block w-full text-clay-700 hover:underline" onClick={create}>Create your first</button>
              </li>
            )}
          </ul>

          {tpl ? (
            <Editor
              key={tpl.id}
              tpl={tpl}
              schema={schema}
              state={state}
              preview={prospects.find((r) => r.id === previewId) ?? prospects[0] ?? null}
              previewSelect={
                <select className="field h-7 max-w-56 py-0 text-xs" value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                  {prospects.map((r) => <option key={r.id} value={r.id}>{rowTitle(r, schema).title}</option>)}
                </select>
              }
              onDelete={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                state.removeTemplate(tpl.id);
                setSelected(null);
              }}
              confirmingDelete={confirmDelete}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">Create a template to get started.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Editor({ tpl, schema, state, preview, previewSelect, onDelete, confirmingDelete }: {
  tpl: Template;
  schema: CampaignSchema;
  state: CampaignState;
  preview: Row | null;
  previewSelect: ReactNode;
  onDelete: () => void;
  confirmingDelete: boolean;
}) {
  const [name, setName] = useState(tpl.name);
  const [body, setBody] = useState(tpl.body);
  const ta = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ name, body });
  latest.current = { name, body };
  const chips = useMemo(() => placeholdersFor(schema), [schema]);
  const tokens = useMemo(() => tokenize(body, schema), [body, schema]);
  const unknown = tokens.filter((t) => t.placeholder && !t.placeholder.known).map((t) => t.placeholder!.name);
  const merged = preview ? mergeTemplate(body, schema, preview.cells) : null;

  // Saved as you type, a moment after you stop.
  const queueSave = (patch: { name?: string; body?: string }) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      state.updateTemplate(tpl.id, patch);
    }, 400);
  };
  const update = state.updateTemplate;
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      update(tpl.id, latest.current);
    }
  }, [tpl.id, update]);

  const insert = (header: string) => {
    const el = ta.current;
    const token = `{{${header}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    queueSave({ name, body: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-5 scroll-thin">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label" htmlFor="tpl-name">Name</label>
            <input id="tpl-name" className="field" value={name} onChange={(e) => { setName(e.target.value); queueSave({ name: e.target.value, body }); }} />
          </div>
          <Button variant={confirmingDelete ? "danger" : "ghost"} onClick={onDelete}>
            <Trash2 size={14} /> {confirmingDelete ? "Click again to delete" : "Delete"}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <label className="label" htmlFor="tpl-body">Message</label>
          <textarea
            id="tpl-body"
            ref={ta}
            className="field min-h-64 flex-1 resize-none font-mono text-[13px] leading-relaxed"
            value={body}
            onChange={(e) => { setBody(e.target.value); queueSave({ name, body: e.target.value }); }}
          />
          {unknown.length > 0 && (
            <p className="mt-1.5 text-xs text-amber-700">
              {[...new Set(unknown)].map((u) => `{{${u}}}`).join(", ")} match no column and will be left as-is.
            </p>
          )}
        </div>
        <div>
          <p className="label flex items-center gap-1"><Braces size={12} /> Insert a placeholder</p>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((h) => (
              <button key={h} onClick={() => insert(h)} className="rounded-md border border-line bg-white px-1.5 py-0.5 text-xs text-ink-soft hover:border-clay-300 hover:bg-clay-50 hover:text-clay-800">
                {h}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">Tip: <code className="font-mono">{"{{Hook|your work}}"}</code> uses “your work” when the Hook cell is empty.</p>
        </div>
      </div>

      <div className="flex w-[360px] shrink-0 flex-col border-l border-line bg-stone-50/60">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-xs font-semibold text-ink-soft">Preview for</span>
          {previewSelect}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scroll-thin">
          {merged ? (
            <>
              <div className="rounded-xl border border-line bg-white p-3.5 text-sm leading-relaxed whitespace-pre-wrap shadow-xs">
                <Highlighted text={merged.text} />
              </div>
              {merged.missing.length > 0 && (
                <p className="mt-2 text-xs text-ink-soft">Empty for this prospect: {merged.missing.join(", ")}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-faint">Add a prospect to preview.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Leftover {{placeholders}} in the preview, marked so they can't be missed. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\{\{[^{}]+\}\})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\{\{.*\}\}$/.test(p) ? <mark key={i} className="rounded bg-amber-100 px-0.5 text-amber-900">{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}
