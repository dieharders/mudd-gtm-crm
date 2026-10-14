/**
 * The campaign page: the overflow drawer's Discover card is there for a Discovery campaign (one
 * with a thesis) and not for any other; the filter chips and the selection. The page is rendered
 * whole, so its hooks run as they do in the app, with the API, the AI status and the event stream
 * faked. The grid's rows are virtualized and have no size here, so the header's checkbox selects.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { discoverySchema, genericSchema } from "../../../shared/schema";
import type { CampaignBundle, Row } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";

const pipeline = genericSchema();
const prospect = (id: string, status: string | null): Row => ({ id, position: 0, cells: { [pipeline.statusKey!]: status }, sourceSheet: null, sourceRow: null });
const bundles: Record<string, CampaignBundle> = {
  pipeline: {
    campaign: { id: "pipeline", name: "Pipeline", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: pipeline, sheets: [] },
    rows: [prospect("a", "Not contacted"), prospect("b", "Not contacted"), prospect("c", null)], contacts: [], templates: [], thesis: null,
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
  // A filter card in the filter drawer, opened first if it isn't: its label, then its count.
  const chip = async (label: string) => {
    if (!el.querySelector('[role="dialog"][aria-label^="Filter"]')) await click([...el.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("Filter")));
    return [...el.querySelectorAll('[role="dialog"] button[aria-pressed]')].find((b) => b.firstChild?.textContent === label) as HTMLButtonElement | undefined;
  };
  const selectAll = () => click(el.querySelector('[aria-label="Select all rows"]'));
  return { el, button, card, openMore, chip, click, selectAll, unmount: async () => { await act(() => root.unmount()); el.remove(); } };
}

test("the selection is let go once a change takes rows off the list, or a bulk status change is made", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    await page.selectAll();
    expect(page.el.textContent).toContain("3 selected");
    await page.click(page.button("Set status"));
    await page.click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Contacted"));
    expect(page.el.textContent).not.toContain("selected");

    // Selected under the Contacted chip, then undone back to Not contacted: off the list, and let go.
    await page.click(await page.chip("Contacted"));
    await page.selectAll();
    expect(page.el.textContent).toContain("3 selected");
    await page.click(page.el.querySelector('[title="Undo (Ctrl+Z)"]'));
    expect(page.el.textContent).not.toContain("selected");
    expect((await page.chip("Contacted"))?.getAttribute("aria-pressed")).toBe("true");
    expect(page.el.textContent).toContain("No rows match");
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
    await page.click(await page.chip("Not contacted"));
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

test("a prospect added under No status is left without one, and the chip stays on", async () => {
  const restoreConsole = failOnConsoleError();
  const page = await mount("pipeline");
  try {
    await page.click(await page.chip("No status"));
    await page.click(page.button("Add prospect"));
    expect((await page.chip("No status"))?.getAttribute("aria-pressed")).toBe("true");
    expect((await page.chip("No status"))?.textContent).toBe("No status2");
    expect((await page.chip("All"))?.getAttribute("aria-pressed")).toBe("false");
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
    await act(() => new Promise((r) => setTimeout(r, 250)));
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
