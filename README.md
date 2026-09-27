# Mudd.io

A local-first prospect CRM. Import a tracker spreadsheet, work it in the app, export it back with its formatting intact. Nothing leaves your computer.

## Run it

```powershell
bun install          # first time only
bun run start        # opens the Mudd.io window
```

| Command | What it does |
| --- | --- |
| `bun run start` | The app in its own window (webview-bun, same shell as motionbuff-native-app). |
| `bun run headless` | Server only. Open the printed `http://127.0.0.1:24871` in a browser. |
| `bun run dev` | Browser dev server with hot reload on `http://127.0.0.1:3000`. |
| `bun run build` | Standalone `dist/Mudd.io.exe`. |
| `bun run typecheck` | TypeScript check. |
| `bun test` | Unit and round-trip tests (see below). |

Your campaigns are stored in `%APPDATA%\Mudd.io\mudd.sqlite`. Set `MUDD_DATA_DIR` to use a different folder.

## How it works

- **Campaign** = one column schema + two buckets: **Prospects** and **Screened out**. Separate motions (aggregators, direct…) are separate campaigns.
- **Import** (.xlsx or .csv): pick which tab is Prospects and which is Screened out. Every other tab (e.g. Summary) is kept as-is and written back on export. Importing through **Import sheet** remembers the file's path, so **Save to file** can write straight back to it. A `.bak.xlsx` copy is kept each time.
- **Pipeline**: the sheet's own Status column drives the stepper (Not contacted → Contacted → Replied → Meeting booked → … → Signed, or Dead). Moving a prospect fills empty `Sent` / `Replied` dates and updates `Last touch`.
- **Mudd adds** `Meeting URL`, `Meeting at` and `Intro message` columns (and a `Screened reason` column when there's no screened tab). They go **after your last column**, so formulas pointing at existing columns keep working.
- **Templates**: per-campaign intro messages with `{{Column}}`, `{{First name}}` and `{{Column|fallback}}` placeholders. They're saved into an `Intro templates` tab on export and restored on re-import.
- **Export** patches the original workbook. Untouched cells keep their exact value, style, rich text and hyperlinks. Edited cells are written with real types (dates, numbers, links). `src/xlsx/postprocess.ts` restores the column widths and dropdown ranges that ExcelJS would otherwise rewrite.

## Tests

```powershell
$env:MUDD_FIXTURE = "C:\Users\you\Downloads\base-tracker.xlsx"; bun test
```

The round-trip suite reads your tracker from `MUDD_FIXTURE` rather than from a copy in the repo, because it contains real contact details. Without it, only the fixture-free tests run.

## Layout

```
main.ts                 native window + server worker
src/worker.ts           Bun.serve on 127.0.0.1
src/server/             REST API, SQLite, native file dialogs
src/xlsx/               import, export, style-preserving post-processing
src/shared/             types and template merging (client + server)
src/client/             React UI (Tailwind v4, lucide-react, react-hot-toast)
```

## Phase 2 (not built yet)

Enrichment pipeline and AI provider CLIs (ported from motionbuff-native-app's `app/src/agent/cli/`), plus AI-written intro messages drawn from your templates. Columns already carry an `origin`/`recipeId` field so enriched columns export like any other.
