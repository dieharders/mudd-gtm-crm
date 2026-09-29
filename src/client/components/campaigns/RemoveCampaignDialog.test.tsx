/** Removing a campaign: what the dialog promises about the file, and what it does, in order. */
import { afterAll, expect, mock, test } from "bun:test";
import { failOnConsoleError, installDom } from "../../../test/dom";

const calls: string[] = [];
void mock.module("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    deleteCampaign: (id: string) => {
      calls.push(`delete ${id}`);
      return Promise.resolve({ ok: true });
    },
  },
}));
void mock.module("../../lib/campaignList", () => ({
  useCampaignList: () => ({ campaigns: [], meetings: [], refresh: () => calls.push("refresh") }),
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RemoveCampaignDialog } = await import("./RemoveCampaignDialog");
afterAll(() => dom.uninstall());

test("the dialog names the file that stays, sends waiting edits, then removes", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const text = () => document.body.textContent ?? "";
  try {
    const linked = { id: "c1", name: "Base tracker", sourceName: "base-tracker.xlsx", sourcePath: "/Users/me/Downloads/base-tracker.xlsx" };
    await act(() => root.render(
      <RemoveCampaignDialog campaign={linked} onClose={() => calls.push("close")}
        beforeRemove={async () => { calls.push("flush"); }} onRemoved={() => calls.push("removed")} />,
    ));
    expect(text()).toContain("Remove Base tracker from Mudd?");
    expect(text()).toContain("base-tracker.xlsx stays where it is");
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Remove from Mudd"))!;
    await act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual(["flush", "delete c1", "close", "removed", "refresh"]);

    // Never saved anywhere: said plainly.
    await act(() => root.render(<RemoveCampaignDialog campaign={{ id: "c2", name: "Fresh", sourceName: null, sourcePath: null }} onClose={() => {}} />));
    expect(text()).toContain("never been saved to a file");
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
