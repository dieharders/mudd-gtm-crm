/**
 * Proves the harness catches what ESLint cannot: react/jsx-key does not flag two static siblings
 * that share a key, but React warns at runtime, and failOnConsoleError turns that into a failure.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, createElement as h, type ReactNode } from "react";
import { failOnConsoleError, installDom } from "./dom";

const dom = installDom();
// After installDom(): react-dom checks for a DOM when it is first imported.
const { createRoot } = await import("react-dom/client");

const roots: ReturnType<typeof createRoot>[] = [];
let restoreConsole: (() => void) | undefined;

function mount(node: ReactNode): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  restoreConsole?.();
});
afterAll(() => dom.uninstall());

// The same shape as two sibling cells both keyed `row.id`.
const SameKeys = () => h("ul", null, h("li", { key: "row-1" }, "name"), h("li", { key: "row-1" }, "email"));
const DistinctKeys = () => h("ul", null, h("li", { key: "row-1:name" }, "name"), h("li", { key: "row-1:email" }, "email"));

describe("failOnConsoleError", () => {
  test("fails a render that reuses a key among siblings", () => {
    restoreConsole = failOnConsoleError();
    expect(() => mount(h(SameKeys))).toThrow(/Encountered two children with the same key, `row-1`/);
    // restore() reports it as well, so a warning swallowed by an error boundary still fails the test.
    expect(restoreConsole).toThrow(/Encountered two children with the same key, `row-1`/);
  });

  test("lets a render with unique keys through", () => {
    restoreConsole = failOnConsoleError();
    const container = mount(h(DistinctKeys));
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(restoreConsole).not.toThrow();
  });

  test("restore() puts the original console.error back", () => {
    const original = console.error;
    restoreConsole = failOnConsoleError();
    expect(console.error).not.toBe(original);
    restoreConsole();
    expect(console.error).toBe(original);
  });
});

describe("installDom", () => {
  test("provides the browser globals React DOM and components use", () => {
    expect(window.document).toBe(document);
    expect(document.createElement("button")).toBeInstanceOf(HTMLElement);
    expect(new KeyboardEvent("keydown", { key: "Enter" }).key).toBe("Enter");
    expect(typeof getComputedStyle).toBe("function");
    expect(typeof requestAnimationFrame).toBe("function");
  });

  test("dispatches DOM events through React handlers", () => {
    let clicks = 0;
    const container = mount(h("button", { onClick: () => clicks++ }, "go"));
    act(() => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicks).toBe(1);
  });
});
