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
