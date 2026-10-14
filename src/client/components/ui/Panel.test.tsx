/**
 * Escape among the layers: a Panel open over the prospect panel closes alone, and a Modal open
 * over the Panel closes alone. The prospect panel is stood in for by its window listener. And a
 * Panel opened again as it goes starts afresh.
 */
import { afterAll, expect, test } from "bun:test";
import { failOnConsoleError, installDom } from "../../../test/dom";

const dom = installDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Panel, PanelGate } = await import("./Panel");
const { Modal } = await import("./Modal");
afterAll(() => dom.uninstall());

test("Escape closes only the top layer", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const closed: string[] = [];
  // As RowDrawer listens: on the window, as the key comes back up.
  const drawer = (e: KeyboardEvent) => e.key === "Escape" && closed.push("drawer");
  window.addEventListener("keydown", drawer);
  const show = (modal: boolean) => act(() => root.render(
    <PanelGate open>
      <Panel title="Templates" onClose={() => closed.push("panel")}>
        <Modal open={modal} title="Delete?" onClose={() => closed.push("modal")}>Sure?</Modal>
      </Panel>
    </PanelGate>,
  ));
  const esc = () => act(() => {
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  try {
    await show(true);
    await esc();
    expect(closed).toEqual(["modal"]);
    await show(false);
    await esc();
    expect(closed).toEqual(["modal", "panel"]);
  } finally {
    window.removeEventListener("keydown", drawer);
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});

test("a panel opened again while it is still going starts afresh", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  // Stands in for a choice made in the panel, such as Enrich's run scope.
  function Choice() {
    const [picked, setPicked] = useState("first");
    return <button id="choice" onClick={() => setPicked("changed")}>{picked}</button>;
  }
  const show = (open: boolean) => act(() => root.render(
    <PanelGate open={open}>
      <Panel title="Enrich" onClose={() => {}}><Choice /></Panel>
    </PanelGate>,
  ));
  const choice = () => el.querySelector<HTMLButtonElement>("#choice")!;
  try {
    await show(true);
    await act(() => choice().click());
    expect(choice().textContent).toBe("changed");
    // Closed, and opened again before it has finished going.
    await show(false);
    expect(choice()).not.toBeNull();
    await show(true);
    expect(choice().textContent).toBe("first");
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});

test("focus goes into each layer as it opens, and back to what opened it as it closes", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const show = (panel: boolean, modal: boolean) => act(() => root.render(
    <>
      <button id="open-panel">Templates</button>
      <PanelGate open={panel}>
        <Panel title="Templates" onClose={() => {}}>
          <button id="open-modal">Delete</button>
          <Modal open={modal} title="Delete?" onClose={() => {}}>Sure?</Modal>
        </Panel>
      </PanelGate>
    </>,
  ));
  const byId = (id: string) => el.querySelector<HTMLElement>(`#${id}`)!;
  const dialog = (title: string) => [...el.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title);
  try {
    await show(false, false);
    byId("open-panel").focus();
    await show(true, false);
    expect(document.activeElement).toBe(dialog("Templates")!);
    byId("open-modal").focus();
    await show(true, true);
    expect(document.activeElement).toBe(dialog("Delete?")!);
    // The Modal goes back to the button in the Panel under it, which is still open.
    await show(true, false);
    expect(document.activeElement).toBe(byId("open-modal"));
    await show(false, false);
    expect(document.activeElement).toBe(byId("open-panel"));
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
