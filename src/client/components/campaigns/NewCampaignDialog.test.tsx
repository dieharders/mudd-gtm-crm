/** New campaign → Discover prospects: the two required answers, what is sent, and where it goes next. */
import { afterAll, expect, mock, test } from "bun:test";
import { failOnConsoleError, installDom } from "../../../test/dom";

const created: unknown[][] = [];
const navigated: string[] = [];
void mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    createCampaign: (...args: unknown[]) => {
      created.push(args);
      return Promise.resolve({ id: "new1" });
    },
  },
}));
void mock.module("react-router-dom", () => ({ useNavigate: () => (to: string) => navigated.push(to) }));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NewCampaignDialog } = await import("./NewCampaignDialog");
afterAll(() => dom.uninstall());

test("Discover prospects needs both answers, sends the discovery layout, and opens on the thesis", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const type = (id: string, value: string) => act(() => {
    const field = el.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  try {
    await act(() => root.render(<NewCampaignDialog open onClose={() => {}} campaigns={[]} />));
    await type("nc-name", "Q4 manufacturers");
    expect(button("Create campaign").disabled).toBe(false);
    await act(() => button("Discover prospects").click());
    // Now the two questions are asked, and both are required.
    expect(el.querySelector("#nc-offer")).not.toBeNull();
    expect(button("Create & continue").disabled).toBe(true);
    await type("nc-offer", "24/7 monitoring");
    expect(button("Create & continue").disabled).toBe(true);
    await type("nc-avatar", "Mid-size manufacturers");
    expect(button("Create & continue").disabled).toBe(false);
    await act(async () => {
      button("Create & continue").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(created).toEqual([["Q4 manufacturers", "discovery", { offer: "24/7 monitoring", avatar: "Mid-size manufacturers" }]]);
    expect(navigated).toEqual(["/c/new1?discover=thesis"]);
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
