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

## AI: enrichment and intro messages

Mudd drives **your own signed-in agent CLI**, the same way motionbuff-native-app does. It never stores an API key, and research bills your plan.

| Provider | Needs | Sign in |
| --- | --- | --- |
| Claude Code (default) | `npm install -g @anthropic-ai/claude-code` | `claude auth login` (or **Sign in** in AI settings) |
| Codex | `npm install -g @openai/codex` | `codex login` |

Open **AI settings** from the bottom of the sidebar to pick the provider, model and effort. It shows the signed-in account and whether usage bills your subscription or an API key. "Bill my Claude subscription only" removes `ANTHROPIC_API_KEY` from the CLI's environment. It is switched off automatically if that key is your only credential.

**What a research turn can do.** Claude Code gets `WebSearch` and `WebFetch` and nothing else: no shell, no file access. It runs in an empty scratch folder, with your CLAUDE.md, hooks and MCP servers ignored, and with no saved session. Codex runs `exec` with a read-only sandbox. Nothing leaves the machine until you press Run, and the first run asks for consent.

- **Enrich** (campaign toolbar): pick a preset or write a recipe.
  - A recipe is what to find, which columns to send, and which columns to fill. It targets existing columns when the headers match, otherwise it appends new ones.
  - Presets: Company snapshot, Recent news & trigger, Decision-maker, Published email (the domain's mail server is checked), Personalization hook.
  - **Test on 3 rows**, then **Run** on the selection, on rows missing the fields, or on everything.
  - Runs have pause, resume and stop, choose how many rows run at once, and retry failed rows automatically.
- **Review**: every finding is a suggestion, with its source link and a confidence level.
  - Accepting writes the cell (with undo) and adds the link to an `Enrichment sources` column.
  - "Fill empty cells automatically" skips review only for cells that are empty.
  - A violet dot on a cell means it has a suggestion waiting.
- **Write with AI** (prospect panel → Intro message): let the AI pick the best-fitting template, or choose one.
  - It fills the placeholders, researches 1–2 verifiable hooks and shows a draft with those sources. Use it, try again, or discard it.
  - **Draft intros** in the bulk bar does the same for every selected row.

Code: `src/server/ai/` (providers, discovery, environment, structured turns), `src/server/enrich/` (runner, prompts, storage, event stream), and `src/client/components/{ai,enrich}/`.
