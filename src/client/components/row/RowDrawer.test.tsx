/**
 * The prospect panel, mounted in a DOM. Opening one prospect after another used to stack up a
 * "Meeting" section per prospect: two sibling sections shared one key, so React never removed
 * the previous one. Any React warning (a duplicate key included) fails these tests.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { genericSchema } from "../../../shared/schema";
import { CHECKED, stagesOf, type Row } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";
import type { CampaignState } from "../../hooks/useCampaign";
import type { EnrichmentState } from "../../hooks/useEnrichment";

// The panel's AI section reads the provider status from the app's AI context.
void mock.module("../../lib/aiStatus", () => ({
  useAi: () => ({ settings: null, providers: [], loading: false, refresh: () => Promise.resolve(), update: () => Promise.resolve({}), open: false, setOpen: () => {} }),
  useActiveProvider: () => ({ status: null, ready: false }),
  AiProvider: ({ children }: { children: unknown }) => children,
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RowDrawer } = await import("./RowDrawer");
afterAll(() => dom.uninstall());

const schema = genericSchema();
const key = (header: string) => schema.columns.find((c) => c.header === header)!.key;
const prospect = (i: number, company: string, extra: Row["cells"] = {}): Row => ({
  id: `r${i}`, position: i, cells: { [key("Company")]: company, [key("Status")]: "Contacted", ...extra },
});

const state = {
  edit: () => true, undo: () => null, screenOut: () => true, restore: () => true, duplicateRow: () => null, deleteRows: () => {},
} as unknown as CampaignState;
const enrich = {
  pendingByRow: new Map(), activeRuns: [], runs: [], suggestions: [],
  start: () => Promise.resolve(null), accept: () => Promise.resolve(), reject: () => Promise.resolve(), action: () => Promise.resolve(),
} as unknown as EnrichmentState;

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const show = (row: Row) =>
    act(() => root.render(
      <RowDrawer row={row} schema={schema} stages={stagesOf(schema)} templates={[]} state={state} onClose={() => {}} onOpenTemplates={() => {}} enrich={enrich} />,
    ));
  const sections = (title: string) => [...el.querySelectorAll("h3")].filter((h) => h.textContent === title).length;
  const unmount = async () => {
    await act(() => root.unmount());
    el.remove();
  };
  return { el, show, sections, unmount };
}

test("opening one prospect after another shows one Meeting section", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    for (const [i, company] of ["Acme", "Beta", "Gamma", "Delta"].entries()) await ui.show(prospect(i, company));
    expect(ui.sections("Meeting")).toBe(1);
    expect(ui.el.textContent).toContain("Delta");
    expect(ui.el.textContent).not.toContain("Acme");
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});

test("a screened-out prospect shows why, with Restore, and nothing to act on", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    await ui.show(prospect(0, "Acme"));
    await ui.show(prospect(1, "Beta", { [key("Screened out")]: CHECKED, [key("Screened reason")]: "Too big" }));
    expect(ui.sections("Screened out")).toBe(1);
    expect(ui.sections("Meeting")).toBe(0);
    expect(ui.el.textContent).toContain("Restore");
    expect((ui.el.querySelector("textarea") as HTMLTextAreaElement | null)?.value).toBe("Too big");
    // Its details are read-only (still selectable) until it is restored.
    const company = [...ui.el.querySelectorAll("input")].find((i) => (i as HTMLInputElement).value === "Beta") as HTMLInputElement;
    expect(company.readOnly).toBe(true);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});
