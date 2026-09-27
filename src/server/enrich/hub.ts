/**
 * Per-campaign server-sent events: run progress, new suggestions, auto-filled cells.
 * The page opens one stream while a campaign is on screen.
 */
import type { CampaignEvent } from "../../shared/ai";

type Send = (ev: CampaignEvent) => void;
const subscribers = new Map<string, Set<Send>>();

export function publish(campaignId: string, ev: CampaignEvent): void {
  for (const send of subscribers.get(campaignId) ?? []) send(ev);
}

export function eventStream(campaignId: string): Response {
  const enc = new TextEncoder();
  let send: Send | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (ev) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* closed */
        }
      };
      const set = subscribers.get(campaignId) ?? new Set();
      set.add(send);
      subscribers.set(campaignId, set);
      controller.enqueue(enc.encode(": connected\n\n"));
      // Under the server's idle timeout, so a quiet stream is never cut.
      ping = setInterval(() => send?.({ type: "ping" }), 25_000);
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
