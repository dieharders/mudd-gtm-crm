/** The generate dialog: prefilled from the thesis, the draft is shown first, and only Keep saves. */
import { afterAll, expect, mock, test } from "bun:test";
import type { Thesis } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";
import type { ConsentGate } from "../../hooks/useConsentGate";

const calls: unknown[] = [];
void mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    generateTemplate: (id: string, problem: string) => {
      calls.push({ id, problem });
      return Promise.resolve({ name: "Learning intro", body: "Hi {{First name}},\n\n[Your name]", unknown: ["Budget"] });
    },
  },
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GenerateTemplateDialog, prefillFromThesis } = await import("./GenerateTemplateDialog");
afterAll(() => dom.uninstall());

const thesis: Thesis = { campaignId: "D", answers: { offer: "SOC monitoring", avatar: "Manufacturers", pains: "Ransomware" }, drafted: [], updatedAt: 0 };
const consent: ConsentGate = { needsConsent: null, withConsent: (attempt) => attempt() };

test("prefillFromThesis joins the problem answers by label; nothing without a thesis", () => {
  expect(prefillFromThesis(thesis)).toBe("What do you sell?: SOC monitoring\nTheir pain points: Ransomware");
  expect(prefillFromThesis(null)).toBe("");
});

test("generate shows the draft; Keep saves it with the (edited) name, Discard saves nothing", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const kept: unknown[] = [];
  let closed = 0;
  const render = () => root.render(
    <GenerateTemplateDialog open campaignId="D" thesis={thesis} consent={consent} onKeep={(name, body) => { kept.push({ name, body }); return Promise.resolve(); }} onClose={() => closed++} />,
  );
  const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    await act(async () => { render(); await tick(); });
    const problem = el.querySelector("#gen-problem") as HTMLTextAreaElement;
    expect(problem.value).toContain("SOC monitoring");
    await act(async () => { button("Generate").click(); await tick(); });
    expect(calls).toEqual([{ id: "D", problem: prefillFromThesis(thesis) }]);
    expect(el.querySelector("[data-testid=gen-body]")?.textContent).toBe("Hi {{First name}},\n\n[Your name]");
    expect(el.textContent).toContain("{{Budget}} match no column");
    expect(kept).toEqual([]);

    const name = el.querySelector("#gen-name") as HTMLInputElement;
    expect(name.value).toBe("Learning intro");
    // Regenerate with the model's name untouched takes the new one…
    await act(async () => { button("Regenerate").click(); await tick(); });
    expect(calls.length).toBe(2);
    expect(name.value).toBe("Learning intro");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name), "value")!.set!;
    await act(() => {
      setter.call(name, "Curious intro");
      name.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    // …but a name the user edited survives it.
    await act(async () => { button("Regenerate").click(); await tick(); });
    expect(calls.length).toBe(3);
    expect(name.value).toBe("Curious intro");
    await act(async () => { button("Keep").click(); await tick(); });
    expect(kept).toEqual([{ name: "Curious intro", body: "Hi {{First name}},\n\n[Your name]" }]);
    expect(closed).toBe(1);

    // A second dialog, discarded: nothing more is kept.
    await act(() => root.unmount());
    const root2 = createRoot(el);
    await act(async () => {
      root2.render(<GenerateTemplateDialog open campaignId="D" thesis={null} consent={consent} onKeep={(name, body) => { kept.push({ name, body }); return Promise.resolve(); }} onClose={() => closed++} />);
      await tick();
    });
    expect((el.querySelector("#gen-problem") as HTMLTextAreaElement).value).toBe("");
    expect(button("Generate").disabled).toBe(true);
    await act(() => root2.unmount());
    expect(kept.length).toBe(1);
  } finally {
    el.remove();
    restoreConsole();
  }
});
