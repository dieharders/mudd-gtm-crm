/**
 * The campaign page: the overflow drawer's Discover card is there for a Discovery campaign (one
 * with a thesis) and not for any other; the filter drawer and the selection. The page is rendered
 * whole, so its hooks run as they do in the app, with the API, the AI status and the event stream
 * faked. The grid's rows are virtualized and have no size here, so the header's checkbox selects.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { discoverySchema, genericSchema } from "../../../shared/schema";
import { CHECKED, type CampaignBundle, type Row } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";

const pipeline = genericSchema();
const prospect = (id: string, status: string | null): Row => ({ id, position: 0, cells: { [pipeline.statusKey!]: status }, sourceSheet: null, sourceRow: null });
const contact = (id: string, parentId: string, type: string): Row => ({ id, position: 0, parentId, cells: { [pipeline.contacts!.typeKey!]: type }, sourceSheet: null, sourceRow: null });
const bundles: Record<string, CampaignBundle> = {
  pipeline: {
    campaign: { id: "pipeline", name: "Pipeline", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: pipeline, sheets: [] },
    rows: [prospect("a", "Not contacted"), prospect("b", "Not contacted"), prospect("c", null)], contacts: [], templates: [], thesis: null,
  },
  people: {
    campaign: { id: "people", name: "People", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: pipeline, sheets: [] },
    rows: [prospect("p", "Not contacted"), prospect("q", "Contacted")],
    contacts: [contact("x", "p", "Economic Buyer"), contact("y", "p", "Champion"), contact("z", "q", "Champion")], templates: [], thesis: null,
  },
  // Statuses the sheet holds that read as the names of fixed filters, and one prospect screened out.
  lookalike: {
    campaign: { id: "lookalike", name: "Lookalike", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: pipeline, sheets: [] },
    rows: [prospect("a", "Screened out"), { ...prospect("b", null), cells: { [pipeline.screenedKey!]: CHECKED } }, prospect("c", "No status")],
    contacts: [], templates: [], thesis: null,
  },
  plain: {
    campaign: { id: "plain", name: "Plain", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: genericSchema(), sheets: [] },
    rows: [], contacts: [], templates: [], thesis: null,
  },
  disco: {
    campaign: { id: "disco", name: "Disco", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: discoverySchema(), sheets: [] },
    rows: [], contacts: [], templates: [],
    thesis: { campaignId: "disco", answers: { offer: "SOC", avatar: "Manufacturers" }, drafted: [], updatedAt: 0 },
  },
};
void mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    campaign: (id: string) => Promise.resolve(bundles[id]),
    recipes: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
    finishedRows: () => Promise.resolve({}),
    suggestions: () => Promise.resolve([]),
    discovery: () => Promise.resolve({ runs: [], candidates: [] }),
    env: () => Promise.resolve({ platform: "darwin", dialogs: false, dataDir: "" }),
    editRows: () => Promise.resolve(),
    insertRows: () => Promise.resolve(),
  },
}));
void mock.module("../../lib/campaignEvents", () => ({ useCampaignEvents: () => {} }));
void mock.module("../../lib/campaignList", () => ({
  useCampaignList: () => ({ campaigns: [], meetings: [], refresh: () => {} }),
}));
void mock.module("../../lib/aiStatus", () => ({
  useAi: () => ({ settings: null, providers: [], loading: false, refresh: () => Promise.resolve([]), update: () => Promise.resolve({}), open: false, setOpen: () => {} }),
  useActiveProvider: () => ({ status: null, ready: false }),
  AiProvider: ({ children }: { children: unknown }) => children,
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { CampaignPage } = await import("./CampaignPage");
afterAll(() => dom.uninstall());

async function mount(id: string) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/c/${id}`]}>
        <Routes><Route path="/c/:id" element={<CampaignPage />} /></Routes>
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 10));
  });
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  // The overflow drawer's cards: a label, then a hint under it.
  const card = (label: string) => [...el.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.startsWith(label));
  const openMore = () => act(() => (el.querySelector('[aria-label="Campaign menu"]') as HTMLButtonElement).click());
  const click = (b: Element | null | undefined) => act(() => (b as HTMLElement).click());
  const selectAll = () => click(el.querySelector('[aria-label="Select all rows"]'));
  // How many rows the grid lists, as its header counts them.
  const listed = () => Number(el.querySelector('[aria-label="Select all rows"]')?.nextElementSibling?.textContent);
  const tab = (name: string) => click([...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim().startsWith(name)));

  const filterButton = () => {
    const b = el.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-label^="Filter"]');
    if (!b) throw new Error("No Filter button in the toolbar (a selection's actions are there instead?)");
    return b;
  };
  // A filter drawer's cards as it shows them: each one's label, whether it is on, and its count.
  const cardsIn = (drawer: Element) => [...drawer.querySelectorAll("button[aria-pressed]")].map((b) => ({
    label: b.firstChild?.textContent, on: b.getAttribute("aria-pressed") === "true", count: Number(b.children[1]?.textContent),
  }));
  const cardIn = (drawer: Element, label: string) => {
    const found = [...drawer.querySelectorAll("button[aria-pressed]")].find((b) => b.firstChild?.textContent === label);
    if (!found) throw new Error(`No "${label}" card in the filter drawer`);
    return found;
  };
  // The filter drawer opened from its button, used, and closed again, as in the app, where it
  // covers the page: nothing behind it is clicked while it is open.
  const inFilters = async <T,>(then: (drawer: Element) => T | Promise<T>): Promise<T> => {
    await click(filterButton());
    const drawer = el.querySelector('[role="dialog"][aria-label^="Filter"]');
    if (!drawer) throw new Error("The filter drawer didn't open");
    const out = await then(drawer);
    await click(drawer.querySelector('[aria-label="Close"]'));
    return out;
  };
  const pickFilter = (label: string) => inFilters((drawer) => click(cardIn(drawer, label)));
  const filterCards = () => inFilters(cardsIn);
  return {
    el, button, card, openMore, click, selectAll, listed, tab, filterButton, cardsIn, cardIn, inFilters, pickFilter, filterCards,
    unmount: async () => { await act(() => root.unmount()); el.remove(); },
  };
}

/** Long enough for a drawer to slide out and go. */
const leave = () => act(() => new Promise((r) => setTimeout(r, 250)));

