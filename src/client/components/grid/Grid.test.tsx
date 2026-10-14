/**
 * The grid's keys, mounted in a DOM. Its open button says "(Space)": Space opens the row picked
 * by clicking one of its cells, its checkbox or that button, and keys pressed on the checkbox are
 * the checkbox's own.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import type { CampaignSchema, CellEdit, Row } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Grid } = await import("./Grid");

// happy-dom lays nothing out: the grid (its virtualizer reads offsetWidth/offsetHeight) needs a
// size to render any rows.
const sizes = { offsetWidth: 1000, offsetHeight: 600 };
const real = Object.fromEntries(Object.keys(sizes).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]));
for (const [k, v] of Object.entries(sizes)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
afterAll(() => {
  for (const [k, d] of Object.entries(real)) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  return dom.uninstall();
});

const schema: CampaignSchema = {
  columns: [
    { key: "company", header: "Company", type: "text" },
    { key: "notes", header: "Notes", type: "text" },
    { key: "status", header: "Status", type: "select", options: ["Contacted", "Replied"] },
  ],
};
const rows: Row[] = [
  { id: "r1", position: 0, cells: { company: "Acme", notes: "Warm" } },
  { id: "r2", position: 1, cells: { company: "Beta" } },
];
let opened: string[] = [];
let selected = new Set<string>();
let edits: CellEdit[] = [];
beforeEach(() => {
  opened = [];
  selected = new Set();
  edits = [];
});

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => act(() => root.render(
    <Grid columns={schema.columns} rows={rows} schema={schema} stages={[]} pinned={1} selected={selected}
      onSelect={(next) => { selected = next; void render(); }} onEdit={(e) => edits.push(...e)} onOpenRow={(id) => opened.push(id)}
      onResize={() => {}} sort={null} onSort={() => {}} openRowId={null} />,
  ));
  await render();
  const scroller = el.firstElementChild as HTMLElement;
  const cell = (text: string) => [...el.querySelectorAll("div")].find((d) => d.textContent === text && d.className.includes("group/cell"))!;
  const boxes = () => [...el.querySelectorAll('input[aria-label="Select row"]')] as HTMLInputElement[];
  const key = (target: HTMLElement, k: string) => act(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event);
  });
  const mouse = (target: HTMLElement, type: string) => act(() => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }) as unknown as Event);
  });
  const paste = (text: string) => act(() => {
    const clipboardData = { getData: (type: string) => (type === "text/plain" ? text : "") };
    scroller.dispatchEvent(new window.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData } as never) as unknown as Event);
  });
  const unmount = async () => {
    await act(() => root.unmount());
    el.remove();
  };
  return { scroller, cell, boxes, key, mouse, paste, unmount };
}

test("a paste fills a dropdown only with what it lists, in its own spelling", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    await ui.mouse(ui.cell("Acme"), "mousedown");
    await ui.paste("Acme Co\tCold\tcontacted\nBeta Co\tWarm\tOn hold");
    expect(edits).toEqual([
      { rowId: "r1", key: "company", value: "Acme Co" },
      { rowId: "r1", key: "notes", value: "Cold" },
      { rowId: "r1", key: "status", value: "Contacted" },
      { rowId: "r2", key: "company", value: "Beta Co" },
      { rowId: "r2", key: "notes", value: "Warm" },
    ]);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});

test("Space opens the row of the cell clicked", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    await ui.mouse(ui.cell("Beta"), "mousedown");
    expect(document.activeElement).toBe(ui.scroller);
    await ui.key(ui.scroller, " ");
    expect(opened).toEqual(["r2"]);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});

test("clicking a row's checkbox picks that row: Space then opens it", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    // A cell of the other row was picked before.
    await ui.mouse(ui.cell("Beta"), "mousedown");
    await ui.mouse(ui.boxes()[0]!, "click");
    expect(document.activeElement).toBe(ui.scroller);
    await ui.key(ui.scroller, " ");
    expect(opened).toEqual(["r1"]);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});

test("Space pressed on a checkbox is the checkbox's, not the grid's", async () => {
  const restoreConsole = failOnConsoleError();
  const ui = await mount();
  try {
    await ui.mouse(ui.cell("Acme"), "mousedown");
    const box = ui.boxes()[1]!;
    box.focus();
    await ui.key(box, " ");
    expect(opened).toEqual([]);
  } finally {
    await ui.unmount();
    restoreConsole();
  }
});
