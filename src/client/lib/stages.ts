/** Colours for pipeline stages. Known names get fixed colours; anything else cycles a palette. */
import { DEAD } from "../../shared/types";

export interface Tone {
  pill: string;
  dot: string;
  bar: string;
}

const T = (pill: string, dot: string, bar: string): Tone => ({ pill, dot, bar });

const KNOWN: Record<string, Tone> = {
  "not contacted": T("bg-stone-100 text-stone-600 ring-stone-200", "bg-stone-400", "bg-stone-300"),
  contacted: T("bg-sky-50 text-sky-700 ring-sky-200", "bg-sky-500", "bg-sky-400"),
  replied: T("bg-indigo-50 text-indigo-700 ring-indigo-200", "bg-indigo-500", "bg-indigo-400"),
  "meeting booked": T("bg-amber-50 text-amber-800 ring-amber-200", "bg-amber-500", "bg-amber-400"),
  "clinic held": T("bg-teal-50 text-teal-700 ring-teal-200", "bg-teal-500", "bg-teal-400"),
  trial: T("bg-lime-50 text-lime-800 ring-lime-200", "bg-lime-500", "bg-lime-400"),
  signed: T("bg-emerald-50 text-emerald-700 ring-emerald-200", "bg-emerald-500", "bg-emerald-500"),
  [DEAD.toLowerCase()]: T("bg-rose-50 text-rose-700 ring-rose-200", "bg-rose-500", "bg-rose-400"),
};

const CYCLE: Tone[] = [
  T("bg-violet-50 text-violet-700 ring-violet-200", "bg-violet-500", "bg-violet-400"),
  T("bg-cyan-50 text-cyan-700 ring-cyan-200", "bg-cyan-500", "bg-cyan-400"),
  T("bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200", "bg-fuchsia-500", "bg-fuchsia-400"),
  T("bg-orange-50 text-orange-700 ring-orange-200", "bg-orange-500", "bg-orange-400"),
];

export function toneFor(stage: string | null | undefined, stages: string[] = []): Tone {
  if (!stage) return KNOWN["not contacted"]!;
  const k = KNOWN[stage.toLowerCase()];
  if (k) return k;
  const i = stages.indexOf(stage);
  return CYCLE[(i < 0 ? stage.length : i) % CYCLE.length]!;
}
