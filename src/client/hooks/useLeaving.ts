import { useEffect, useState } from "react";

/**
 * Keeps something on screen for `ms` after it is closed, so it can animate out.
 * `shown` stays true from opening until then; `leaving` is true only while it goes.
 */
export function useLeaving(open: boolean, ms: number) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const leaving = shown && !open;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [leaving, ms]);
  return { shown, leaving };
}
