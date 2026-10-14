import { X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useFocusReturn, useInert, useLeaving } from "../../hooks/useLeaving";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/** How long a panel takes to go: it stays mounted until then. Matches `fade-out`. */
const LEAVE_MS = 200;

const Leaving = createContext(false);

/**
 * Mounts a Panel while `open`, and keeps it up for LEAVE_MS after, showing what it last had,
 * so it can animate out.
 */
export function PanelGate({ open, children }: { open: boolean; children: ReactNode }) {
  const { shown, leaving, last } = useLeaving(open, LEAVE_MS, children);
  if (!shown) return null;
  return <Leaving.Provider value={leaving}>{last}</Leaving.Provider>;
}

/**
 * A large centred dialog for the campaign's workspaces (Discover, Enrich, Review, Templates):
 * a paper card over a dimmed board, with a header row and a body the caller lays out
 * (usually a rail and a main column). Closes on the backdrop; nested dialogs stop the click.
 * Escape closes it too, except from a field, where it belongs to the field. A Modal or menu open
 * on top takes the key first (on the window, as it comes down) and stops it; this panel takes it
 * on the document, on the way back up, and stops it there, before the prospect panel under it
 * (on the window) would close too.
 */
export function Panel({ title, subtitle, icon, onClose, closeLabel = "Close", width = "max-w-[1080px]", children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  /** A max-width class; the panel is as wide as the window allows below it. */
  width?: string;
  children: ReactNode;
}) {
  const leaving = useContext(Leaving);
  const layer = useInert<HTMLDivElement>(leaving);
  // Focus goes into it as it opens, and back to what opened it as it closes.
  const box = useRef<HTMLDivElement>(null);
  useFocusReturn(!leaving, layer, box);
  useEffect(() => {
    if (leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, leaving]);

  return (
    // Click-through (and inert) while leaving, so the page is usable as soon as it is asked to close.
    <div
      ref={layer}
      className={cn(
        "fixed inset-0 z-40 flex items-center justify-center bg-mud/35 p-4 md:p-8",
        leaving ? "pointer-events-none animate-fade-out" : "animate-fade-in",
      )}
      onMouseDown={onClose}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn("flex h-full max-h-[920px] w-full flex-col overflow-hidden rounded-2xl border-2 border-rim-deep bg-paper shadow-dialog outline-none", leaving ? "animate-pop-out" : "animate-pop", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 border-b-2 border-rim/40 px-6 py-4">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[22px] leading-tight font-bold text-mud">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-[14px] text-mud-soft">{subtitle}</p>}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label={closeLabel}><X size={20} /></Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A left-rail entry in a Panel: icon, label with an optional count, and a hint line. */
export const railItem = (active: boolean) =>
  cn("flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition", active ? "border-rim bg-paper text-mud shadow-hard-sm" : "border-transparent hover:bg-paper-deep");
