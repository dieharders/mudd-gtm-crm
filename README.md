# Mudd.io

A local-first prospect CRM. Import a tracker spreadsheet, work it in the app, export it back with its formatting intact. Nothing leaves your computer.

## Setup

```powershell
bun install          # first time only
bun run start        # opens the Mudd.io window
```

## Quickstart

| Command | What it does |
| --- | --- |
| `bun run start` | The app in its own window (webview-bun, same shell as motionbuff-native-app). |
| `bun run headless` | Server only. Open the printed `http://127.0.0.1:24871` in a browser. |
| `bun run dev` | Browser dev server with hot reload on `http://127.0.0.1:3000`. |
| `bun run build` | Standalone `dist/Mudd.io.exe` (a `Mudd.io.app` on macOS). |
| `bun run icon` | Rebuild `assets/icon.ico` from `assets/icon.svg` (needs Edge or Chrome). Commit the result. |
| `bun run typecheck` | TypeScript check. |
| `bun test` | Unit and round-trip tests (see below). |

Your campaigns are stored in `%APPDATA%\Mudd.io\mudd.sqlite`. Set `MUDD_DATA_DIR` to use a different folder.

## Releases

Bump `version` in package.json, then run **Actions → Manual Release → Run workflow** with the tag `v<version>` (e.g. `v0.1.4`). It builds a zip for Windows x64, macOS (Apple silicon and Intel) and Linux x64 and, only if all four succeed, attaches them to a **draft** release. Publish the draft from the Releases page when you're ready; that creates the tag. The builds are unsigned (macOS is ad-hoc signed), so Windows and macOS warn on first launch.

## How it works

- **Campaign** = a list of prospects (companies), each with its own contacts (people), read from two tabs of a workbook: **Prospects** and **Contacts**. Every prospect has an ID (`P-001`…); each row of the Contacts tab names its prospect by that ID in a `Prospect ID` column, so renaming a company never loses its people (a `Company` column there is kept in step, for reading).
- **Contacts** have a `Contact type` (Economic Buyer, Technical Buyer, End User, Influencer, Blocker, Gatekeeper) and a `Primary` box: the primary contact is the one intros, templates (`{{First name}}`) and AI research address. The prospect panel lists a prospect's contacts and opens each one; the Contacts tab of the app lists everyone.
- **Import** (.xlsx, .csv, .tsv or .txt; not .xlsm, whose macros a save would lose): pick the prospects tab when the workbook has several; a tab named `Contacts` is read as their people (a row whose Prospect ID matches nothing is left in the file as it is). Every other tab stays in the file untouched; a tab that looks like an old Screened-out list is ignored. A tab with formulas can't be imported (writing into it would break them). Importing with the **Import** button remembers the file's path, so **Save file** writes straight back to it.
- **Remove from Mudd** (the "…" menu on a campaign's card or in its header) takes the campaign out of the app only. The spreadsheet it came from or saves to, and Mudd's backups of it, are never deleted; import the file again to bring it back as last saved.
- **Screening out** ticks the prospect's `Screened out` column (with an optional `Screened reason`). The prospect stays where it is in the list and in the sheet, disabled in the app until you restore it.
- **Pipeline**: the sheet's own Status column drives the stepper (Not contacted → Contacted → Replied → Meeting booked → … → Signed, or Dead). Moving a prospect, in the panel or the grid, fills empty `Sent` / `Replied` dates and updates `Last touch`.
- **Mudd adds** `Meeting URL`, `Meeting at`, `Intro message`, `Screened out`, `Screened reason` and `ID` columns when the sheet lacks them, and a Contacts tab once there are contacts. They go **after the last column the sheet uses**, so formulas pointing at existing columns keep working.
- **Templates**: per-campaign intro messages with `{{Column}}`, `{{First name}}` and `{{Column|fallback}}` placeholders. They're saved into an `Intro templates` tab and restored on re-import.
- **Save file** writes into the workbook you imported, in place: only the cells you changed are rewritten (each keeping its format); a deleted prospect's row is blanked, never removed, so nothing below it moves; new prospects go under the data. Every other part of the file (other tabs, charts, notes, SharePoint properties) is kept byte for byte. Mudd asks before replacing a file that was changed outside it, keeps the previous version as a `.bak.xlsx` next to it, and the last ten versions under `backups/` in its data folder. When Mudd doesn't know where the file is (dropped in, a CSV, created in Mudd), it saves to Downloads and keeps saving there. **Save to cloud** (SharePoint) is coming.

## Tests

```powershell
$env:MUDD_FIXTURE = "C:\Users\you\Downloads\base-tracker.xlsx"; bun test
```

The round-trip suite builds workbooks with the features real trackers have (formulas on another tab, column formats, notes, merges, dropdowns, tables) and checks what a save keeps. It can also read your own tracker from `MUDD_FIXTURE`, rather than from a copy in the repo, because a tracker contains real contact details.

## Layout

```
main.ts                 native window + server worker
src/worker.ts           Bun.serve on 127.0.0.1
src/server/             REST API, SQLite, native file dialogs
src/xlsx/               import (ExcelJS), export (patches the workbook's XML in place)
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
