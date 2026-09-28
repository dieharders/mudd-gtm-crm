/**
 * The campaign hook when the page switches campaigns. Its callbacks used to keep the first
 * campaign's id, so after a switch in the sidebar every edit was saved to the previous
 * campaign (and silently dropped there). The route now remounts the page per campaign; this
 * checks the hook itself is right without that.
 */
import { afterAll, expect, mock, test } from "bun:test";
import type { CampaignBundle, CellEdit } from "../../shared/types";
import { failOnConsoleError, installDom } from "../../test/dom";
import type { CampaignState } from "./useCampaign";

const saved: { id: string; edits: CellEdit[] }[] = [];
const bundle = (id: string): CampaignBundle => ({
  campaign: { id, name: id, createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: { columns: [{ key: "company", header: "Company", type: "text" }] }, sheets: [] },
  rows: [{ id: `${id}-row`, position: 0, cells: { company: `${id} Co` } }],
  templates: [],
});
void mock.module("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    campaign: (id: string) => Promise.resolve(bundle(id)),
    editRows: (id: string, edits: CellEdit[]) => {
      saved.push({ id, edits });
      return Promise.resolve({ updatedAt: 1 });
    },
  },
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCampaign } = await import("./useCampaign");
afterAll(() => dom.uninstall());

let current: CampaignState | null = null;
function Probe({ id }: { id: string }) {
  current = useCampaign(id);
  return null;
}

test("after switching campaigns, an edit is saved to the campaign on screen", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  const root = createRoot(el);
  // Render, then let the (mocked) load finish, all inside act().
  const show = (id: string) =>
    act(async () => {
      root.render(<Probe id={id} />);
      await new Promise((r) => setTimeout(r, 0));
    });
  try {
    await show("A");
    // Switch WITHOUT a remount, as a route without a key did.
    await show("B");
    expect(current!.campaign?.id).toBe("B");
    await act(() => {
      current!.edit([{ rowId: "B-row", key: "company", value: "Renamed" }]);
    });
    await act(() => current!.flush());
    expect(saved).toEqual([{ id: "B", edits: [{ rowId: "B-row", key: "company", value: "Renamed" }] }]);
  } finally {
    await act(() => root.unmount());
    restoreConsole();
  }
});
