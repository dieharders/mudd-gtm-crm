/**
 * The made-up data the README screenshots show: a tracker workbook to import, two intro templates,
 * a finished enrichment run with its findings waiting in Review, and a Discover campaign with a finished Find run (its candidates in the inbox) and one still
 * running. Every company and person is invented, and every website is a .example domain.
 */
import ExcelJS from "exceljs";
import type { EnrichRun, Recipe, Suggestion } from "../../src/shared/ai";
import type { Candidate, DiscoveryRun, SearchAngle } from "../../src/shared/sourcing";
import type { Row } from "../../src/shared/types";

const d = (m: number, day: number, h = 0, min = 0) => new Date(Date.UTC(2026, m - 1, day, h, min));
const site = (company: string) => company.toLowerCase().split(" ").slice(0, 2).join("").replace(/[^a-z]+/g, "") + ".example";

// ---------- tracker workbook ----------

const PROSPECT_HEADERS = ["ID", "Company", "Tier", "Industry", "Location", "Website", "# Employees", "Status", "Last touch", "Next step", "Meeting URL", "Meeting at", "Hook", "Notes", "Source"];
/** Company, tier, industry, location, staff, status, last touch, next step, meeting URL, meeting at, hook, notes, source. */
type Prospect = [string, string, string, string, number, string, Date | null, string | null, string | null, Date | null, string | null, string | null, string];
const PROSPECTS: Prospect[] = [
  ["Northwind Fabrication", "A", "Metal fabrication", "Dayton, OH", 420, "Meeting booked", d(10, 8), "Walk through the insurance checklist", "https://meet.example/northwind", d(10, 14, 15), "Hiring a security lead after a phishing scare", "Plant manager owns the IT budget", "Trade show"],
  ["Harbor Lights Logistics", "A", "3PL", "Tacoma, WA", 1100, "Replied", d(10, 9), "Send the one-pager", null, null, "Opened a second warehouse in July", "Asked for pricing by email", "Referral"],
  ["Copperline Foods", "A", "Food processing", "Fresno, CA", 260, "Contacted", d(10, 6), "Follow up Thursday", null, null, "New CFO started in August", null, "Association list"],
  ["Bluestem Dental Group", "B", "Dental group", "Omaha, NE", 85, "Meeting booked", d(10, 7), "Prep for the call", "https://meet.example/bluestem", d(10, 16, 18), "Adding two locations this year", "Office manager is the champion", "Trade show"],
  ["Granite Peak Credit Union", "B", "Credit union", "Boise, ID", 190, "Proposal", d(10, 2), "Revise pricing for 3 branches", null, null, "Exam findings due by year end", null, "Conference"],
  ["Saltmarsh Marine Supply", "C", "Distribution", "Mobile, AL", 60, "Contacted", d(9, 30), "Call after the spring push", null, null, "Seasonal hiring wave", null, "Trade show"],
  ["Ironleaf Plastics", "A", "Injection molding", "Grand Rapids, MI", 640, "Not contacted", null, null, null, null, "Insurer now requires 24/7 monitoring", null, "Insurance broker"],
  ["Cedar Ridge Millwork", "B", "Wood products", "Asheville, NC", 150, "Not contacted", null, null, null, null, "Moving to a cloud ERP", null, "Association list"],
  ["Prairie Wind Components", "A", "Wind turbine parts", "Sioux Falls, SD", 880, "Contacted", d(10, 3), "Ask for the IT director", null, null, "Third plant opening in 2027", "Gatekeeper screens calls", "News"],
  ["Lakeshore Precision", "B", "CNC machining", "Kenosha, WI", 210, "Replied", d(10, 9), "Book a demo", null, null, "Two-person IT team", "Wants to see a sample report", "Referral"],
  ["Redstone Brewing Co.", "C", "Beverage", "Fort Collins, CO", 95, "Not contacted", null, null, null, null, null, null, "Trade show"],
  ["Silverpine Medical Devices", "A", "Medical devices", "Minneapolis, MN", 1500, "Contacted", d(10, 1), "Send the FDA cyber guidance note", null, null, "New FDA premarket cyber rules", null, "News"],
  ["Oakhaven Textiles", "C", "Textiles", "Greenville, SC", 320, "Dead", d(9, 12), null, null, null, null, "Signed with an incumbent", "Association list"],
  ["Bayfront Cold Storage", "B", "Cold chain", "Savannah, GA", 140, "Not contacted", null, null, null, null, "Ransomware hit a peer in June", null, "News"],
  ["Summit Ridge Packaging", "A", "Packaging", "Allentown, PA", 510, "Not contacted", null, null, null, null, "Cyber-insurance renewal in Q1", null, "Insurance broker"],
  ["Riverbend Castings", "B", "Foundry", "Peoria, IL", 275, "Contacted", d(10, 5), "Second email", null, null, null, null, "Trade show"],
  ["Westgate Industrial Coatings", "C", "Chemicals", "Houston, TX", 180, "Not contacted", null, null, null, null, null, null, "Association list"],
  ["Thornbury Electronics", "A", "Electronics assembly", "Austin, TX", 730, "Replied", d(10, 8), "Loop in the CFO", null, null, "SOC 2 asked for by a big customer", "Technical buyer is keen", "Referral"],
];

