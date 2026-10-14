import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

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
    // The attribute, as `inert` reflects it: useFocusReturn looks for it.
    el.toggleAttribute("inert", on);
    if (on && document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
  }, [on]);
  return ref;
}

/**
 * What opened a layer that closed as a dialog opened over that (a card on the More drawer opening
 * a panel), handed to the new dialog to give focus back to as it closes. Good only for the effects
 * of the render that did both.
 */
let handedOver: HTMLElement | null = null;

/**
 * What focus last left, good only until the work that moved it is done: a field that focuses
 * itself as its layer opens does so before the layer's effects run, and took focus from there.
 */
let left: Element | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusout", (e) => {
    left = e.target as Element;
    queueMicrotask(() => (left = null));
  }, true);
}

/** The modal dialogs open outside `layer`, any leaving (inert) aside. */
export const dialogsOutside = (layer: HTMLElement | null) =>
  [...document.querySelectorAll('[aria-modal="true"]')].filter((d) => !layer?.contains(d) && !d.closest("[inert]"));

/**
 * Focus for a layer (a dialog, the prospect panel) while `open`. As it opens, focus goes to `into`,
 * unless something in the layer has taken it already (a field that focuses itself); with no `into`,
 * it stays where it is. As it closes, focus goes back to what opened it, unless something else has
 * taken it by then, or a dialog is open over that: one that opened as this closed (from one of its
 * buttons) gives focus back there itself, as it closes.
 */
export function useFocusReturn(open: boolean, layer: RefObject<HTMLElement | null>, into?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const el = layer.current;
    const at = document.activeElement;
    const from = !at || at === document.body ? handedOver : el?.contains(at) ? left : at;
    if (!el?.contains(at)) into?.current?.focus();
    return () => {
      const now = document.activeElement;
      if (!(from instanceof HTMLElement) || !from.isConnected || from.closest("[inert]")) return;
      if (now && now !== document.body && !el?.contains(now)) return;
      if (dialogsOutside(el).some((d) => !d.contains(from))) {
        handedOver = from;
        queueMicrotask(() => (handedOver = null));
        return;
      }
      from.focus();
    };
  }, [open, layer, into]);
}
