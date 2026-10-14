/** Whether the user asked the OS for less motion; script-driven animation checks this where CSS would use `motion-safe:`. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
