/** Colours for pipeline stages: Clay-style pastel tags. Unknown stages cycle a palette. */
import { DEAD } from "../../shared/types";

export interface Tone {
  pill: string;
  dot: string;
  bar: string;
}

const T = (pill: string, dot: string, bar: string): Tone => ({ pill, dot, bar });

const KNOWN: Record<string, Tone> = {
  "not contacted": T("bg-paper-deep text-mud-soft", "bg-rim/60", "bg-rim/40"),
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

/** One entry of `list` for this id, the same one every time: a string hash, so tiles stay put across reloads. */
export function pickFor<T>(list: readonly T[], id: string): T {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length]!;
}

/** The paper pastels a tile is filled with, each with the ink a person's initial takes on it. */
const TILES = [
  { fill: "bg-clay-soft", ink: "text-clay-deep" },
  { fill: "bg-lake-soft", ink: "text-lake-deep" },
  { fill: "bg-note", ink: "text-mud" },
  { fill: "bg-note-pink", ink: "text-mud" },
  { fill: "bg-note-mint", ink: "text-mud" },
  { fill: "bg-paper-deep", ink: "text-mud-soft" },
];
/** Avatar tiles for people: a paper pastel per contact, picked from its id. */
export const tileFor = (id: string): string => {
  const t = pickFor(TILES, id);
  return `${t.fill} ${t.ink}`;
};
/** Tiles for campaigns: the same pick of pastel, outlined, in mud ink. */
export const campaignTileFor = (id: string): string => `${pickFor(TILES, id).fill} border-2 border-rim text-mud`;

/** Colours for contact types: one per type, in the Contact type dropdown's order. */
const TYPE_TONES = [
  "bg-violet-100 text-violet-800",
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-paper-deep text-mud-soft",
  "bg-pink-100 text-pink-800",
  "bg-cyan-100 text-cyan-800",
];
export function typeTone(type: string, options: string[] = []): string {
  const i = options.findIndex((o) => o.toLowerCase() === type.toLowerCase());
  return TYPE_TONES[(i < 0 ? type.length : i) % TYPE_TONES.length]!;
}
