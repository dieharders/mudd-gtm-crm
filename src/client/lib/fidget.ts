/** Whether the side menu shows the Fidget; clicking the home greeting note toggles it. Lasts until the app closes. */
import { useSyncExternalStore } from "react";

let shown = false;
const listeners = new Set<() => void>();

export function toggleFidget() {
  shown = !shown;
  listeners.forEach((l) => l());
}

export function useFidgetShown(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => shown);
}