const CONTACT_HEADERS = ["Prospect ID", "Company", "Name", "Contact type", "Primary", "Role", "Email", "Phone", "LinkedIn"];
/** Prospect number (1-based), name, contact type, primary, role. */
const PEOPLE: [number, string, string, boolean, string][] = [
  [1, "Maya Okafor", "Economic Buyer", true, "Plant Manager"], [1, "Tom Reyes", "Technical Buyer", false, "IT Lead"],
  [2, "Priya Natarajan", "Economic Buyer", true, "VP Operations"], [3, "Luis Carvalho", "Economic Buyer", true, "CFO"],
  [4, "Dana Whitfield", "Influencer", true, "Office Manager"], [4, "Elise Marchetti", "Economic Buyer", false, "Owner"],
  [5, "Hank Ostrowski", "Technical Buyer", true, "CIO"], [6, "Rosa Lindqvist", "End User", true, "Operations Coordinator"],
  [7, "Grace Abernathy", "Economic Buyer", true, "COO"], [8, "Owen Pratt", "Economic Buyer", true, "General Manager"],
  [9, "Jonah Feld", "Technical Buyer", true, "IT Director"], [9, "Carla Mendes", "Gatekeeper", false, "Executive Assistant"],
  [10, "Sam Whitaker", "Technical Buyer", true, "IT Manager"], [12, "Nadia Petrova", "Economic Buyer", true, "VP Quality"],
  [13, "Bill Haskins", "Economic Buyer", true, "President"], [14, "Imani Brooks", "Economic Buyer", true, "Director of Operations"],
  [15, "Ken Yamada", "Economic Buyer", true, "CFO"], [16, "Erin Doyle", "Technical Buyer", true, "Systems Administrator"],
  [18, "Marcus Lee", "Technical Buyer", true, "Director of IT"], [18, "Hannah Cho", "Economic Buyer", false, "CFO"],
];

export async function writeDemoWorkbook(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const header = (ws: ExcelJS.Worksheet, headers: string[]) =>
    ws.addRow(headers).eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1B18" } };
    });
  const ids = PROSPECTS.map((_, i) => `P-${String(i + 1).padStart(3, "0")}`);
  const ps = wb.addWorksheet("Prospects");
  header(ps, PROSPECT_HEADERS);
  PROSPECTS.forEach(([company, ...rest], i) => ps.addRow([ids[i], company, rest[0], rest[1], rest[2], site(company), ...rest.slice(3)]));
  ps.getColumn(9).numFmt = "d mmm yyyy";
  ps.getColumn(12).numFmt = "d mmm yyyy h:mm";
  const cs = wb.addWorksheet("Contacts");
  header(cs, CONTACT_HEADERS);
  for (const [n, name, type, primary, role] of PEOPLE) {
    const company = PROSPECTS[n - 1]![0];
    cs.addRow([ids[n - 1], company, name, type, primary ? "TRUE" : null, role, `${name.split(" ")[0]!.toLowerCase()}@${site(company)}`, null, null]);
  }
  await wb.xlsx.writeFile(file);
}

// ---------- templates and thesis ----------

export const TEMPLATES = [
  {
    name: "Insurance renewal opener",
    body: `Hi {{First name}},

I noticed this about {{Company}}: {{Hook|you're growing fast}}. That's usually when the insurance questions start, so I'll keep this short.

Most plants we talk to have a small IT team and an insurer that now wants 24/7 monitoring before it renews. We run that monitoring for you, priced per site, and the first plant is live in a week.

Would a 20-minute call next week be useful? I can bring the checklist insurers are asking for.

Alex`,
  },
  { name: "Post-incident check-in", body: "Hi {{First name}},\n\nSaw the news about {{Hook|a peer in your industry}}. ..." },
];

