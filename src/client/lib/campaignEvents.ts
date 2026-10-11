/**
 * The campaign's event stream, shared: one EventSource per campaign on screen, however many
 * hooks listen (enrichment and Discovery both do). It opens with the first listener and closes
 * with the last.
 */
import { useEffect, useRef } from "react";
import type { CampaignEvent } from "../../shared/ai";

type Listener = (ev: CampaignEvent) => void;

const streams = new Map<string, { es: EventSource; listeners: Set<Listener> }>();

function subscribe(id: string, listener: Listener): () => void {
  let s = streams.get(id);
  if (!s) {
    const es = new EventSource(`/api/campaigns/${id}/events`);
    const entry = { es, listeners: new Set<Listener>() };
    es.onmessage = (m) => {
      let ev: CampaignEvent;
      try {
        ev = JSON.parse(m.data) as CampaignEvent;
      } catch {
        return;
      }
      for (const l of entry.listeners) l(ev);
    };
    streams.set(id, (s = entry));
  }
  s.listeners.add(listener);
  return () => {
    const cur = streams.get(id);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (!cur.listeners.size) {
      cur.es.close();
      streams.delete(id);
    }
  };
}

/** Listen to a campaign's events while it is on screen. An empty id listens to nothing. */
export function useCampaignEvents(id: string, onEvent: Listener): void {
  // The newest handler, without reopening the stream on every render.
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!id) return;
    return subscribe(id, (ev) => handler.current(ev));
  }, [id]);
}
