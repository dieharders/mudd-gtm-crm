/**
 * "Generate with AI" for templates: the user says what problem they are working on (prefilled from
 * the ICP thesis when the campaign has one), the AI drafts a template around it, and the draft is
 * shown before anything is saved: Keep adds it, Regenerate tries again, Discard drops it.
 */
import { RefreshCw, Wand2 } from "lucide-react";
import { useState } from "react";
import { OUTREACH_PROBLEM_IDS, THESIS_QUESTIONS } from "../../../shared/thesis";
import type { Thesis } from "../../../shared/types";
import type { ConsentGate } from "../../hooks/useConsentGate";
import { api, type GeneratedTemplate } from "../../lib/api";
import { fire } from "../../lib/fire";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { UnknownPlaceholders } from "./UnknownPlaceholders";

/** A first draft of the problem description, from the thesis; empty without one. */
export function prefillFromThesis(thesis: Thesis | null): string {
  if (!thesis) return "";
  return OUTREACH_PROBLEM_IDS
    .map((id) => {
      const a = thesis.answers[id]?.trim();
      const q = THESIS_QUESTIONS.find((x) => x.id === id);
      return a && q ? `${q.label}: ${a}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function GenerateTemplateDialog({ open, campaignId, thesis, consent, onKeep, onClose }: {
  open: boolean;
  campaignId: string;
  thesis: Thesis | null;
  consent: ConsentGate;
  onKeep: (name: string, body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState(() => prefillFromThesis(thesis));
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<GeneratedTemplate | null>(null);
  const [name, setName] = useState("");

  const generate = async () => {
    setBusy(true);
    try {
      const d = await consent.withConsent(() => api.generateTemplate(campaignId, problem));
      if (d) {
        // A name the user already edited survives a regenerate; the model's is taken otherwise.
        setName((cur) => (draft && cur.trim() && cur !== draft.name ? cur : d.name));
        setDraft(d);
      }
    } finally {
      setBusy(false);
    }
  };
  const keep = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await onKeep(name.trim() || draft.name, draft.body);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const canGenerate = problem.trim().length > 0 && !busy;
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      width="max-w-2xl"
      title={draft ? "Your draft" : "Generate a template"}
      subtitle={draft
        ? "Keep it to add it to your templates, where you can edit it."
        : "The AI writes an intro around the problem you're exploring: passionate about it, still learning, how you think about it, and an ask for their insight. It never claims a finished product."}
      footer={draft ? (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Discard</Button>
          <Button onClick={() => fire(generate())} disabled={busy}><RefreshCw size={14} /> {busy ? "Drafting…" : "Regenerate"}</Button>
          <Button variant="primary" onClick={() => fire(keep())} disabled={busy}>Keep</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => fire(generate())} disabled={!canGenerate}><Wand2 size={14} /> {busy ? "Drafting…" : "Generate"}</Button>
        </>
      )}
    >
      {draft ? (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="gen-name">Name</label>
            <input id="gen-name" className="field" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
          <div>
            <p className="label">Message</p>
            <div className="rounded-xl border border-line bg-white p-3.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap shadow-xs" data-testid="gen-body">{draft.body}</div>
            <UnknownPlaceholders names={draft.unknown} />
          </div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="gen-problem">The problem you're working on, and how you think about it</label>
          <p className="mb-1.5 text-[11px] text-ink-faint">Who has it, what it costs them, and what a solution might look like. Your words; the AI keeps them as the point of the message.</p>
          <textarea
            id="gen-problem"
            rows={7}
            className="field resize-y text-[13px] leading-relaxed"
            placeholder="e.g. Small manufacturers get hit by cyber incidents they never see coming, and the security tools they can afford assume a team they don't have. We're exploring what monitoring that fits a two-person IT shop might look like."
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>
      )}
    </Modal>
  );
}
