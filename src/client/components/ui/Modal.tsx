import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useFocusReturn, useInert, useLeaving } from "../../hooks/useLeaving";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/** How long the dialog takes to go: it stays mounted until then. Matches `fade-out`. */
const LEAVE_MS = 200;

interface Content {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** `locked` holds the dialog open (Escape, the backdrop and × do nothing) while work in it must not be cut short. */
export function Modal({
  open, onClose, title, subtitle, children, footer, width = "max-w-lg", locked = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  locked?: boolean;
}) {
  // While leaving it shows what it last had open: callers often clear the data it was showing as they close it.
  const { shown, leaving, last: c } = useLeaving<Content>(open, LEAVE_MS, { title, subtitle, children, footer });
  const layer = useInert<HTMLDivElement>(leaving);
  // Focus goes into it as it opens, and back to what opened it as it closes.
  const box = useRef<HTMLDivElement>(null);
  useFocusReturn(open, layer, box);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!locked) onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, locked]);

  if (!shown) return null;
  return (
    // Click-through (and inert) while leaving, so the page is usable as soon as it is asked to close.
    <div
      ref={layer}
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-mud/35 p-6 pt-[8vh]",
        leaving ? "pointer-events-none animate-fade-out" : "animate-fade-in",
      )}
      onMouseDown={locked ? undefined : onClose}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn("w-full rounded-2xl border-2 border-rim-deep bg-paper shadow-dialog outline-none", leaving ? "animate-pop-out" : "animate-pop", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b-2 border-rim/40 px-6 py-5">
          <div>
            <h2 className="font-display text-[22px] leading-tight font-bold text-mud">{c.title}</h2>
            {c.subtitle && <p className="mt-1 text-[15px] text-mud-soft">{c.subtitle}</p>}
          </div>
          <Button size="icon" variant="ghost" className="-mt-1.5 -mr-2" onClick={onClose} disabled={locked} aria-label="Close"><X size={20} /></Button>
        </div>
        <div className="px-6 py-5 text-[15px]">{c.children}</div>
        {c.footer && <div className="flex justify-end gap-3 rounded-b-2xl border-t-2 border-rim/40 bg-paper-deep/40 px-6 py-4">{c.footer}</div>}
      </div>
    </div>
  );
}
