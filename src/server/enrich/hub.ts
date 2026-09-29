/**
 * Per-campaign server-sent events: run progress, new suggestions, auto-filled cells.
 * The page opens one stream while a campaign is on screen.
 */
import type { CampaignEvent } from "../../shared/ai";

type Send = (frame: string) => void;
const subscribers = new Map<string, Set<Send>>();

const frame = (ev: CampaignEvent) => `data: ${JSON.stringify(ev)}\n\n`;

/**
 * Send an event to every page showing the campaign. It is serialised once, before this
 * returns, so a caller may pass live objects (a running run) and go on changing them.
 */
export function publish(campaignId: string, ev: CampaignEvent): void {
  const subs = subscribers.get(campaignId);
  if (!subs?.size) return;
  const data = frame(ev);
  for (const send of subs) send(data);
}

/**
 * One page's stream. `snapshot` goes first, taken in the same tick the page is subscribed, so
 * it and the events after it are one unbroken sequence: a page that connects (or reconnects)
 * mid-run gets each live run as it is now, then every change to it.
 */
export function eventStream(campaignId: string, snapshot: () => CampaignEvent[] = () => []): Response {
  const enc = new TextEncoder();
  let send: Send | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (data) => {
        try {
          controller.enqueue(enc.encode(data));
        } catch {
          /* closed */
        }
      };
      const set = subscribers.get(campaignId) ?? new Set();
      set.add(send);
      subscribers.set(campaignId, set);
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of snapshot()) send(frame(ev));
      // Under the server's idle timeout, so a quiet stream is never cut.
      ping = setInterval(() => send?.(frame({ type: "ping" })), 25_000);
    },
    cancel() {
      if (ping) clearInterval(ping);
      if (send) subscribers.get(campaignId)?.delete(send);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
  });
}
