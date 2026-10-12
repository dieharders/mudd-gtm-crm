/**
 * Intro-message templates for one campaign: as many as you like, with {{Column}} placeholders
 * and a live preview against any prospect. Placeholders name the prospect's columns or its
 * primary contact's; {{First name}} is the primary contact's.
 */
import { Braces, Plus, Trash2, Wand2, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeTemplate, placeholdersFor } from "../../../shared/merge";
import { prospectSchema } from "../../../shared/schema";
import { isScreened, type CampaignSchema, type Row, type Template, type Thesis } from "../../../shared/types";
import { primaryOf, prospectCells, prospectTitle } from "../../../shared/values";
import type { CampaignState } from "../../hooks/useCampaign";
import type { ConsentGate } from "../../hooks/useConsentGate";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { Panel, railItem } from "../ui/Panel";
import { fire } from "../../lib/fire";
import { GenerateTemplateDialog } from "./GenerateTemplateDialog";
import { UnknownPlaceholders } from "./UnknownPlaceholders";

const STARTER = `Hi {{First name}},

I came across {{Company}} and noticed {{Hook|what you're working on}}.

[Why you're reaching out, in one or two sentences.]

Would a 15-minute call next week be useful?

Best,
[Your name]`;

export function TemplatesPanel({ schema, rows, contactsOf, templates, thesis, consent, state, onClose, previewRowId }: {
  schema: CampaignSchema;
  rows: Row[];
  contactsOf: (orgId: string) => Row[];
  templates: Template[];
  /** The ICP thesis, which prefills "Generate with AI"; null for a campaign without one. */
  thesis: Thesis | null;
  consent: ConsentGate;
  state: CampaignState;
  onClose: () => void;
  previewRowId?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(templates[0]?.id ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [generating, setGenerating] = useState(false);
  const ai = useAi();
  const { ready: aiReady } = useActiveProvider();
  // Without a provider signed in, the button opens the AI settings instead. While the status is
  // still loading it waits, so a signed-in provider isn't mistaken for none.
  const openGenerate = () => (aiReady ? setGenerating(true) : ai.setOpen(true));
  const generateTitle = ai.loading ? "Checking AI setup…" : aiReady ? "Draft a template with AI" : "Set up AI first";
  // Preview against prospects still in play: nobody writes an intro to a screened-out one.
  const prospects = useMemo(() => rows.filter((r) => !isScreened(r, schema)), [rows, schema]);
  const [previewId, setPreviewId] = useState<string>(previewRowId ?? prospects[0]?.id ?? "");
  const tpl = templates.find((t) => t.id === selected) ?? null;
  const view = useMemo(() => prospectSchema(schema), [schema]);
  // The previewed prospect, read with its primary contact as the templates read it.
  const previewOrg = prospects.find((r) => r.id === previewId) ?? prospects[0] ?? null;
  const previewContacts = previewOrg ? contactsOf(previewOrg.id) : null;
  const preview = useMemo(
    () => (previewOrg ? { ...previewOrg, cells: prospectCells(previewOrg, primaryOf(previewContacts ?? [], schema)) } : null),
    [previewOrg, previewContacts, schema],
  );

  useEffect(() => {
    if (!tpl && templates[0]) setSelected(templates[0].id);
  }, [tpl, templates]);
  useEffect(() => setConfirmDelete(false), [selected]);

  const create = async () => {
    const t = await state.addTemplate(`Template ${templates.length + 1}`, STARTER);
    setSelected(t.id);
  };
  const keepGenerated = async (name: string, body: string) => {
    const t = await state.addTemplate(name, body);
    setSelected(t.id);
  };

  return (
    <Panel
      onClose={onClose}
      closeLabel="Close templates"
      width="max-w-[1040px]"
      icon={<Tile size="lg" className="border-2 border-rim bg-note text-mud"><MessageSquareText size={20} /></Tile>}
      title="Intro message templates"
      subtitle="Write it once; each prospect's panel fills in the placeholders from that row."
    >
        <div className="flex min-h-0 flex-1">
          <div className="flex w-60 shrink-0 flex-col border-r-2 border-rim/40 bg-paper-deep/40">
            <div className="flex flex-col gap-2 border-b-2 border-rim/40 p-3">
              <Button variant="primary" size="sm" onClick={() => fire(create())}><Plus size={14} /> New template</Button>
              <Button size="sm" onClick={openGenerate} disabled={ai.loading} title={generateTitle}><Wand2 size={14} /> Generate with AI</Button>
            </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 scroll-thin">
            {templates.map((t) => (
              <li key={t.id}>
                <button onClick={() => setSelected(t.id)} className={cn(railItem(t.id === selected), "block")}>
                  <div className="truncate text-[15px] font-extrabold">{t.name || "Untitled"}</div>
                  <div className="truncate font-label text-[12px] text-mud-faint">{t.body.replace(/\s+/g, " ").slice(0, 60) || "Empty"}</div>
                </button>
              </li>
            ))}
            {!templates.length && <li className="px-2 py-6 text-center text-xs text-mud-faint">No templates yet.</li>}
          </ul>
          </div>

          {tpl ? (
            <Editor
              key={tpl.id}
              tpl={tpl}
              schema={view}
              state={state}
              preview={preview}
              previewSelect={
                <select className="field h-7 max-w-56 py-0 text-xs" value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                  {prospects.map((r) => <option key={r.id} value={r.id}>{prospectTitle(r, primaryOf(contactsOf(r.id), schema), schema).title}</option>)}
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
            <div className="flex flex-1 items-center justify-center text-sm text-mud-faint">Create a template to get started.</div>
          )}
        </div>
      {generating && state.campaign && (
        <GenerateTemplateDialog open campaignId={state.campaign.id} thesis={thesis} consent={consent} onKeep={keepGenerated} onClose={() => setGenerating(false)} />
      )}
    </Panel>
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
  const unknown = useMemo(() => mergeTemplate(body, schema, {}).unknown, [body, schema]);
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
          <UnknownPlaceholders names={unknown} />
        </div>
        <div>
          <p className="label flex items-center gap-1"><Braces size={12} /> Insert a placeholder</p>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((h) => (
              <button key={h} onClick={() => insert(h)} className="rounded-md border border-rim/40 bg-paper px-1.5 py-0.5 text-xs text-mud-soft hover:border-clay hover:bg-clay-soft/50 hover:text-clay-deep">
                {h}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-mud-faint">Tip: <code className="font-mono">{"{{Hook|your work}}"}</code> uses “your work” when the Hook cell is empty.</p>
        </div>
      </div>

      <div className="flex w-[360px] shrink-0 flex-col border-l-2 border-rim/40 bg-paper-deep/40">
        <div className="flex items-center gap-2 border-b border-rim/40 px-4 py-2.5">
          <span className="text-xs font-semibold text-mud-soft">Preview for</span>
          {previewSelect}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scroll-thin">
          {merged ? (
            <>
              <div className="rounded-xl border border-rim/40 bg-paper p-3.5 text-sm leading-relaxed whitespace-pre-wrap shadow-xs">
                <Highlighted text={merged.text} />
              </div>
              {merged.missing.length > 0 && (
                <p className="mt-2 text-xs text-mud-soft">Empty for this prospect: {merged.missing.join(", ")}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-mud-faint">Add a prospect to preview.</p>
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
        /^\{\{.*\}\}$/.test(p) ? <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-amber-900">{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}