export const DISCOVERY_CAMPAIGN = {
  name: "Cold storage & logistics",
  layout: "discovery",
  thesis: {
    offer: "Managed 24/7 security monitoring for mid-size industrial companies, priced per site.",
    avatar: "US cold-storage and 3PL operators with 150–2,000 staff and 2+ warehouses; the IT director buys, the CFO pays.",
  },
};

/** The other fourteen answers, so the Thesis step reads "16 of 16 answered". */
export const THESIS_ANSWERS = {
  pains: "Ransomware scares, an insurance renewal that demands round-the-clock monitoring, a two-person IT team.",
  fit: "We're the 24/7 SOC their insurer asks for, without the headcount.",
  jobs: "Pass the insurance audit, keep the docks running during an incident.",
  painRoles: "IT director or IT manager.",
  payerRoles: "CFO; budget sits in operations.",
  gainRoles: "VP Operations: downtime is their number.",
  friction: "An incumbent MSP, procurement.",
  exclude: "Companies under 100 staff; anyone with an in-house SOC.",
  triggers: "New warehouse, ransomware news in the sector, a new CFO or IT hire.",
  channels: "Cold-chain trade associations, warehouse openings in the news.",
  dealShape: "3-year contract, 2–6 sites.",
  clock: "Insurance renewal, usually Q1.",
  approach: "Lead with the insurer's checklist.",
  win: "A signed pilot at one site.",
};

// ---------- discovery runs ----------

const angle = (id: string, label: string, state: SearchAngle["state"], step: string | undefined, found: number): SearchAngle =>
  ({ id, label, query: label, state, step, found });

/**
 * Written straight to the store, not run: a finished Find whose three companies wait in the inbox,
 * and one "running" a minute in. Nothing drives the running one, so it holds still for the shot.
 */
export function discoveryDemo(campaignId: string, now: number): { runs: DiscoveryRun[]; candidates: Candidate[] } {
  const min = 60_000;
  const base: Pick<DiscoveryRun, "campaignId" | "kind" | "provider" | "model" | "concurrency" | "perCompany" | "enrich" | "drafted" | "disqualified" | "failed" | "error"> = {
    campaignId, kind: "find", provider: "claude", model: "opus", concurrency: 2, perCompany: 5,
    enrich: { presets: ["snapshot", "email", "decision-maker"], recipeIds: [], autoFill: true },
    drafted: [], disqualified: 0, failed: 0, error: null,
  };
  const found: [string, string, number, Candidate["fit"], string, string, string, string][] = [
    ["Polar Dock Cold Storage", "Joliet, IL", 640, "High", "Runs four freezer warehouses on one flat network, with a two-person IT team.", "Opened a fifth site in September; its insurer named 24/7 monitoring as a renewal condition.", "Gretchen Vogel", "IT Director"],
    ["Ridgeway Freight Partners", "Columbus, OH", 1200, "High", "3PL with 9 warehouses and a shared WMS; no security staff listed.", "Hired a new CFO in August who is reviewing vendor spend.", "Darnell Price", "CFO"],
    ["Bluewater Reefer Logistics", "Norfolk, VA", 310, "Medium", "Refrigerated trucking and two cross-dock sites.", "A peer was hit by ransomware in June, covered in the trade press.", "Mei Tanaka", "VP Operations"],
  ];
  const candidateIds = found.map((_, i) => `demo-candidate-${i}`);
  const done: DiscoveryRun = {
    ...base, id: "demo-run-done", status: "done", stage: "done", target: 5, focus: null,
    angles: [angle("a1", "Cold-chain association members", "done", undefined, 2), angle("a2", "New warehouse openings", "done", undefined, 1), angle("a3", "Ransomware news in logistics", "done", undefined, 0)],
    candidateIds, jobs: Object.fromEntries(candidateIds.map((c) => [c, { state: "done" }])),
    found: 3, ready: 3, costUsd: 0.41, startedAt: now - 42 * min, finishedAt: now - 30 * min,
  };
  const running: DiscoveryRun = {
    ...base, id: "demo-run-live", status: "running", stage: "find", target: 10, focus: "Midwest operators opening new sites",
    angles: [
      angle("b1", "Midwest warehouse openings", "running", "Reading coldchainnews.example/new-facilities-2026", 0),
      angle("b2", "Food distribution association members", "running", "Searching \"cold storage\" member directory", 0),
      angle("b3", "Logistics firms hiring IT staff", "pending", undefined, 0),
      angle("b4", "Insurance renewal coverage in trade press", "pending", undefined, 0),
    ],
    candidateIds: [], jobs: {}, found: 0, ready: 0, costUsd: 0.06, startedAt: now - min, finishedAt: null,
  };
  const candidates = found.map(([company, location, employees, fit, whyFit, whyNow, person, title], i): Candidate => {
    const web = site(company);
    return {
      id: candidateIds[i]!, campaignId, runId: done.id, status: "ready", company, website: web, location, employees, fit, whyFit, whyNow,
      budget: "Operations budget", clock: "Insurance renewal in Q1",
      sources: [{ url: `https://${web}/about`, title: `${company}: About` }, { url: "https://coldchainnews.example/2026/09/expansions", title: "Cold Chain News" }],
      contacts: [{ id: `demo-contact-${i}`, name: person, title, type: "Economic Buyer", dealRole: "Signs off on security spend", gain: "Passes the insurance renewal", angle: "Lead with the insurer's checklist", linkedin: null, source: `https://${web}/team`, confidence: "high" }],
      firstContact: `demo-contact-${i}`, angle: done.angles[i]!.label, error: null, dismissReason: null, rowId: null,
      createdAt: now - (35 - i) * min, updatedAt: now - 30 * min,
    };
  });
  return { runs: [done, running], candidates };
}

