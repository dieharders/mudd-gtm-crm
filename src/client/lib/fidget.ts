/** Whether the side menu shows the Fidget; clicking the home greeting note toggles it. Lasts until the app closes. */
import { useSyncExternalStore } from "react";

let shown = false;
const listeners = new Set<() => void>();

export function toggleFidget() {
  shown = !shown;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const getShown = () => shown;

export function useFidgetShown(): boolean {
  return useSyncExternalStore(subscribe, getShown);
}
