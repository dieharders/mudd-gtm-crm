/**
 * Escape among the layers: a Panel open over the prospect panel closes alone, and a Modal open
 * over the Panel closes alone. The prospect panel is stood in for by its window listener.
 */
import { afterAll, expect, test } from "bun:test";
import { failOnConsoleError, installDom } from "../../../test/dom";

const dom = installDom();
const { act } = await import("react");
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
