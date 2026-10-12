import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps something on screen for `ms` after it is closed, so it can animate out.
 * `shown` stays true from opening until then; `leaving` is true only while it goes.
 * `last` is the `value` it was last given while open: what it shows as it goes, as callers
 * often clear the data it was showing as they close it.
 */
export function useLeaving<T = undefined>(open: boolean, ms: number, value?: T) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const leaving = shown && !open;
  const last = useRef(value as T);
  if (open) last.current = value as T;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [leaving, ms]);
  return { shown, leaving, last: last.current };
}

/**
 * A ref for a layer that, while `on` (leaving), is inert: its buttons can't be focused or pressed,
 * and the one that had focus lets go of it, so Enter can't run its old handler again as it goes.
 */
export function useInert<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.inert = on;
    if (on && document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
  }, [on]);
  return ref;
}
