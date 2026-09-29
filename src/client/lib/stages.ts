/** Colours for pipeline stages: Clay-style pastel tags. Unknown stages cycle a palette. */
import { DEAD } from "../../shared/types";

export interface Tone {
  pill: string;
  dot: string;
  bar: string;
}

const T = (pill: string, dot: string, bar: string): Tone => ({ pill, dot, bar });

const KNOWN: Record<string, Tone> = {
  "not contacted": T("bg-zinc-100 text-zinc-600", "bg-zinc-400", "bg-zinc-300"),
  contacted: T("bg-sky-100 text-sky-800", "bg-sky-500", "bg-sky-400"),
  replied: T("bg-violet-100 text-violet-800", "bg-violet-500", "bg-violet-400"),
  "meeting booked": T("bg-yellow-100 text-yellow-800", "bg-yellow-400", "bg-yellow-300"),
  "clinic held": T("bg-pink-100 text-pink-800", "bg-pink-500", "bg-pink-400"),
  trial: T("bg-orange-100 text-orange-800", "bg-orange-500", "bg-orange-400"),
  signed: T("bg-emerald-100 text-emerald-800", "bg-emerald-500", "bg-emerald-500"),
  [DEAD.toLowerCase()]: T("bg-rose-100 text-rose-700", "bg-rose-500", "bg-rose-400"),
};

const CYCLE: Tone[] = [
  T("bg-cyan-100 text-cyan-800", "bg-cyan-500", "bg-cyan-400"),
  T("bg-fuchsia-100 text-fuchsia-800", "bg-fuchsia-500", "bg-fuchsia-400"),
  T("bg-lime-100 text-lime-800", "bg-lime-500", "bg-lime-400"),
  T("bg-indigo-100 text-indigo-800", "bg-indigo-500", "bg-indigo-400"),
];

export function toneFor(stage: string | null | undefined, stages: string[] = []): Tone {
  if (!stage) return KNOWN["not contacted"]!;
  const k = KNOWN[stage.toLowerCase()];
  if (k) return k;
  const i = stages.indexOf(stage);
  return CYCLE[(i < 0 ? stage.length : i) % CYCLE.length]!;
}

/** Icon tiles for campaigns: a pastel square per campaign, picked from its id. */
const TILES = [
  "bg-violet-100 text-violet-700",
  "bg-sky-100 text-sky-700",
  "bg-yellow-100 text-yellow-700",
  "bg-pink-100 text-pink-700",
  "bg-emerald-100 text-emerald-700",
  "bg-orange-100 text-orange-700",
];
export function tileFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length]!;
}

/** Colours for contact types: one per type, in the Contact type dropdown's order. */
const TYPE_TONES = [
  "bg-violet-100 text-violet-800",
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-zinc-200 text-zinc-700",
  "bg-pink-100 text-pink-800",
  "bg-cyan-100 text-cyan-800",
];
export function typeTone(type: string, options: string[] = []): string {
  const i = options.findIndex((o) => o.toLowerCase() === type.toLowerCase());
  return TYPE_TONES[(i < 0 ? type.length : i) % TYPE_TONES.length]!;
}