// ---------- enrichment ----------

/** What a "Recent news & trigger" run found, by company: recent news, why now, source, confidence. */
const NEWS: [string, string, string, string, Suggestion["confidence"]][] = [
  ["Northwind Fabrication", "Sep 2026: opened a second plant in Springfield, OH, adding 120 jobs.", "Two plants on one network, and the security lead role is still open.", "daytonbusiness.example/northwind-second-plant", "high"],
  ["Harbor Lights Logistics", "Jul 2026: signed a 10-year lease on a 400,000 sq ft warehouse in Fife, WA.", "The new site goes live in Q1, the same quarter as their insurance renewal.", "pugetsoundlogistics.example/harbor-lights-fife", "high"],
  ["Copperline Foods", "Aug 2026: named Luis Carvalho CFO, previously at a regional dairy co-op.", "A new CFO reviewing vendor spend in his first 100 days.", "copperlinefoods.example/news/new-cfo", "medium"],
  ["Ironleaf Plastics", "Jun 2026: won a three-year supply contract with a Detroit automaker.", "Automotive customers now require a cyber questionnaire from suppliers.", "plasticsnews.example/ironleaf-auto-contract", "medium"],
];

/** A finished run of the news preset over four prospects, its findings all waiting in Review. */
export function enrichDemo(campaignId: string, recipe: Recipe, rows: Row[], companyKey: string, now: number): { run: EnrichRun; suggestions: Suggestion[] } {
  const [newsKey, whyKey] = recipe.outputs.map((o) => o.key);
  const found = NEWS.map((n) => ({ n, row: rows.find((r) => r.cells[companyKey] === n[0]) }))
    .filter((f): f is { n: (typeof NEWS)[number]; row: Row } => !!f.row);
  const runId = "demo-enrich-run";
  const run: EnrichRun = {
    id: runId, campaignId, kind: "enrich", recipeId: recipe.id, label: recipe.name, status: "done", test: false,
    provider: "claude", model: "sonnet", concurrency: 3, autoFill: false,
    rowIds: found.map((f) => f.row.id), rows: Object.fromEntries(found.map((f) => [f.row.id, { state: "done", found: 2 }])),
    total: found.length, completed: found.length, failed: 0, suggestions: found.length * 2, autoFilled: 0,
    startedAt: now - 9 * 60_000, finishedAt: now - 6 * 60_000, error: null, costUsd: 0.12,
  };
  const suggestions = found.flatMap(({ n: [, news, why, url, confidence], row }, i): Suggestion[] => {
    const sources = [{ url: `https://${url}`, title: news.split(": ")[0] }];
    const s = (key: string, value: string, j: number): Suggestion => ({
      id: `demo-suggestion-${i}-${j}`, campaignId, runId, rowId: row.id, key, value, previous: null, sources, confidence, note: null,
      status: "pending", createdAt: now - (8 - i) * 60_000,
    });
    return [s(newsKey!, news, 0), s(whyKey!, why, 1)];
  });
  return { run, suggestions };
}
