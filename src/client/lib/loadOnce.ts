/** Load something for a campaign when it comes on screen; a reply for one the page has left is dropped. */
import { useEffect } from "react";

export function useLoadOnce(id: string, load: (current: () => boolean) => void): void {
  useEffect(() => {
    if (!id) return;
    let current = true;
    load(() => current);
    return () => {
      current = false;
    };
    // Only when the campaign changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
