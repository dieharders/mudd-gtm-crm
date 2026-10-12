/**
 * Retakes the README screenshots in docs/screenshots/ from made-up demo data (see demo.ts):
 *
 *   bun run screenshots                  -> every shot
 *   bun run screenshots home,discover    -> just those
 *
 * The app runs in this process against a throwaway data folder, so your own campaigns are never
 * read or touched, and headless Edge or Chrome takes each shot at 1440x900, 2x. The AI settings
 * shot shows a made-up Claude Code sign-in (DEMO_PROVIDERS), not this machine's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import index from "../../src/client/index.html";
import { withBrowser, type Send } from "../browser";
import type { CampaignBundle } from "../../src/shared/types";
import { DEMO_PROVIDERS, DISCOVERY_CAMPAIGN, discoveryDemo, enrichDemo, TEMPLATES, THESIS_ANSWERS, writeDemoWorkbook } from "./demo";

const OUT = path.join(import.meta.dir, "..", "..", "docs", "screenshots");
const WIDTH = 1440;
const HEIGHT = 900;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mudd-screenshots-"));
// Before the server modules load: the database opens under whatever this says on first use.
process.env.MUDD_DATA_DIR = path.join(tmp, "data");
const { createFetchHandler } = await import("../../src/server/index");
const { closeDb } = await import("../../src/server/db");
const { getAiSettings } = await import("../../src/server/ai/settings");
const store = await import("../../src/server/sourcing/store");
const enrichStore = await import("../../src/server/enrich/store");
const { recipeForPreset } = await import("../../src/server/enrich/recipes");

// The AI settings dialog and the sidebar show this made-up sign-in, never the CLIs or the account
// of the machine taking the shots: the status is answered here, without asking the CLIs at all.
const appHandler = createFetchHandler();
const handler = (req: Request) =>
  req.method === "GET" && new URL(req.url).pathname === "/api/ai/status"
    ? Response.json({ settings: getAiSettings(), providers: DEMO_PROVIDERS })
    : appHandler(req);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: { "/api/*": (req: Request) => handler(req), "/*": index as never },
});
const base = `http://127.0.0.1:${server.port}`;

async function api<T = { id: string }>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${url}: ${JSON.stringify(json)}`);
  return json;
}

// ---------- demo data ----------

await api("PATCH", "/api/ai/settings", { provider: "claude", consented: true });
const workbook = path.join(tmp, "Field Ops Tracker.xlsx");
await writeDemoWorkbook(workbook);
const { token } = await api<{ token: string }>("POST", "/api/import/inspect", { path: workbook });
const tracker = await api("POST", "/api/import", { token, name: "Midwest manufacturers", prospects: "Prospects" });
for (const t of TEMPLATES) await api("POST", `/api/campaigns/${tracker.id}/templates`, t);
const recipe = recipeForPreset(tracker.id, "news")!;
const bundle = await api<CampaignBundle>("GET", `/api/campaigns/${tracker.id}`);
const enrichment = enrichDemo(tracker.id, recipe, bundle.rows, bundle.campaign.schema.companyKey!, Date.now());
enrichStore.saveRun(enrichment.run);
enrichStore.insertSuggestions(enrichment.suggestions);
const discovery = await api("POST", "/api/campaigns", DISCOVERY_CAMPAIGN);
await api("PUT", `/api/campaigns/${discovery.id}/thesis`, { answers: THESIS_ANSWERS });
const demo = discoveryDemo(discovery.id, Date.now());
for (const run of demo.runs) store.saveDiscoveryRun(run);
store.saveCandidates(demo.candidates);

// ---------- the browser ----------

function page(send: Send) {
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? `evaluating ${expression} threw`);
    return r.result?.value as T;
  };
  const waitFor = async (expression: string, what: string) => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate<boolean>(`!!(${expression})`)) return;
      await Bun.sleep(125);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  /** Clicks the first visible element matching `selector` with a line of text that is `text` (any, when omitted). */
  const click = async (selector: string, text?: string) => {
    const match = text === undefined ? "true" : `e.innerText.split("\\n").some((l) => l.trim() === ${JSON.stringify(text)})`;
    const js = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent && ${match})`;
    await waitFor(js, `${selector} "${text}"`);
    await evaluate(`${js}.click()`);
    await Bun.sleep(600);
  };
  return {
    evaluate,
    click,
    async goto(url: string, ready: string) {
      await send("Page.navigate", { url: base + url });
      await waitFor(`document.readyState === "complete" && document.body.innerText.includes(${JSON.stringify(ready)})`, `"${ready}" on ${url}`);
      await Bun.sleep(800);
    },
    async shot(name: string) {
      // Lets the open animations of modals finish.
      await Bun.sleep(700);
      const { data } = (await send("Page.captureScreenshot", { format: "webp", quality: 82 })) as { data: string };
      const file = path.join(OUT, `${name}.webp`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  ${name}.webp  ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
    },
  };
}

type Page = ReturnType<typeof page>;
const SHOTS: Record<string, (p: Page) => Promise<void>> = {
  home: async (p) => {
    await p.goto("/", "Upcoming meetings");
  },
  table: async (p) => {
    await p.goto(`/c/${tracker.id}`, "Northwind Fabrication");
  },
  reading: async (p) => {
    await p.goto(`/c/${tracker.id}`, "Northwind Fabrication");
    await p.click("button", "Reading");
    // React tracks a select's value itself: set it through the native setter, then fire change.
    await p.evaluate(`(() => {
      const s = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.text === "Tier"));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, [...s.options].find((o) => o.text === "Tier").value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  },
  "ai-settings": async (p) => {
    await p.goto("/", "Upcoming meetings");
    await p.click('button[title^="Claude Code"]');
    // The status is stubbed (DEMO_PROVIDERS), but the dialog still loads it after it opens.
    await Bun.sleep(500);
  },
  "outbound-templates": async (p) => {
    await p.goto(`/c/${tracker.id}`, "Northwind Fabrication");
    await p.click('button[aria-label="Campaign menu"]');
    await p.click("button", "Templates");
  },
  enrich: async (p) => {
    await p.goto(`/c/${tracker.id}`, "Northwind Fabrication");
    // The page remembers the view, and the reading shot left it on Reading, which has no checkboxes.
    await p.click("button", "Table");
    // Tick three prospects, the way Enrich is reached: from the selection bar.
    const boxes = `[...document.querySelectorAll("input[type=checkbox]")].filter((e) => e.offsetParent)`;
    const bar = `[...document.querySelectorAll("button")].some((b) => b.offsetParent && b.innerText.trim() === "Enrich")`;
    // The grid can still be settling after the page loads: tick again until the selection bar shows.
    for (let i = 0; i < 5 && !(await p.evaluate<boolean>(bar)); i++) {
      await p.evaluate(`${boxes}.slice(1, 4).forEach((e) => { if (!e.checked) e.click(); })`);
      await Bun.sleep(500);
    }
    await p.click("button", "Enrich");
    await p.click("button", "Company snapshot");
  },
  "enrich-review": async (p) => {
    await p.goto(`/c/${tracker.id}`, "Northwind Fabrication");
    await p.click('button[aria-label="Campaign menu"]');
    await p.click("button", "Review");
  },
  discover: async (p) => {
    await p.goto(`/c/${discovery.id}`, "Open inbox");
    await p.click('button[title="Open the running Discovery"]');
  },
  "discover-inbox": async (p) => {
    await p.goto(`/c/${discovery.id}`, "Open inbox");
    await p.click('button[title="Open the running Discovery"]');
    await p.click("button", "Inbox");
  },
};

const only = process.argv[2]?.split(",").filter(Boolean);
const unknown = only?.filter((n) => !(n in SHOTS)) ?? [];
if (unknown.length) throw new Error(`unknown shot ${unknown.join(", ")}; pick from ${Object.keys(SHOTS).join(", ")}`);

let failed = false;
try {
  await withBrowser(async (send) => {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
    const p = page(send);
    fs.mkdirSync(OUT, { recursive: true });
    console.log(`-> ${OUT}`);
    for (const [name, take] of Object.entries(SHOTS)) {
      if (only && !only.includes(name)) continue;
      try {
        await take(p);
        await p.shot(name);
      } catch (err) {
        failed = true;
        console.error(`  ${name}: ${(err as Error).message}`);
      }
    }
  }, { name: "screenshots", args: ["--hide-scrollbars", `--window-size=${WIDTH},${HEIGHT}`] });
} finally {
  await server.stop(true);
  // Closed first: on Windows an open database (and its -wal and -shm) can't be deleted.
  closeDb();
  // As with the browser's profile, a leftover temp folder isn't worth failing a run that did its work.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`  (could not remove ${tmp}: ${(err as Error).message})`);
  }
}
process.exit(failed ? 1 : 0);
