/**
 * Per-campaign server-sent events: run progress, new suggestions, auto-filled cells.
 * The page opens one stream while a campaign is on screen.
 */
import type { CampaignEvent } from "../../shared/ai";
import { sseFrame, sseResponse } from "../sse";

type Send = (frame: string) => void;
const subscribers = new Map<string, Set<Send>>();

/**
 * Send an event to every page showing the campaign. It is serialised once, before this
 * returns, so a caller may pass live objects (a running run) and go on changing them.
 */
export function publish(campaignId: string, ev: CampaignEvent): void {
  const subs = subscribers.get(campaignId);
  if (!subs?.size) return;
  const data = sseFrame(ev);
  for (const send of subs) send(data);
}

/**
 * One page's stream. `snapshot` goes first, taken in the same tick the page is subscribed, so
 * it and the events after it are one unbroken sequence: a page that connects (or reconnects)
 * mid-run gets each live run as it is now, then every change to it.
 */
export function eventStream(campaignId: string, snapshot: () => CampaignEvent[] = () => []): Response {
  let send: Send | null = null;
  return sseResponse(
    (push) => {
      send = push;
      const set = subscribers.get(campaignId) ?? new Set();
      set.add(send);
      subscribers.set(campaignId, set);
      for (const ev of snapshot()) send(sseFrame(ev));
    },
    () => {
      if (send) subscribers.get(campaignId)?.delete(send);
    },
  );
}
