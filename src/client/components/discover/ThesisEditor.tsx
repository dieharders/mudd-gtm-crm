/**
 * The ICP thesis: sixteen questions in four sections, autosaved as typed. "Fill blanks with AI"
 * drafts the empty ones; a draft stays tagged until the user edits or keeps it.
 */
import { ArrowRight, Check, Sparkles, Wand2 } from "lucide-react";
import { blankQuestions, canFind, THESIS_SECTIONS } from "../../../shared/thesis";
import type { DiscoveryState } from "../../hooks/useDiscovery";
import { Button } from "../ui/Button";
import { fire } from "../../lib/fire";

export function ThesisEditor({ discovery, ready, onSetup, onNext }: {
  discovery: DiscoveryState;
  /** The AI is set up and signed in. */
  ready: boolean;
  onSetup: () => void;
  /** Shown as "Next: find prospects" until the first run; absent afterwards. */
  onNext?: () => void;
}) {
  const { thesis } = discovery;
  if (!thesis) return null;
  const blanks = blankQuestions(thesis);
  const drafting = discovery.activeRuns.some((r) => r.kind === "thesis");
  const busy = discovery.activeRuns.length > 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Your ideal customer</h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            Discovery searches from these answers. The first two are required; the rest make the search sharper, and the AI can draft any you leave blank.
            {blanks.length > 0 && <> <b className="text-ink">{blanks.length}</b> of {THESIS_SECTIONS.reduce((n, s) => n + s.questions.length, 0)} still blank.</>}
          </p>
        </div>
        {!ready ? (
          <Button onClick={onSetup}>Set up AI first</Button>
        ) : (
          <Button onClick={() => fire(discovery.start({ kind: "thesis" }))} disabled={!blanks.length || busy} title={blanks.length ? "Draft answers for the blank questions" : "Every question is answered"}>
            <Wand2 size={14} /> {drafting ? "Drafting…" : "Fill blanks with AI"}
          </Button>
        )}
      </div>

      {THESIS_SECTIONS.map((section) => (
        <section key={section.id}>
          <p className="eyebrow mb-2">{section.label}</p>
          <div className="space-y-3">
            {section.questions.map((q) => {
              const value = thesis.answers[q.id] ?? "";
              const draft = thesis.drafted.includes(q.id);
              return (
                <div key={q.id}>
                  <div className="flex items-center gap-2">
                    <label className="label mb-0" htmlFor={`th-${q.id}`}>{q.label}{q.required && <span className="text-rose-500"> *</span>}</label>
                    {draft && (
                      <>
                        <span className="tag bg-violet-100 text-violet-800"><Sparkles size={10} /> AI draft</span>
                        <button className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:underline" onClick={() => discovery.keepDraft(q.id)}>
                          <Check size={11} /> Keep
                        </button>
                      </>
                    )}
                  </div>
                  <p className="mt-0.5 mb-1 text-[11px] text-ink-faint">{q.help}</p>
                  <textarea
                    id={`th-${q.id}`}
                    rows={value.length > 160 ? 4 : 2}
                    className="field resize-y text-[13px] leading-relaxed"
                    placeholder={`e.g. ${q.example}`}
                    value={value}
                    onChange={(e) => discovery.setAnswer(q.id, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {onNext && (
        <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
          {!canFind(thesis) && <span className="text-xs text-ink-faint">Answer the two required questions to go on.</span>}
          <Button variant="primary" onClick={onNext} disabled={!canFind(thesis)}>Next: find prospects <ArrowRight size={14} /></Button>
        </div>
      )}
    </div>
  );
}
