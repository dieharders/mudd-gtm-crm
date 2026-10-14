<h1><img src="assets/icon.png" alt="" width="48" height="48" align="absmiddle"> Mudd</h1>

**Don't let your go-to-market strategy get stuck in the mud.**

A free desktop CRM for sales prospecting that works on spreadsheets you already have.

Search for and find new cold prospects and their contact information for free using your own AI agent. Track your relationships and chart your sales course for each prospect.

Open your Excel or CSV lead tracker in Mudd (pronounced Mud-d) and edit it like a CRM. Track each company and its contacts through your pipeline, let AI research the gaps and draft personal intros. The spreadsheet acts as the source of truth.

- **AI enrichment with sources**: Mudd researches each prospect on the web and fills columns you choose, such as industry, headcount or a decision-maker's name. Every suggestion links to its source, and you accept or reject it.
- **Intros that sound like you**: write templates with `{{First name}}`-style placeholders, and AI fills them in with one or two real, checkable hooks per prospect.
- **Private by design**: your data stays on your computer. There's no account, no cloud service and no API key. The AI runs through your own Claude Code or Codex sign-in and bills the plan you already pay for.
- **Free**: for Windows, macOS and Linux.

![Mudd home: your campaigns, pipeline totals and upcoming meetings](docs/screenshots/home.webp)

<table>
  <tr>
    <th width="50%">Edit like a spreadsheet</th>
    <th width="50%">Or read it prospect by prospect</th>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/table.webp" alt="Table view of a campaign" width="100%"></td>
    <td width="50%"><img src="docs/screenshots/reading.webp" alt="Reading view grouped by tier" width="100%"></td>
  </tr>
</table>

## Setup

```powershell
bun install          # first time only
bun run start        # opens the Mudd window
```

## Quickstart

| Command               | What it does                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bun run start`       | The app in its own window (webview-bun).                                                                          |
| `bun run headless`    | Server only. Open the printed `http://127.0.0.1:24871` in a browser.                                              |
| `bun run dev`         | Browser dev server with hot reload on `http://127.0.0.1:3000`.                                                    |
| `bun run build`       | Standalone `dist/Mudd.exe` (a `Mudd.app` on macOS).                                                               |
| `bun run icon`        | Rebuild `assets/icon.ico` from `assets/icon.png` (needs Edge or Chrome). Commit the result.                       |
| `bun run screenshots` | Retake the README images in `docs/screenshots/` from made-up demo data (needs Edge or Chrome). Commit the result. |
| `bun run typecheck`   | TypeScript check.                                                                                                 |
| `bun test`            | Unit and round-trip tests (see below).                                                                            |

App data is stored in `%APPDATA%\Mudd\mudd.sqlite`. Set `MUDD_DATA_DIR` to use a different folder.

## How it works

