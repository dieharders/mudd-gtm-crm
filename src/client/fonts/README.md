# Bundled fonts

The page's Content-Security-Policy allows fonts from the app's own origin only, so these ship in
the repo and are referenced by `@font-face` in `../styles.css`. Libron and Nunito are under the SIL Open
Font License 1.1, Comic Mono under MIT. Bun inlines every face into the generated stylesheet, so only
the faces the app sets are bundled: headings are always bold Libron, and nothing is italic.

| Family | Files | Source | Licence |
| --- | --- | --- | --- |
| Libron (serif, headings) | `Libron-Bold.woff2` | https://github.com/nicoverbruggen/libron, release v0.31 (`Libron_Web.zip`) | `Libron-OFL.txt` (Reserved Font Name "Libron") |
| Nunito (rounded sans, UI text) | `Nunito-Latin.woff2` (variable, weight 400-900, latin subset) | https://github.com/googlefonts/nunito via Google Fonts v32 | `Nunito-OFL.txt` |
| Comic Mono (labels, tags, notes) | `ComicMono-Regular.woff2`, `ComicMono-Bold.woff2` | https://github.com/dtinth/comic-mono-font via `@fontsource/comic-mono` | `ComicMono-LICENSE.txt` (MIT) |

## Recentred metrics

Nunito and Comic Mono are not byte-for-byte upstream. Their vertical metrics are rewritten so the line box is
centred on the drawn cap height (the top of `H`), which lines labels up with the icons beside them in a
`flex items-center` row. Upstream, both fonts sit 1.5-3px high in WebKit. Comic Mono's declared `sCapHeight`
(1180) is also well short of its real capitals (1463). Only where the box is centred changes: the total
ascent + descent stays the same, so line heights do not move. Libron (headings, rarely beside an icon) is
untouched.

To redo this after updating a font, run this with `fonttools` and `brotli` installed: centre ascent minus
descent on the cap height, write it to `hhea`, `OS/2` typo and `OS/2` win alike, and set `USE_TYPO_METRICS`.

```python
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
t = TTFont(path); o, h = t["OS/2"], t["hhea"]
total = h.ascent - h.descent + h.lineGap
gs = t.getGlyphSet(); pen = BoundsPen(gs); gs[t.getBestCmap()[ord("H")]].draw(pen)
cap = round(pen.bounds[3]); asc = (total + cap) // 2; desc = total - asc
h.ascent, h.descent, h.lineGap = asc, -desc, 0
o.sTypoAscender, o.sTypoDescender, o.sTypoLineGap = asc, -desc, 0
o.usWinAscent, o.usWinDescent, o.sCapHeight = asc, desc, cap
o.fsSelection |= 1 << 7; o.version = max(o.version, 4)
t.flavor = "woff2"; t.save(path)
```

Result (ascent / descent, units per em): Nunito 1037 / 327 (of 1000), Comic Mono Regular 1871 / 409 and Bold
1889 / 425 (of 2048).
