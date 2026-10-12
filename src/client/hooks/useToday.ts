import { useEffect, useState } from "react";
import { todayString } from "../lib/format";

/**
 * Today's date ("2026-10-11"), turning over at midnight. Checked again when the window comes
 * back too: a timer can sleep through midnight with the computer.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayString);
  useEffect(() => {
    const check = () => setToday(todayString());
    const now = new Date();
    const timer = setTimeout(check, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [today]);
  return today;
}
