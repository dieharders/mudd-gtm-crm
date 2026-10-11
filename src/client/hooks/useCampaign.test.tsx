/**
 * The campaign hook. When the page switches campaigns: its callbacks used to keep the first
 * campaign's id, so after a switch in the sidebar every edit was saved to the previous campaign
 * (and silently dropped there). The route now remounts the page per campaign; this checks the
 * hook itself is right without that. And prospects with their contacts: one array underneath,
 * so a prospect and its people are deleted, restored and edited in single undo steps.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { CampaignBundle, CampaignSchema, CellEdit, Row } from "../../shared/types";
import { CHECKED } from "../../shared/types";
import { failOnConsoleError, installDom } from "../../test/dom";
import type { CampaignState } from "./useCampaign";

const saved: { id: string; edits: CellEdit[] }[] = [];
const deleted: string[][] = [];
const inserted: Partial<Row>[][] = [];

const people: CampaignSchema = {
  columns: [{ key: "id", header: "ID", type: "text", hidden: true }, { key: "company", header: "Company", type: "text" }],
  idKey: "id",
  companyKey: "company",
  contacts: {
    columns: [{ key: "name", header: "Name", type: "text" }, { key: "primary", header: "Primary", type: "checkbox" }],
    nameKey: "name",
    primaryKey: "primary",
  },
};
const bundle = (id: string): CampaignBundle =>
  id === "P"
    ? {
      campaign: { id, name: id, createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: people, sheets: [] },
      rows: [{ id: "acme", position: 0, cells: { id: "P-001", company: "Acme" } }, { id: "beta", position: 1, cells: { id: "P-004", company: "Beta" } }],
      contacts: [
        { id: "ann", position: 2, parentId: "acme", cells: { name: "Ann", primary: CHECKED } },
        { id: "al", position: 3, parentId: "acme", cells: { name: "Al" } },
      ],
      templates: [],
      thesis: null,
    }
    : {
      campaign: { id, name: id, createdAt: 0, updatedAt: 0, sourceName: null, sourcePath: null, hasOriginal: false, schema: { columns: [{ key: "company", header: "Company", type: "text" }] }, sheets: [] },
      rows: [{ id: `${id}-row`, position: 0, cells: { company: `${id} Co` } }],
      contacts: [],
      templates: [],
      thesis: null,
    };
void mock.module("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    campaign: (id: string) => Promise.resolve(bundle(id)),
    editRows: (id: string, edits: CellEdit[]) => {
      saved.push({ id, edits });
      return Promise.resolve({ updatedAt: 1 });
    },
    insertRows: (_id: string, rows: Partial<Row>[]) => {
      inserted.push(rows);
      return Promise.resolve(rows);
    },
    deleteRows: (_id: string, ids: string[]) => {
      deleted.push(ids);
      return Promise.resolve({ ok: true });
    },
  },
}));

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCampaign } = await import("./useCampaign");
afterAll(() => dom.uninstall());
beforeEach(() => {
  saved.length = 0;
  deleted.length = 0;
  inserted.length = 0;
});

let current: CampaignState | null = null;
function Probe({ id }: { id: string }) {
  current = useCampaign(id);
  return null;
}

/** Mount the hook on a campaign; `run` gets it once loaded. */
async function withCampaign(id: string, run: (s: () => CampaignState) => Promise<void>) {
  const restoreConsole = failOnConsoleError();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(<Probe id={id} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    await run(() => current!);
  } finally {
    await act(() => root.unmount());
    restoreConsole();
  }
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

test("prospects and contacts are separate lists of one campaign", () =>
  withCampaign("P", async (s) => {
    expect(s().rows.map((r) => r.id)).toEqual(["acme", "beta"]);
    expect(s().contacts.map((r) => r.id)).toEqual(["ann", "al"]);
    expect(s().contactsOf("acme").map((r) => r.id)).toEqual(["ann", "al"]);
    expect(s().contactsOf("beta")).toEqual([]);
    // An edit to Beta leaves Acme's list the same array: its card needn't re-render.
    const before = s().contactsOf("acme");
    await act(() => {
      s().edit([{ rowId: "beta", key: "company", value: "Beta Labs" }]);
    });
    expect(s().contactsOf("acme")).toBe(before);
  }));

test("deleting a prospect takes its contacts, in one undo step that brings them all back", () =>
  withCampaign("P", async (s) => {
    await act(() => s().deleteRows(["acme"]));
    expect(s().rows.map((r) => r.id)).toEqual(["beta"]);
    expect(s().contacts).toEqual([]);
    expect(deleted.at(-1)!.sort()).toEqual(["acme", "al", "ann"]);
    await act(() => {
      expect(s().undo()).toBe("Delete row");
    });
    expect(s().rows.map((r) => r.id)).toEqual(["acme", "beta"]);
    expect(s().contactsOf("acme").map((r) => r.id)).toEqual(["ann", "al"]);
    expect(inserted.at(-1)!.map((r) => [r.id, r.parentId ?? null])).toEqual([["acme", null], ["ann", "acme"], ["al", "acme"]]);
  }));

test("ticking a contact Primary unticks the other, in one undo step", () =>
  withCampaign("P", async (s) => {
    await act(() => {
      s().makePrimary("al");
    });
    const primary = () => s().contacts.map((c) => [c.id, c.cells.primary ?? null]);
    expect(primary()).toEqual([["ann", null], ["al", CHECKED]]);
    await act(() => {
      expect(s().undo()).toBe("Make primary");
    });
    expect(primary()).toEqual([["ann", CHECKED], ["al", null]]);
  }));

test("pasting Primary ticks over two contacts of one prospect leaves one ticked: the last", () =>
  withCampaign("P", async (s) => {
    await act(() => {
      s().editContacts([{ rowId: "ann", key: "primary", value: CHECKED }, { rowId: "al", key: "primary", value: CHECKED }], "Paste");
    });
    expect(s().contacts.map((c) => [c.id, c.cells.primary ?? null])).toEqual([["ann", null], ["al", CHECKED]]);
  }));

test("an edit to a contact leaves the prospect list the same array: nothing sorted from it reruns", () =>
  withCampaign("P", async (s) => {
    const before = s().rows;
    await act(() => {
      s().editContacts([{ rowId: "al", key: "name", value: "Al Ng" }]);
    });
    expect(s().rows).toBe(before);
    expect(s().contactsOf("acme").map((c) => c.cells.name)).toEqual(["Ann", "Al Ng"]);
  }));

test("a new prospect gets the next ID; no contact of it is ticked Primary unasked", () =>
  withCampaign("P", async (s) => {
    let org: Row | null = null;
    await act(() => {
      org = s().addRow({ company: "Gamma" });
    });
    expect(org!.cells.id).toBe("P-005");
    let first: Row | null = null;
    let second: Row | null = null;
    await act(() => {
      first = s().addContact(org!.id, { name: "Gil" });
    });
    await act(() => {
      second = s().addContact(org!.id);
    });
    // Until someone is ticked, primaryOf addresses the first person: a channel added first
    // never outranks the people added after it.
    expect(first!.cells).toEqual({ name: "Gil" });
    expect(second!.cells).toEqual({});
    expect(s().contactsOf(org!.id).map((c) => c.parentId)).toEqual([org!.id, org!.id]);
    // Undoing the new prospect takes the people added to it since.
    await act(() => s().undo());
    await act(() => s().undo());
    await act(() => s().undo());
    expect(s().rows.map((r) => r.id)).toEqual(["acme", "beta"]);
  }));

test("a contact the server made is shown once, and not for a prospect deleted meanwhile", () =>
  withCampaign("P", async (s) => {
    const made: Row = { id: "srv", position: 9, parentId: "beta", cells: { primary: CHECKED } };
    await act(() => s().applyRemoteRows([made]));
    await act(() => s().applyRemoteRows([made, { id: "orphan", position: 10, parentId: "gone", cells: {} }]));
    expect(s().contactsOf("beta").map((c) => c.id)).toEqual(["srv"]);
    expect(s().contacts.some((c) => c.id === "orphan")).toBe(false);
    // Not an undo step.
    expect(s().canUndo).toBe(false);
  }));

test("a prospect and its contacts that arrive in one batch (a Discovery accept) are all shown", () =>
  withCampaign("P", async (s) => {
    await act(() => s().applyRemoteRows([
      { id: "gamma", position: 20, cells: { id: "P-005", company: "Gamma" } },
      { id: "gil", position: 21, parentId: "gamma", cells: { name: "Gil", primary: CHECKED } },
      { id: "gus", position: 22, parentId: "gamma", cells: { name: "Gus" } },
    ]));
    expect(s().rows.map((r) => r.id)).toEqual(["acme", "beta", "gamma"]);
    expect(s().contactsOf("gamma").map((c) => c.id)).toEqual(["gil", "gus"]);
    expect(s().thesis).toBeNull();
  }));
