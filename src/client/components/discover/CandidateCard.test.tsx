/** The inbox card: Accept sends only the ticked people, Dismiss sends its reason, and a failed map offers Map again. */
import { afterAll, expect, test } from "bun:test";
import type { Candidate } from "../../../shared/sourcing";
import { failOnConsoleError, installDom } from "../../../test/dom";

const dom = installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CandidateCard } = await import("./CandidateCard");
afterAll(() => dom.uninstall());

const now = Date.now();
const candidate: Candidate = {
  id: "c1", campaignId: "x", runId: "r", status: "ready", company: "Acme Metal", website: "https://acmemetal.com", location: "Austin, TX", employees: 400, fit: "High",
  whyFit: "Two plants, hiring a security lead", whyNow: "Insurance renewal in Q1", budget: "IT budget", clock: "FY ends June", sources: [{ url: "https://lists.example/acme" }],
  contacts: [
    { id: "ann", name: "Ann Lee", title: "IT Director", type: "Champion", dealRole: "Starts the search", gain: "Sleep", angle: "Assessment", linkedin: null, source: "https://acmemetal.com/team", confidence: "high" },
    { id: "bob", name: "Bob Ray", title: "CFO", type: "Economic Buyer", dealRole: "Signs", gain: "Lower premium", angle: "Insurance math", linkedin: null, source: "https://acmemetal.com/team", confidence: "medium" },
  ],
  firstContact: "ann", angle: "Association lists", error: null, dismissReason: null, rowId: null, createdAt: now, updatedAt: now,
};

test("accept sends only the ticked contacts; dismiss sends its reason", async () => {
  const restoreConsole = failOnConsoleError();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const accepted: string[][] = [];
  const dismissed: string[] = [];
  const mapped: number[] = [];
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const show = (c: Candidate) => act(() => root.render(
    <CandidateCard c={c} typeOptions={["Economic Buyer", "Champion"]} onAccept={(ids) => accepted.push(ids)} onDismiss={(r) => dismissed.push(r)} onMapAgain={() => mapped.push(1)} />,
  ));
  try {
    await show(candidate);
    expect(el.textContent).toContain("Acme Metal");
    expect(el.textContent).toContain("High fit");
    expect(el.textContent).toContain("Approach first");
    expect(button("Accept").textContent).toContain("2 contacts");
    const boxes = [...el.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    await act(() => boxes[1]!.click());
    expect(button("Accept").textContent).toContain("1 contact)");
    await act(() => button("Accept").click());
    expect(accepted).toEqual([["ann"]]);

    await act(() => button("Dismiss").click());
    const reason = el.querySelector("#dc-reason") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reason), "value")!.set!;
    await act(() => {
      setter.call(reason, "Already has a SOC");
      reason.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(() => reason.form!.requestSubmit());
    expect(dismissed).toEqual(["Already has a SOC"]);

    // A company whose map turn failed: no Accept of its people, but Map again.
    await show({ ...candidate, status: "error", contacts: [], error: "Timed out" });
    expect(el.textContent).toContain("Timed out");
    await act(() => button("Map again").click());
    expect(mapped).toEqual([1]);
    // Still being mapped: nothing to accept yet.
    await show({ ...candidate, status: "mapping", contacts: [] });
    expect(button("Accept")).toBeUndefined();
    expect(el.textContent).toContain("Mapping the buying committee");
  } finally {
    await act(() => root.unmount());
    el.remove();
    restoreConsole();
  }
});
