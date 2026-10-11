/** Helpers shared by the prompt builders. */

/** A long value is cut before it goes into a prompt: it may be sent once per row of a run. */
export const clip = (v: string, n = 600) => (v.length > n ? `${v.slice(0, n)}…` : v);
