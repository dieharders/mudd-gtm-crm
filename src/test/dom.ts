/**
 * A browser DOM (happy-dom) for bun:test, and a console guard that turns React's dev warnings
 * (duplicate keys, missing act(), bad props...) into test failures.
 *
 * React DOM inspects the environment when it is first imported (whether a DOM exists, its dev-mode
 * error replay, event feature detection), so install the DOM *before* loading it:
 *
 *   import { afterAll } from "bun:test";
 *   import { installDom } from "../../test/dom";
 *
 *   const dom = installDom();
 *   const { createRoot } = await import("react-dom/client");
 *   afterAll(() => dom.uninstall());
 *
 * Bun runs every test file in one process with shared globals, so uninstall when the file is done,
 * and unmount your React roots before that (in afterEach).
 */
import { format } from "node:util";
import { GlobalWindow } from "happy-dom";

/**
 * Globals Bun already provides that must come from the DOM: events have to be the DOM's own
 * classes to dispatch through it (and for `instanceof` checks), and navigator should be a
 * browser's. Every other global Bun has (fetch, Request/Response, URL, Blob, timers, streams,
 * TextEncoder, crypto, console...) stays Bun's; everything only the DOM has is added.
 */
const FROM_DOM = new Set(["navigator", "Event", "EventTarget", "CustomEvent", "ErrorEvent", "MessageEvent", "CloseEvent"]);

export interface Dom {
  readonly window: GlobalWindow;
  /** Remove the globals again, cancel the window's pending timers and empty the document. */
  uninstall(): Promise<void>;
}

// One window for the whole run: react-dom is cached after its first import and keeps nodes from the
// first document, so a later file that installs the DOM again must get the same window back.
let shared: GlobalWindow | undefined;
let active: Dom | undefined;

/** Register a happy-dom window's globals (window, document, navigator, HTMLElement, events...). */
export function installDom(): Dom {
  if (active) return active;
  const win = (shared ??= new GlobalWindow({ url: "http://localhost/", console: globalThis.console }));
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const define = (key: string, descriptor: PropertyDescriptor) => {
    if (!previous.has(key)) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  };

  // Window methods and accessors are own properties bound to the window, so they work unqualified
  // (getComputedStyle(el), requestAnimationFrame(cb), location.href).
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in globalThis && !FROM_DOM.has(key)) continue;
    define(key, Object.getOwnPropertyDescriptor(win, key)!);
  }
  // Tells React this is a test environment where updates are wrapped in act().
  define("IS_REACT_ACT_ENVIRONMENT", { value: true, writable: true });

  const dom: Dom = {
    window: win,
    async uninstall() {
      if (active !== dom) return;
      active = undefined;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await win.happyDOM.abort();
      win.document.head.replaceChildren();
      win.document.body.replaceChildren();
    },
  };
  return (active = dom);
}

/** Thrown by the console.error that {@link failOnConsoleError} installs. */
export class ConsoleErrorFailure extends Error {
  override name = "ConsoleErrorFailure";
}

/**
 * Make console.error fail the test. React reports problems such as "Encountered two children with
 * the same key" only through console.error, which would otherwise just print and pass.
 *
 * A logged message (every React warning) throws on the spot, so the render or update that caused it
 * fails with a useful stack. An Error object someone is merely reporting (happy-dom's report of an
 * error thrown in an event listener, a catch block that logs) is recorded instead: throwing from inside
 * their error handling would corrupt it. React's own follow-up reports of an error this guard threw
 * ("The above error occurred in ...") are ignored.
 *
 * Returns `restore`, which puts console.error back and throws if anything was logged meanwhile, so an
 * error swallowed by an error boundary or a catch block still fails the test. Calling it again is a
 * no-op, so it is safe to call from afterEach as a backstop.
 */
export function failOnConsoleError(): () => void {
  const original = console.error;
  const thrown = new WeakSet<object>();
  const logged: string[] = [];

  console.error = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === "object" && arg !== null && thrown.has(arg))) return;
    const message = format(...args);
    if (message.startsWith("The above error occurred")) return;
    logged.push(message);
    if (typeof args[0] !== "string") return;
    const error = new ConsoleErrorFailure(message);
    thrown.add(error);
    throw error;
  };

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    console.error = original;
    if (logged.length === 0) return;
    const unique = [...new Set(logged)];
    throw new ConsoleErrorFailure(`console.error was called ${logged.length} time(s):\n\n${unique.join("\n\n")}`);
  };
}
