import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { PageTitle } from "../ui/PageTitle";
import { NOTES, TOPICS, type GuideNote, type Topic } from "./guideNotes";

/** Each topic's paper, so the notes of one topic read as a set across the wall. */
const PAPER: Record<Topic, string> = {
  "Start here": "bg-note",
  "Your list": "bg-paper",
  "Pipeline": "bg-note-mint",
  "AI research": "bg-clay-soft",
  "Discover": "bg-lake-soft",
  "Messages": "bg-note-pink",
  "Saving": "bg-paper-deep",
};

// A lean, a nudge and a drop per note, picked by its title, so the wall looks pinned up by hand
// rather than gridded, and each note looks the same every visit.
const TILTS = ["-rotate-[1.4deg]", "rotate-[0.9deg]", "-rotate-[0.5deg]", "rotate-[1.6deg]", "rotate-[0.3deg]", "-rotate-[1deg]", "rotate-[0.6deg]"];
const NUDGES = ["", "ml-4", "mr-3", "ml-1.5", "mr-5", "ml-6", "mr-1"];
const DROPS = ["pt-3", "pt-5", "pt-3", "pt-7", "pt-4"];

/** A small stable number from a string (FNV-1a). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const pick = <T,>(list: readonly T[], seed: number) => list[seed % list.length]!;

/**
 * Every note in an order where none sits beside, below or diagonally below one of its own topic,
 * as far as the topics allow: "What is Mudd?" first, then always a topic with the most notes left
 * (so no one topic is left to pile up at the end), its next note in the guide's order. Ties break
 * by a hash, so it looks shuffled but is the same every visit.
 */
function scatter(notes: readonly GuideNote[], cols: number): GuideNote[] {
  const left = new Map<Topic, GuideNote[]>();
  for (const n of notes) left.set(n.topic, [...(left.get(n.topic) ?? []), n]);
  const out: GuideNote[] = [];
  while (out.length < notes.length) {
    const p = out.length;
    // The note to the left, and the ones above-left, above and above-right.
    const near = (strict: boolean) => new Set([
      ...(p % cols ? [out[p - 1]] : []),
      ...(strict ? [out[p - cols - 1], out[p - cols + 1]] : []),
      out[p - cols],
    ].filter(Boolean).map((n) => n!.topic));
    const open = [...left].filter(([, ns]) => ns.length);
    const ok = (strict: boolean) => open.filter(([t]) => !near(strict).has(t));
    const choices = p === 0 ? open.filter(([t]) => t === "Start here") : ok(true).length ? ok(true) : ok(false).length ? ok(false) : open;
    choices.sort(([a, x], [b, y]) => y.length - x.length || hash(`${a}${p}`) - hash(`${b}${p}`));
    out.push(choices[0]![1].shift()!);
  }
  return out;
}

/** *Label* is a control, shown bold; `Key` is a key to press. */
function rich(text: string): ReactNode {
  return text.split(/(\*[^*]+\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <b key={i} className="font-extrabold text-mud">{part.slice(1, -1)}</b>
    : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <kbd key={i} className="rounded-sm border border-rim/70 bg-paper px-1 font-label text-[0.75rem] text-mud">{part.slice(1, -1)}</kbd>
    : <Fragment key={i}>{part}</Fragment>,
  );
}

/** How many columns of notes fit the wall: one under 36rem, two under 56rem, else three. */
function useColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const rem = el.clientWidth / parseFloat(getComputedStyle(document.documentElement).fontSize);
      setCols(rem < 36 ? 1 : rem < 56 ? 2 : 3);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, cols };
}

/** The how-to wall: every note a new user needs, pinned or taped up by topic. */
export function GuidePage() {
  const [topic, setTopic] = useState<Topic | null>(null);
  const { ref: wall, cols } = useColumns();
  const shown = useMemo(() => (topic ? NOTES.filter((n) => n.topic === topic) : scatter(NOTES, cols)), [topic, cols]);
  return (
    <div className="h-full overflow-y-auto bg-board scroll-thin">
      <div className="@container mx-auto max-w-6xl px-6 py-8 motion-safe:animate-page-in md:px-10 md:py-10">
        <PageTitle>Guide</PageTitle>
        <p className="mt-3 max-w-xl text-[0.9375rem] text-mud-soft">Short notes on how everything works. Pick a topic, or read the whole wall.</p>

        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Topics">
          <TopicChip on={topic === null} onClick={() => setTopic(null)} paper="bg-paper">Every topic</TopicChip>
          {TOPICS.map((t) => (
            <TopicChip key={t} on={topic === t} onClick={() => setTopic(topic === t ? null : t)} paper={PAPER[t]}>{t}</TopicChip>
          ))}
        </div>

        {/* Flex columns, not CSS columns: those slice a tilted note's corner and shadow at a column's
            end and paint the rest atop the next. Dealt left to right, so the wall reads across. */}
        <div ref={wall} className="mt-10 flex items-start gap-7">
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="min-w-0 flex-1">
              {shown.map((n, i) => (i % cols === c ? <Note key={n.title} n={n} /> : null))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TopicChip({ on, onClick, paper, children }: { on: boolean; onClick: () => void; paper: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-lg border-2 px-3 py-1 font-label text-[0.8125rem] transition",
        paper,
        on ? "border-rim font-bold text-mud shadow-hard-sm" : "border-rim/40 text-mud-soft hover:border-rim hover:text-mud",
      )}
    >
      {children}
    </button>
  );
}

function Note({ n }: { n: GuideNote }) {
  const seed = hash(n.title);
  // About one in three is taped up rather than pinned.
  const taped = (seed >>> 8) % 3 === 0;
  return (
    <div className={cn("mb-7", pick(NUDGES, seed >>> 4), pick(DROPS, seed >>> 12))}>
      <article className={cn("relative rounded-xl border-2 border-rim p-5 pt-6 shadow-hard", PAPER[n.topic], pick(TILTS, seed))}>
        {taped
          ? <span aria-hidden className="absolute -top-3 left-1/2 h-6 w-20 -translate-x-1/2 -rotate-3 border border-rim/30 bg-paper/70 shadow-sm" />
          : <span aria-hidden className="pin" />}
        <span className="font-label text-[0.6875rem] text-mud-faint">{n.topic}</span>
        <h2 className="mt-0.5 font-display text-[1.1875rem] leading-tight font-bold">{n.title}</h2>
        <div className="mt-2.5 space-y-2 text-[0.875rem] leading-relaxed text-mud-soft">
          {n.text && <p>{rich(n.text)}</p>}
          {n.steps && (
            <ol className="list-decimal space-y-1 pl-5 marker:font-label marker:font-bold marker:text-clay-deep">
              {n.steps.map((s) => <li key={s}>{rich(s)}</li>)}
            </ol>
          )}
          {n.bullets && (
            <ul className="list-disc space-y-1 pl-5 marker:text-rim">
              {n.bullets.map((s) => <li key={s}>{rich(s)}</li>)}
            </ul>
          )}
          {n.tip && <p className="border-t-2 border-dashed border-rim/30 pt-2 font-label text-[0.8125rem]">💡 {rich(n.tip)}</p>}
        </div>
      </article>
    </div>
  );
}
