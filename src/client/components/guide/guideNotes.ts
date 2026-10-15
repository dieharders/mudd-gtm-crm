/**
 * The Guide page's notes: short how-tos written for a new user. In the text, *Label* is a button
 * or menu item (shown bold) and `Key` is a key to press.
 */
export type Topic = "Start here" | "Your list" | "Pipeline" | "AI research" | "Discover" | "Messages" | "Saving";

export interface GuideNote {
  topic: Topic;
  title: string;
  text?: string;
  steps?: string[];
  bullets?: string[];
  tip?: string;
}

export const TOPICS: Topic[] = ["Start here", "Your list", "Pipeline", "AI research", "Discover", "Messages", "Saving"];

export const NOTES: GuideNote[] = [
  // ---------- Start here ----------
  {
    topic: "Start here",
    title: "What is Mudd?",
    text: "Mudd keeps your list of companies to sell to, and helps you reach them.",
    bullets: ["A *campaign* is one list.", "A *prospect* is a company.", "A *contact* is a person at that company.", "Everything stays on this computer."],
  },
  {
    topic: "Start here",
    title: "Start a new campaign",
    steps: ["Click *New campaign*.", "Type a name.", "Pick how to start: from scratch, copy another campaign's columns, or let AI discover companies.", "Click *Create campaign*."],
  },
  {
    topic: "Start here",
    title: "Bring in your spreadsheet",
    steps: ["On Home, click *Import sheet*. You can also drop a file on the window.", "Pick the tab that holds your companies.", "Click *Import campaign*."],
    tip: "Works with .xlsx and .csv files. A tab named Contacts comes in as people.",
  },
  {
    topic: "Start here",
    title: "Turn on AI",
    steps: ["Click the AI button at the bottom of the sidebar.", "Pick Claude Code or Codex.", "Click *Install*, then *Sign in*.", "A green dot means it's ready."],
    tip: "AI uses your own Claude or ChatGPT plan. Mudd stores no keys.",
  },

  // ---------- Your list ----------
  {
    topic: "Your list",
    title: "Prospects and contacts",
    bullets: ["Prospects are companies. Contacts are people.", "Switch lists with the *Prospects* and *Contacts* tabs at the top.", "Each contact belongs to one prospect."],
  },
  {
    topic: "Your list",
    title: "The primary contact",
    text: "The main person you talk to at a company. AI and templates use this person.",
    steps: ["Open the prospect.", "Click a contact.", "Click *Make primary*. A star shows who it is."],
  },
  {
    topic: "Your list",
    title: "Add a company by hand",
    steps: ["Click *Add prospect*.", "Type in the new row, like a spreadsheet.", "Press `Space` to open it and fill in more."],
  },
  {
    topic: "Your list",
    title: "Open a prospect",
    bullets: ["Click the open button on a row, or press `Space`.", "In Reading view, click a card.", "Press `Alt+↑` or `Alt+↓` to go to the one before or after.", "Press `Esc` to close."],
  },
  {
    topic: "Your list",
    title: "Table or Reading?",
    bullets: ["*Table* looks like a spreadsheet. Click a header to sort.", "*Reading* shows each company as a card. Easier to read.", "In Reading, use *Group by* to sort cards into piles."],
  },
  {
    topic: "Your list",
    title: "Find rows fast",
    bullets: ["Type in the search box to find a name.", "Click *Filter* to show only some statuses.", "*Needs follow-up*: you reached out a week ago and heard nothing.", "*Not ready to send*: no contact or no intro yet."],
  },
  {
    topic: "Your list",
    title: "Change many rows at once",
    steps: ["Tick the boxes on the left of the rows.", "A bar shows up at the top.", "Pick *Screen out*, *Set status*, *Enrich* or *Delete*."],
  },
  {
    topic: "Your list",
    title: "Not a good fit? Screen it out",
    bullets: ["*Screen out* greys a company out but keeps it in the list.", "You can write why. That's optional.", "Changed your mind? Open it and click *Restore*."],
  },
  {
    topic: "Your list",
    title: "Oops! Undo",
    bullets: ["Press `Ctrl+Z` (`Cmd+Z` on a Mac), or click *Undo*.", "Pop-ups after a delete have an *Undo* button too."],
  },
  {
    topic: "Your list",
    title: "Change your columns",
    steps: ["Click *Tools*, then *Columns*.", "Hide, rename or add columns.", "Click *Save columns*."],
    tip: "Columns with a lock are used by Mudd. You can hide them, not change them.",
  },

  // ---------- Pipeline ----------
  {
    topic: "Pipeline",
    title: "How the pipeline works",
    text: "Each company has a status. It moves along as the deal gets closer:",
    steps: ["Not contacted", "Contacted", "Replied", "Meeting booked", "Clinic held", "Trial", "Signed"],
    tip: "Dead means it's not going to happen.",
  },
  {
    topic: "Pipeline",
    title: "Move a company along",
    bullets: ["Open the prospect and click a step under *Pipeline*.", "Or edit the Status cell in the table.", "For many at once, tick them and use *Set status*."],
  },
  {
    topic: "Pipeline",
    title: "Book a meeting",
    steps: ["Open the prospect.", "Under Meeting, click *Book meeting*.", "Paste the Zoom or Meet link and pick a time.", "Click *Save meeting*."],
    tip: "The status moves to Meeting booked, and it shows on the Meetings page with a *Join* button.",
  },
  {
    topic: "Pipeline",
    title: "Did the meeting happen?",
    text: "After the time passes, the prospect asks you. Click *Mark Clinic held*, or *Reschedule* to pick a new time.",
  },
  {
    topic: "Pipeline",
    title: "Know who to chase",
    steps: ["When you email someone, set *Last contacted* on their contact.", "When they write back, set *Last reply*.", "Use *Filter*, then *Needs follow-up*, to see who has gone quiet."],
  },
  {
    topic: "Pipeline",
    title: "Gone cold?",
    bullets: ["Click *Dropped off / dead* to mark it Dead.", "It comes back to life? Click *Revive*."],
  },

  // ---------- AI research ----------
  {
    topic: "AI research",
    title: "Let AI fill in the blanks",
    steps: ["Tick some rows and click *Enrich*.", "Pick a recipe (what to look up).", "Click *Test* to try it on a few rows first.", "Happy? Click *Run*."],
    tip: "Each row takes about half a minute. It uses your AI plan.",
  },
  {
    topic: "AI research",
    title: "Ready-made recipes",
    bullets: ["*Company snapshot*: what they do, size, website.", "*Recent news & trigger*: news and a reason to reach out now.", "*Decision-maker*: the person who can say yes.", "*Published email*: each contact's real email.", "*Personalization hook*: something to open your message with."],
  },
  {
    topic: "AI research",
    title: "Don't know anyone there?",
    text: "Let AI find the right person.",
    steps: ["Open the prospect, click *…*, then *Enrich with AI*.", "Pick *Decision-maker* and run it.", "Accept the name it finds. Now you have a contact.", "Then run *Published email* to get their email."],
  },
  {
    topic: "AI research",
    title: "AI asks before it changes things",
    bullets: ["What AI finds waits for you as a suggestion.", "A small dot on a cell means one is waiting.", "Go to *Tools*, then *Review*, to accept or reject.", "Tick *Fill empty cells automatically* to skip review for empty cells."],
  },
  {
    topic: "AI research",
    title: "Make your own recipe",
    steps: ["In Enrich, click *Blank recipe*.", "Say what the AI should find.", "Pick the columns to fill, or make new ones.", "Click *Save recipe*."],
  },
  {
    topic: "AI research",
    title: "Pause or stop a run",
    bullets: ["A chip at the top shows a run going. Click it to see it.", "*Pause* waits. *Resume* keeps going.", "*Stop* ends it now."],
  },
  {
    topic: "AI research",
    title: "Why was a row skipped?",
    bullets: ["It was screened out.", "It was deleted.", "The recipe looks up people, and the company has no contacts. Run *Decision-maker* first."],
  },

  // ---------- Discover ----------
  {
    topic: "Discover",
    title: "Find new companies with AI",
    steps: ["Click *New campaign*, then *Discover prospects*.", "Say what you sell and who it's for.", "Click *Create & continue*.", "Go to *Find* and click *Find 5 companies*."],
  },
  {
    topic: "Discover",
    title: "The thesis",
    text: "Questions about who buys from you. Better answers find better companies.",
    bullets: ["Only the first two are a must.", "*Fill blanks with AI* drafts the rest. Check them!"],
  },
  {
    topic: "Discover",
    title: "Your Discovery inbox",
    bullets: ["Found companies wait here, best fit first.", "Untick people you don't want.", "*Accept* adds the company to your list.", "*Dismiss* says no. Tell it why, and it learns."],
  },

  // ---------- Messages ----------
  {
    topic: "Messages",
    title: "Make a message template",
    steps: ["Click *Tools*, then *Templates*.", "Click *New template*.", "Write your message. It saves as you type."],
    tip: "{{First name}} and {{Company}} fill in for each person. {{Hook|your work}} uses \"your work\" when Hook is empty.",
  },
  {
    topic: "Messages",
    title: "Write an intro",
    steps: ["Open the prospect, then click a contact.", "Under Intro message, pick a template.", "Click *Use template*.", "Click *Copy* and paste it in your email."],
  },
  {
    topic: "Messages",
    title: "Let AI write the intro",
    steps: ["Open a contact.", "Click *Write with AI*.", "Read the draft.", "Click *Use this draft*, or *Try again*."],
    tip: "You need at least one template first. AI writes from your templates.",
  },

  // ---------- Saving ----------
  {
    topic: "Saving",
    title: "Your work saves itself",
    bullets: ["Every edit saves in Mudd right away.", "*Save file* also writes your changes back to your spreadsheet.", "Only the cells you changed are touched."],
  },
  {
    topic: "Saving",
    title: "Export a CSV",
    steps: ["Click the arrow next to *Save file*.", "Pick *Export prospects as CSV* or *Export contacts as CSV*.", "Find it in your Downloads folder."],
  },
  {
    topic: "Saving",
    title: "Remove a campaign",
    bullets: ["Click *Tools*, then *Remove from App*.", "Your spreadsheet file is not deleted.", "Want it back? Import the file again."],
  },
  {
    topic: "Saving",
    title: "Handy keys",
    bullets: ["`Space`: open a row", "`Enter`: edit a cell", "Arrow keys: move around", "`Ctrl+C` / `Ctrl+V`: copy and paste", "`Esc`: close", "`Ctrl+Z`: undo"],
  },
];
