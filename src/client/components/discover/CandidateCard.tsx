/**
 * One company in the Discovery inbox: why it fits and why now, its buying committee with a tick
 * per person, and Accept / Dismiss. A company still being mapped shows its progress; one whose
 * map turn failed offers Map again.
 */
import { AlertCircle, Ban, Building2, Check, ExternalLink, Loader2, MapPin, RefreshCw, Star, Users } from "lucide-react";
import { useState } from "react";
import type { Candidate, CandidateContact } from "../../../shared/sourcing";
import { cn } from "../../lib/cn";
import { typeTone } from "../../lib/stages";
import { openLink } from "../grid/cells";
import { CONFIDENCE_TONE, SourceChip } from "../enrich/SuggestionItem";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { Popover } from "../ui/Menu";

const FIT_TONE: Record<string, string> = {
  High: "bg-emerald-100 text-emerald-800",
  Medium: "bg-yellow-100 text-yellow-800",
  Low: "bg-paper-deep text-mud-soft",
};

export function CandidateCard({ c, typeOptions, onAccept, onDismiss, onMapAgain, busy }: {
  c: Candidate;
  /** The Contact type dropdown's options, for the role tags' colours. */
  typeOptions: string[];
  onAccept: (contactIds: string[]) => void;
  onDismiss: (reason: string) => void;
  onMapAgain: () => void;
  /** An accept or dismiss of this card is in flight. */
  busy?: boolean;
}) {
  // Ticked by default: everyone found. Unticked ids are kept, so a contact mapped later starts ticked.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = c.contacts.filter((p) => !unticked.has(p.id));
  const toggle = (id: string) => setUnticked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const mapping = c.status === "mapping";
  const facts = [
    c.whyNow && { label: "Why now", text: c.whyNow },
    c.budget && { label: "Budget source", text: c.budget },
    c.clock && { label: "Buying clock", text: c.clock },
  ].filter((x): x is { label: string; text: string } => !!x);

  return (
    <div className={cn("rounded-2xl border bg-paper p-4 transition", c.status === "error" ? "border-rose-200" : "border-rim/40 hover:border-clay")}>
      <div className="flex items-start gap-3">
        <Tile className={cn(c.fit ? FIT_TONE[c.fit] : "bg-paper-deep text-mud-soft")}><Building2 size={15} /></Tile>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[15px] font-semibold">{c.company}</h3>
            {c.fit && <span className={cn("tag", FIT_TONE[c.fit])}>{c.fit} fit</span>}
            {c.website && (
              <button onClick={() => openLink(c.website!)} className="inline-flex items-center gap-1 text-xs text-clay-deep hover:underline">
                {c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} <ExternalLink size={10} />
              </button>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-mud-faint">
            {c.location && <span className="inline-flex items-center gap-1"><MapPin size={11} /> {c.location}</span>}
            {c.employees !== null && <span className="inline-flex items-center gap-1"><Users size={11} /> ~{c.employees} staff</span>}
            {c.angle && <span>Found via {c.angle}</span>}
          </p>
        </div>
      </div>

      {c.whyFit && <p className="mt-3 text-[13px] leading-relaxed text-mud">{c.whyFit}</p>}
      {facts.length > 0 && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          {facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="font-medium text-mud-faint">{f.label}</dt>
              <dd className="text-mud-soft">{f.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {c.sources.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {c.sources.slice(0, 5).map((s) => <SourceChip key={s.url} url={s.url} title={s.title} />)}
        </div>
      )}

      {/* the buying committee */}
      <div className="mt-3 border-t border-rim/40 pt-3">
        {mapping ? (
          <p className="inline-flex items-center gap-1.5 text-xs text-mud-soft"><Loader2 size={12} className="animate-spin text-clay" /> Mapping the buying committee…</p>
        ) : c.status === "error" ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
            <AlertCircle size={13} className="shrink-0" /> <span className="min-w-0 flex-1">{c.error ?? "Its buying committee could not be mapped."}</span>
            <Button size="xs" onClick={onMapAgain}><RefreshCw size={12} /> Map again</Button>
          </div>
        ) : c.contacts.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-mud-faint">
            No one found on a page they could be checked against.
            <Button size="xs" variant="ghost" onClick={onMapAgain}><RefreshCw size={12} /> Map again</Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {c.contacts.map((p) => <ContactRow key={p.id} p={p} first={p.id === c.firstContact} checked={!unticked.has(p.id)} onToggle={() => toggle(p.id)} typeOptions={typeOptions} />)}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!mapping && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onAccept(ticked.map((p) => p.id))}>
            <Check size={13} /> Accept{ticked.length ? ` (${ticked.length} contact${ticked.length === 1 ? "" : "s"})` : ""}
          </Button>
        )}
        <DismissButton onConfirm={onDismiss} disabled={busy} />
      </div>
    </div>
  );
}

function ContactRow({ p, first, checked, onToggle, typeOptions }: { p: CandidateContact; first: boolean; checked: boolean; onToggle: () => void; typeOptions: string[] }) {
  return (
    <li className={cn("flex items-start gap-2.5 rounded-xl border p-2.5", checked ? "border-rim/40 bg-paper" : "border-transparent bg-paper-deep/40 opacity-60")}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-clay" checked={checked} onChange={onToggle} aria-label={`Include ${p.name}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold">{p.name}</span>
          {p.type && <span className={cn("tag", typeTone(p.type, typeOptions))}>{p.type}</span>}
          {first && <span className="tag bg-clay-soft text-clay-deep" title="The agent suggests approaching this person first; made Primary on accept"><Star size={10} /> Approach first</span>}
          <span className={cn("tag text-[10.5px]", CONFIDENCE_TONE[p.confidence])}>{p.confidence}</span>
          {p.title && <span className="text-xs text-mud-faint">{p.title}</span>}
        </div>
        <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
          {p.dealRole && <><dt className="font-medium text-mud-faint">Role in deal</dt><dd className="text-mud-soft">{p.dealRole}</dd></>}
          {p.gain && <><dt className="font-medium text-mud-faint">What they gain</dt><dd className="text-mud-soft">{p.gain}</dd></>}
          {p.angle && <><dt className="font-medium text-mud-faint">Angle</dt><dd className="text-mud-soft">{p.angle}</dd></>}
        </dl>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {p.linkedin && <SourceChip url={p.linkedin} title="LinkedIn profile" className="bg-sky-100" />}
          {p.source && p.source !== p.linkedin && <SourceChip url={p.source} title="Where they were found" />}
        </div>
      </div>
    </li>
  );
}

/** Dismiss, with an optional reason: later runs use it as a negative example. */
export function DismissButton({ onConfirm, disabled, align = "left" }: { onConfirm: (reason: string) => void; disabled?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Popover align={align} open={open} onOpenChange={(v) => { setOpen(v); if (!v) setReason(""); }} className="w-80 p-3" trigger={({ toggle }) => (
      <Button size="sm" onClick={toggle} disabled={disabled}><Ban size={13} /> Dismiss</Button>
    )}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(reason); setOpen(false); setReason(""); }}>
        <label className="label" htmlFor="dc-reason">Why isn't this one a fit?</label>
        <textarea id="dc-reason" autoFocus rows={3} className="field text-xs" placeholder="Optional — later searches avoid companies like this, e.g. already has an in-house team" value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit(); }} />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" type="submit">Dismiss</Button>
        </div>
      </form>
    </Popover>
  );
}