- **Campaign** = a list of prospects (companies), each with its own contacts (people), read from two tabs of a workbook: **Prospects** and **Contacts**. Every prospect has an ID (`P-001`…); each row of the Contacts tab names its prospect by that ID in a `Prospect ID` column, so renaming a company never loses its people (a `Company` column there is kept in step, for reading).
- **Contacts** have a `Contact type` (Economic Buyer, Champion, Technical Buyer, End User, Influencer, Blocker, Gatekeeper, Channel) and a `Primary` box: the primary contact is the one intros, templates (`{{First name}}`) and AI research address. The prospect panel lists a prospect's contacts and opens each one; the Contacts tab of the app lists everyone.
- **Import** (.xlsx, .csv, .tsv or .txt; not .xlsm, whose macros a save would lose): pick the prospects tab when the workbook has several; a tab named `Contacts` is read as their people (a row whose Prospect ID matches nothing is left in the file as it is). Every other tab stays in the file untouched; a tab that looks like an old Screened-out list is ignored. A tab with formulas can't be imported (writing into it would break them). Importing with the **Import** button remembers the file's path, so **Save file** writes straight back to it.
- **Remove from App** (the "…" menu on a campaign's card, or the "…" drawer in its header) takes the campaign out of the app only. The spreadsheet it came from or saves to, and Mudd's backups of it, are never deleted; import the file again to bring it back as last saved.
- **Screening out** ticks the prospect's `Screened out` column (with an optional `Screened reason`). The prospect stays where it is in the list and in the sheet, disabled in the app until you restore it. **All** counts it; the **Screened out** chip lists only those.
- **Pipeline**: the Status column drives the stepper (Not contacted → Contacted → Replied → Meeting booked → … → Signed, or Dead). Moving a prospect only changes its status: when each person was last contacted, and last replied, is kept on the contact (`Last contacted`, `Last reply`), set by hand or with one click in the contact's panel.
- **Mudd adds** `Meeting URL`, `Meeting at`, `Intro message`, `Screened out`, `Screened reason` and `ID` columns when the sheet lacks them, and a Contacts tab once there are contacts. A Contacts tab gets the `Name`, `Contact type`, `Primary`, `Last contacted` and `Last reply` columns it lacks the same way. They go **after the last column the sheet uses**, so formulas pointing at existing columns keep working.
- **Mudd's own columns** (those above, and `Status` and `Company`) are found by the header Mudd writes and no other, and are always Mudd's: on import each takes Mudd's header, type and dropdown list (the Status stages, the contact types), whatever the sheet had; its cells are kept as they are. In the app they can be hidden, not renamed or changed.
- **Templates**: per-campaign intro messages with `{{Column}}`, `{{First name}}` and `{{Column|fallback}}` placeholders. They're saved into an `Intro templates` tab and restored on re-import.
- **Save file** writes into the workbook you imported, in place: only the cells you changed are rewritten (each keeping its format); a deleted prospect's row is blanked, never removed, so nothing below it moves; new prospects go under the data. Every other part of the file (other tabs, charts, notes, SharePoint properties) is kept byte for byte. Mudd asks before replacing a file that was changed outside it, keeps the previous version as a `.bak.xlsx` next to it, and the last ten versions under `backups/` in its data folder. When Mudd doesn't know where the file is (dropped in, a CSV, created in Mudd), it saves to Downloads and keeps saving there. **Save to cloud** (SharePoint) is coming.

## File Layout

```
main.ts                 native window + server worker
src/worker.ts           Bun.serve on 127.0.0.1
src/server/             REST API, SQLite, native file dialogs
src/xlsx/               import (ExcelJS), export (patches the workbook's XML in place)
src/shared/             types and template merging (client + server)
src/client/             React UI (Tailwind v4, lucide-react, react-hot-toast)
```

## Using AI

Mudd drives **your own signed-in agent CLI**. It never stores an API key, and research bills your plan.

![AI settings: Claude Code signed in on a Max plan, billing the subscription](docs/screenshots/ai-settings.webp)

| Provider              | Needs                                      | Sign in                                             |
| --------------------- | ------------------------------------------ | --------------------------------------------------- |
| Claude Code (default) | `npm install -g @anthropic-ai/claude-code` | `claude auth login` (or **Sign in** in AI settings) |
| Codex                 | `npm install -g @openai/codex`             | `codex login`                                       |

Open **AI settings** from the bottom of the sidebar to pick the provider, model and effort. It shows the signed-in account.

**What a research turn can do.** Claude Code gets `WebSearch` and `WebFetch` and nothing else: no shell, no file access. It runs in an empty scratch folder, with your CLAUDE.md, hooks and MCP servers ignored, and with no saved session. Codex runs `exec` with a read-only sandbox. Nothing leaves the machine until you press Run, and the first run asks for consent.

### Enrichment

- **Enrich** (selection bar, shown when rows are selected): pick a preset or write a recipe.
  - A recipe is what to find, which columns to send, and which columns to fill. It targets existing columns when the headers match, otherwise it appends new ones.
  - Presets: Company snapshot, Recent news & trigger, Decision-maker, Published email (the domain's mail server is checked), Personalization hook.
  - **Test on 3 rows**, then **Run** on the selection, on rows missing the fields, or on everything.
  - Runs have pause, resume and stop, choose how many rows run at once, and retry failed rows automatically.

![Enrich with AI: the Company snapshot preset, the columns it fills, and a run on three selected rows](docs/screenshots/enrich.webp)

- **Review**: every finding is a suggestion, with its source link and a confidence level.
  - Accepting writes the cell (with undo) and adds the link to an `Enrichment sources` column.
  - "Fill empty cells automatically" skips review only for cells that are empty.
  - A violet dot on a cell means it has a suggestion waiting.

![Review suggestions: what an enrichment run found for each prospect, with its source and confidence, waiting to be accepted or rejected](docs/screenshots/enrich-review.webp)

### Outbound templates

![Intro message templates: a template with placeholders and its preview filled in for one prospect](docs/screenshots/outbound-templates.webp)

- **Write with AI** (prospect panel → Intro message): let the AI pick the best-fitting template, or choose one.
  - It fills the placeholders, researches 1–2 verifiable hooks and shows a draft with those sources. Use it, try again, or discard it.
  - **Draft intros** in the bulk bar does the same for every selected row.

### Discover

Start a campaign with **Discover prospects** and Mudd finds companies that fit your ideal customer, with who to talk to at each. You review every one before it joins the list.

![Discover: a Find run in progress, searching several angles at once](docs/screenshots/discover.webp)

- **Thesis**: sixteen questions about who you sell to. The first two are required; **Fill blanks with AI** drafts the rest.
- **Find**: pick how many companies and contacts per company, add a focus for this run, and choose which enrichments run on each company you accept. The run plans a few search angles, searches them two at a time, then maps each company's buying committee.
- **Inbox**: each candidate shows why it fits, why now, and the page it was found on. Accept adds it (and its contacts) as prospects; dismiss with a reason, and later runs avoid that kind.

![Discover inbox: candidate companies with why they fit, why now, their sources and who to approach first](docs/screenshots/discover-inbox.webp)

## License

Copyright (C) 2026 OpenBrew.ai

Mudd is licensed under the [GNU Affero General Public License v3.0](LICENSE) only (`AGPL-3.0-only`). Use it for anything, including at work, and change and share it. Anything you share that's built from Mudd, in whole or in part, must be under the same license with its complete source, and so must a changed Mudd that you run as a service for others. Provided as is, without warranty.

**Additional permission under GNU AGPL version 3 section 7:** if you modify this program, or any covered work, by linking or combining it with Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), containing parts covered by the terms of Anthropic's own license, the licensors of this program grant you additional permission to convey the resulting work. Mudd's builds include that SDK, which is not free software; its source is not part of Mudd's Corresponding Source.
