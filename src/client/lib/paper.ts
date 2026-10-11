/** Outlined paper tiles for campaigns: the same pick as tileFor, with a rim. */
import { pickFor } from "./stages";

const TILES = ["bg-clay-soft", "bg-lake-soft", "bg-note", "bg-note-pink", "bg-note-mint", "bg-paper-deep"];

export const paperTileFor = (id: string): string => `${pickFor(TILES, id)} border-2 border-rim text-mud`;
