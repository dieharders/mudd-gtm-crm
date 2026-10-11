/** Outlined paper tiles for campaigns: the same hash as tileFor, with a rim. */
const TILES = ["bg-clay-soft", "bg-lake-soft", "bg-note", "bg-note-pink", "bg-note-mint", "bg-paper-deep"];

export function paperTileFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${TILES[h % TILES.length]!} border-2 border-rim text-mud`;
}
