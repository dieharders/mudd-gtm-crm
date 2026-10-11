/** The thesis editor: typing saves after a moment, and an AI draft becomes the user's on edit or Keep. */
import { afterAll, expect, mock, test } from "bun:test";
import type { CampaignBundle } from "../../../shared/types";
import { failOnConsoleError, installDom } from "../../../test/dom";
import type { CampaignState } from "../../hooks/useCampaign";
import type { DiscoveryState } from "../../hooks/useDiscovery";

const puts: unknown[] = [];
const bundle: CampaignBundle = {
  campaign: { id: "D", name: "Disco", createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: { columns: [] }, sheets: [] },
  rows: [], contacts: [], templates: [],
  thesis: { campaignId: "D", answers: { offer: "SOC monitoring", avatar: "Manufacturers", pains: "Drafted pains", jobs: "Drafted jobs" }, drafted: ["pains", "jobs"], updatedAt: 0 },
};
void mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    campaign: () => Promise.resolve(bundle),
    discovery: () => Promise.resolve({ runs: [], candidates: [] }),
    updateThesis: (id: string, patch: unknown) => {
      puts.push(patch);
      return Promise.resolve(bundle.thesis);
    },
  },
}));
void mock.module("../../lib/campaignEvents", () => ({ useCampaignEvents: () => {} }));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCampaign } = await import("../../hooks/useCampaign");
const { useConsentGate } = await import("../../hooks/useConsentGate");
const { useDiscovery } = await import("../../hooks/useDiscovery");
const { ThesisEditor } = await import("./ThesisEditor");
afterAll(() => dom.uninstall());

let state: CampaignState | null = null;
let discovery: DiscoveryState | null = null;
function Probe() {
  state = useCampaign("D");
  discovery = useDiscovery(state, useConsentGate());
  return discovery.enabled ? <ThesisEditor discovery={discovery} ready={false} onSetup={() => {}} onNext={() => {}} /> : null;
}

test("an edited answer is saved after the debounce, and the AI-draft tag clears on edit or Keep", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => {
      root.render(<Probe />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(discovery!.enabled).toBe(true);
    const tags = () => [...el.querySelectorAll("span")].filter((s) => s.textContent?.includes("AI draft")).length;
    expect(tags()).toBe(2);
    const pains = el.querySelector("#th-pains") as HTMLTextAreaElement;
    expect(pains.value).toBe("Drafted pains");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pains), "value")!.set!;
    await act(() => {
      setter.call(pains, "Ransomware scares");
      pains.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    expect(tags()).toBe(1);
    expect(puts).toEqual([]);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(puts).toEqual([{ answers: { pains: "Ransomware scares" } }]);
    // Keep: the draft stays as it is, and is the user's now.
    const keep = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Keep"))!;
    await act(async () => {
      keep.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tags()).toBe(0);
    expect(puts.at(-1)).toEqual({ keep: ["jobs"] });
    expect(discovery!.thesis!.drafted).toEqual([]);
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