test("the selection is let go once a change takes rows off the list, or a bulk status change is made", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    await page.selectAll();
    expect(page.el.textContent).toContain("3 selected");
    await page.click(page.button("Set status"));
    await page.click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Contacted"));
    expect(page.el.textContent).not.toContain("selected");

    // Selected under the Contacted filter, then undone back to Not contacted: off the list, and let go.
    await page.pickFilter("Contacted");
    await page.selectAll();
    expect(page.el.textContent).toContain("3 selected");
    await page.click(page.el.querySelector('[title="Undo (Ctrl+Z)"]'));
    expect(page.el.textContent).not.toContain("selected");
    expect(page.el.textContent).toContain("No rows match");
    // Its card is out of sight in the closed drawer: the empty list names it, and turns it off.
    expect(page.el.textContent).toContain("Filtered by Contacted");
    expect(await page.filterCards()).toContainEqual({ label: "Contacted", on: true, count: 0 });
    await page.click(page.button("Clear filters"));
    expect(page.el.textContent).not.toContain("No rows match");
    expect(page.listed()).toBe(3);
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("only the selected rows that leave the list are let go; a switch of view lets go of all", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    const undo = () => page.click(page.el.querySelector('[title="Undo (Ctrl+Z)"]'));
    // A row joining the list keeps the selection.
    await page.selectAll();
    await page.click(page.button("Add prospect"));
    expect(page.el.textContent).toContain("3 selected");
    // Reading has no checkboxes to untick them with.
    await page.click(page.button("Reading"));
    expect(page.el.textContent).not.toContain("selected");
    await page.click(page.button("Table"));
    await undo();

    // Under Not contacted: a, b and a new one, all selected. Undoing the add takes it off the list, and only it.
    await page.pickFilter("Not contacted");
    await page.click(page.button("Add prospect"));
    await page.selectAll();
    expect(page.el.textContent).toContain("3 selected");
    await undo();
    expect(page.el.textContent).toContain("2 selected");
    await page.click(page.button("Reading"));
    await page.click(page.button("Table"));
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("a prospect added under No status is left without one, and the filter stays on", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    await page.pickFilter("No status");
    await page.click(page.button("Add prospect"));
    const cards = await page.filterCards();
    expect(cards).toContainEqual({ label: "No status", on: true, count: 2 });
    expect(cards).toContainEqual({ label: "All", on: false, count: 4 });
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("a card turned off in the open drawer stays put until it closes", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    // Under No status, its one prospect set to Contacted: No status is left on, over nothing.
    await page.pickFilter("No status");
    await page.selectAll();
    await page.click(page.button("Set status"));
    await page.click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Contacted"));
    expect(page.el.textContent).toContain("No rows match");

    const [before, after] = await page.inFilters(async (drawer) => {
      const shown = page.cardsIn(drawer);
      await page.click(page.cardIn(drawer, "No status"));
      return [shown, page.cardsIn(drawer)];
    });
    // The same cards in the same places (and so leaning the same way), No status now off.
    expect(after.map((c) => c.label)).toEqual(before.map((c) => c.label));
    expect(after).toContainEqual({ label: "No status", on: false, count: 0 });
    // With nothing to show, it is gone once the drawer is opened again.
    await leave();
    expect((await page.filterCards()).map((c) => c.label)).not.toContain("No status");
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("a status in the sheet named like a fixed filter gets a card of its own", async () => {
  // Keyed by what they filter, not by their labels, or React would warn of two "Screened out" keys.
  const restoreConsole = failOnConsoleError();
  const page = await mount("lookalike");
  try {
    expect(await page.filterCards()).toEqual([
      { label: "All", on: true, count: 3 },
      { label: "Prospects only", on: false, count: 2 },
      { label: "Screened out", on: false, count: 1 },
      { label: "No status", on: false, count: 1 },
      { label: "Screened out", on: false, count: 1 },
    ]);
    // The first is the sheet's status: it lists the prospect in play that holds it.
    await page.pickFilter("Screened out");
    expect(page.listed()).toBe(1);
    await page.selectAll();
    expect(page.button("Set status")).toBeDefined();
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("each tab has its own filters, and the Filter button counts the ones on there", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("people");
  try {
    // Nothing on: grey, and read out as just Filter.
    expect(page.filterButton().getAttribute("aria-label")).toBe("Filter");
    expect(page.filterButton().className).not.toContain("bg-note");
    await page.pickFilter("Contacted");
    expect(page.listed()).toBe(1);
    expect(page.filterButton().getAttribute("aria-label")).toBe("Filter, 1 on");
    expect(page.filterButton().title).toBe("On: Contacted");
    expect(page.filterButton().className).toContain("bg-note");

    // The Contacts tab's drawer has the contacts' filters, none of them on.
    await page.tab("Contacts");
    expect(page.filterButton().getAttribute("aria-label")).toBe("Filter");
    expect(page.listed()).toBe(3);
    expect(await page.filterCards()).toEqual([
      { label: "All", on: true, count: 3 },
      { label: "Economic Buyer", on: false, count: 1 },
    ]);
    await page.pickFilter("Economic Buyer");
    expect(page.listed()).toBe(1);
    expect(page.filterButton().getAttribute("aria-label")).toBe("Filter, 1 on");
    expect(page.filterButton().title).toBe("On: Economic Buyer");

    // From the keyboard: the drawer takes focus as it opens, and Escape gives it back to the button.
    await leave();
    page.filterButton().focus();
    await page.click(page.filterButton());
    expect(page.filterButton().getAttribute("aria-expanded")).toBe("true");
    expect(page.el.querySelector('[role="dialog"][aria-label="Filter contacts"]')?.contains(document.activeElement)).toBe(true);
    await act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(page.filterButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(page.filterButton());

    // Back on Prospects, its own filter is still the one on.
    await page.tab("Prospects");
    expect(page.filterButton().title).toBe("On: Contacted");
    expect(page.listed()).toBe(1);
  } finally {
    await page.unmount();
    restoreConsole();
  }
});

test("the Discover card shows only on a Discovery campaign, whose empty list points at the inbox", async () => {
  const restoreConsole = failOnConsoleError();
  const plain = await mount("plain");
  try {
    expect((plain.el.querySelector('input[aria-label="Campaign name"]') as HTMLInputElement).value).toBe("Plain");
    expect(plain.el.textContent).toContain("Add your first prospect");
    await plain.openMore();
    expect(plain.card("Templates")).toBeDefined();
    expect(plain.card("Discover")).toBeUndefined();
  } finally {
    await plain.unmount();
  }
  const disco = await mount("disco");
  try {
    expect((disco.el.querySelector('input[aria-label="Campaign name"]') as HTMLInputElement).value).toBe("Disco");
    expect(disco.el.textContent).toContain("once you accept them from the Discovery inbox");
    await disco.openMore();
    expect(disco.card("Discover")).toBeDefined();
    await act(() => (disco.el.querySelector('[role="dialog"] [aria-label="Close"]') as HTMLButtonElement).click());
    // It slides out before it goes.
    await leave();
    expect(disco.el.querySelector('[role="dialog"]')).toBeNull();
    // Opens the panel on the thesis, the first thing to do before any run.
    await act(() => disco.button("Open Discover")!.click());
    expect(disco.el.textContent).toContain("Discover prospects");
    expect(disco.el.querySelector("#th-offer")).not.toBeNull();
  } finally {
    await disco.unmount();
    restoreConsole();
  }
});
