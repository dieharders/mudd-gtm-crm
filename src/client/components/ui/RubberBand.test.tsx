/** The rubber band slider mounts, and the keyboard moves its value by step and to either end. */
import { afterAll, expect, test } from "bun:test";
import { failOnConsoleError, installDom } from "../../../test/dom";

const dom = installDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RubberBand } = await import("./RubberBand");
afterAll(() => dom.uninstall());

test("keys step the value and clamp at the ends", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const seen: number[] = [];
  function Host() {
    const [v, setV] = useState(50);
    return <RubberBand value={v} min={0} max={100} step={5} onChange={(n) => { seen.push(n); setV(n); }} />;
  }
  const key = (k: string) => act(() => {
    el.querySelector("[role=slider]")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  });
  // The spring loop runs on animation frames; none fire here, so renders stay inside act().
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    await act(() => root.render(<Host />));
    const svg = el.querySelector("[role=slider]")!;
    expect(svg.getAttribute("role")).toBe("slider");
    expect(svg.getAttribute("aria-valuenow")).toBe("50");
    await key("ArrowRight");
    await key("ArrowLeft");
    await key("ArrowLeft");
    await key("End");
    await key("ArrowRight");
    await key("Home");
    expect(seen).toEqual([55, 50, 45, 100, 0]);
    expect(svg.getAttribute("aria-valuenow")).toBe("0");
    // The guide and its ticks, then the band's shadow, body and sheen: nothing threw while drawing.
    expect(el.querySelectorAll("path").length).toBe(5);
  } finally {
    globalThis.requestAnimationFrame = raf;
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
