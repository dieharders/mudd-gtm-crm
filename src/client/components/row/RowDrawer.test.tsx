/**
 * The prospect panel, mounted in a DOM. Opening one prospect after another used to stack up a
 * "Meeting" section per prospect: two sibling sections shared one key, so React never removed
 * the previous one. Any React warning (a duplicate key included) fails these tests. And its
 * contacts: listed primary first, each opening in the panel, Back or Esc returning.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { allColumns, genericSchema } from "../../../shared/schema";
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
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RowDrawer } = await import("./RowDrawer");
afterAll(() => dom.uninstall());

const schema = genericSchema();
const key = (header: string) => allColumns(schema).find((c) => c.header === header)!.key;
const prospect = (i: number, company: string, extra: Row["cells"] = {}): Row => ({
  id: `r${i}`, position: i, cells: { [key("Company")]: company, [key("Status")]: "Contacted", ...extra },
});
const person = (id: string, name: string, extra: Row["cells"] = {}): Row => ({ id, position: 9, parentId: "r0", cells: { [key("Name")]: name, ...extra } });

const madePrimary: string[] = [];
const state = {
  edit: () => true, editContacts: () => true, undo: () => null, screenOut: () => true, restore: () => true, duplicateRow: () => null, deleteRows: () => {},
  makePrimary: (id: string) => madePrimary.push(id),
} as unknown as CampaignState;
const enrich = {
  pendingByRow: new Map(), activeRuns: [], runs: [], suggestions: [],
  start: () => Promise.resolve(null), accept: () => Promise.resolve(), reject: () => Promise.resolve(), action: () => Promise.resolve(),
} as unknown as EnrichmentState;

/** The panel with its contact drill-down kept in state, as the campaign page keeps it. */
function Panel({ row, contacts, onClose }: { row: Row; contacts: Row[]; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <RowDrawer row={row} schema={schema} stages={stagesOf(schema)} templates={[]} state={state} contacts={contacts} openContactId={open} onOpenContact={setOpen}
      onClose={onClose} onOpenTemplates={() => {}} enrich={enrich} />
  );
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let closed = 0;
  const show = (row: Row, contacts: Row[] = []) => act(() => root.render(<Panel row={row} contacts={contacts} onClose={() => closed++} />));
  const sections = (title: string) => [...el.querySelectorAll("h3")].filter((h) => h.textContent?.startsWith(title)).length;
  const unmount = async () => {
    await act(() => root.unmount());
    el.remove();
  };
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  const click = (text: string) => act(() => button(text)!.click());
  const esc = () => act(() => {
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  return { el, show, sections, unmount, button, click, esc, closed: () => closed };
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

test("the prospect's contacts are listed primary first, and each opens in the panel; Back and Esc return", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    const contacts = [
      person("al", "Al Ng", { [key("Contact type")]: "End User", [key("Role")]: "Ops lead" }),
      person("ann", "Ann Lee", { [key("Primary")]: CHECKED, [key("Contact type")]: "Economic Buyer" }),
    ];
    await ui.show(prospect(0, "Acme"), contacts);
    // The header names the prospect over its primary contact.
    expect(ui.el.querySelector("h2")!.textContent).toBe("Acme");
    expect(ui.el.textContent).toContain("Ann Lee");
    expect(ui.sections("Contacts")).toBe(1);
    expect(ui.sections("Company")).toBe(1);
    const section = [...ui.el.querySelectorAll("h3")].find((h) => h.textContent?.startsWith("Contacts"))!.closest("section")!;
    const listed = [...section.querySelectorAll("li button")].map((b) => b.textContent);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain("Ann Lee");
    expect(listed[1]).toContain("Al Ng");
    expect(listed[1]).toContain("End User");

    await ui.click("Al Ng");
    expect(ui.sections("Contacts")).toBe(0);
    expect(ui.button("Acme")).toBeDefined();
    const name = [...ui.el.querySelectorAll("input")].find((i) => (i as HTMLInputElement).value === "Al Ng");
    expect(name).toBeDefined();
    // The type's meaning, under its field.
    expect(ui.el.textContent).toContain("uses the product every day");
    await ui.click("Make primary");
    expect(madePrimary).toEqual(["al"]);

    // Esc steps back to the prospect first, and closes only after.
    await ui.esc();
    expect(ui.sections("Contacts")).toBe(1);
    expect(ui.closed()).toBe(0);
    await ui.click("Ann Lee");
    expect(ui.button("Make primary")).toBeUndefined();
    expect(ui.el.textContent).toContain("Primary contact");
    await ui.click("Acme");
    expect(ui.sections("Contacts")).toBe(1);
    await ui.esc();
    expect(ui.closed()).toBe(1);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});

test("a prospect with no contacts offers to add one; a screened-out one does not", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    await ui.show(prospect(0, "Acme"));
    expect(ui.el.textContent).toContain("No contacts yet");
    expect(ui.button("Add contact")).toBeDefined();
    await ui.show(prospect(1, "Beta", { [key("Screened out")]: CHECKED }), [person("bo", "Bo Chen")]);
    expect(ui.button("Add contact")).toBeUndefined();
    await ui.click("Bo Chen");
    // Read-only, like the prospect's own fields.
    expect(ui.button("Delete contact")).toBeUndefined();
    const name = [...ui.el.querySelectorAll("input")].find((i) => (i as HTMLInputElement).value === "Bo Chen") as HTMLInputElement;
    expect(name.readOnly).toBe(true);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});
