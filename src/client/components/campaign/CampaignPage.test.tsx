/**
 * The campaign page's toolbar: the Discover button is there for a Discovery campaign (one with
 * a thesis) and not for any other. The page is rendered whole, so its hooks run as they do in
 * the app, with the API, the AI status and the event stream faked.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { discoverySchema, genericSchema } from "../../../shared/schema";
import type { CampaignBundle } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";

const bundles: Record<string, CampaignBundle> = {
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
    suggestions: () => Promise.resolve([]),
    discovery: () => Promise.resolve({ runs: [], candidates: [] }),
    env: () => Promise.resolve({ platform: "darwin", dialogs: false, dataDir: "" }),
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
  return { el, button, unmount: async () => { await act(() => root.unmount()); el.remove(); } };
}

test("the Discover button shows only on a Discovery campaign, whose empty list points at the inbox", async () => {
  const restoreConsole = failOnConsoleError();
  const plain = await mount("plain");
  try {
    expect((plain.el.querySelector('input[aria-label="Campaign name"]') as HTMLInputElement).value).toBe("Plain");
    expect(plain.button("Enrich")).toBeDefined();
    expect(plain.button("Discover")).toBeUndefined();
    expect(plain.el.textContent).toContain("Add your first prospect");
  } finally {
    await plain.unmount();
  }
  const disco = await mount("disco");
  try {
    expect((disco.el.querySelector('input[aria-label="Campaign name"]') as HTMLInputElement).value).toBe("Disco");
    expect(disco.button("Discover")).toBeDefined();
    expect(disco.el.textContent).toContain("once you accept them from the Discovery inbox");
    // Opens the panel on the thesis, the first thing to do before any run.
    await act(() => disco.button("Open Discover")!.click());
    expect(disco.el.textContent).toContain("Discover prospects");
    expect(disco.el.querySelector("#th-offer")).not.toBeNull();
  } finally {
    await disco.unmount();
    restoreConsole();
  }
});
