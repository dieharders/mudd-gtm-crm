/** A drawer that slides in from the right: a strip of board with its actions pinned on as tilted cards. */
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useFocusReturn, useInert, useLeaving } from "../../hooks/useLeaving";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/** How long the drawer takes to slide back out: it stays mounted until then. Matches `drawer-out`. */
const LEAVE_MS = 200;

interface Content {
  title: ReactNode;
  children: ReactNode;
}

export function Pinboard({ open, title, onClose, children }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // While leaving it shows what it last had open, as a Modal does: a switch of tab as it goes
  // doesn't swap its board.
  const { shown, leaving, last: c } = useLeaving<Content>(open, LEAVE_MS, { title, children });
  const layer = useInert<HTMLDivElement>(leaving);
  // Each opening starts the board afresh, as if it had gone: one reopened as it leaves would
  // otherwise keep what it had (the cards a filter board keeps up until it closes).
  const [opening, setOpening] = useState({ open, n: 0 });
  if (open !== opening.open) setOpening({ open, n: opening.n + Number(open) });
  // Focus goes to Close as it opens, and back to what opened it (its button) as it closes.
  useFocusReturn(open, layer, closeRef);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!shown) return null;
  return (
    // Click-through (and inert) while leaving, so the page is usable as soon as it is asked to close.
    <div ref={layer} className={cn("fixed inset-0 z-40", leaving && "pointer-events-none")} onMouseDown={onClose}>
      {/* The dim fades on a layer of its own: on the drawer's parent it would fade the drawer too. */}
      <div className={cn("absolute inset-0 bg-mud/25", leaving ? "animate-fade-out" : "animate-fade-in")} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof c.title === "string" ? c.title : undefined}
        className={cn(
          "absolute inset-y-0 right-0 flex w-[min(400px,100%)] flex-col border-l-2 border-rim-deep bg-board shadow-[-10px_0_30px_-12px_rgba(43,30,22,0.45)]",
          leaving ? "animate-drawer-out" : "animate-drawer-in",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-6 pt-5 pb-2">
          <h2 className="min-w-0 flex-1 truncate font-display text-[22px] leading-tight font-bold text-mud">{c.title}</h2>
          <Button ref={closeRef} size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X size={20} /></Button>
        </div>
        <div key={opening.n} className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-8 scroll-thin">{c.children}</div>
      </aside>
    </div>
  );
}

/** A labelled group of cards on the board. */
export function PinGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <h3 className="eyebrow mb-6">{label}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-7">{children}</div>
    </section>
  );
}

// Each card leans its own way, as if pinned up by hand.
const TILTS = ["-rotate-2", "rotate-1", "rotate-2", "-rotate-1"];

export interface PinCardProps {
  icon: ReactNode;
  label: string;
  hint?: ReactNode;
  /** Something waiting there: shown as a badge on the card. */
  count?: number;
  /** The note's fill. */
  tone?: string;
  danger?: boolean;
  /** Its place on the board, for its tilt and when it lands. */
  index?: number;
  onClick: () => void;
  title?: string;
}

/**
 * A note card pinned to the board, as a button: it lands in its turn, leans by its place, and
 * straightens up when hovered. The pin goes last, so the card's own content comes first.
 */
function Pinned({ index, className, children, ...button }: { index: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <div className="animate-pop" style={{ animationDelay: `${60 + index * 35}ms` }}>
      <button
        type="button"
        {...button}
        className={cn(
          "relative flex h-full w-full flex-col items-start rounded-xl border-2 border-rim px-4 pt-5 text-left shadow-hard transition",
          "hover:-translate-y-0.5 hover:rotate-0 hover:shadow-hard-lg active:translate-y-0.5 active:shadow-hard-sm",
          TILTS[index % TILTS.length],
          className,
        )}
      >
        {children}
        <span className="pin scale-75" />
      </button>
    </div>
  );
}

/** One action on the board: a pinned note card. */
export function PinCard({ icon, label, hint, count, tone = "bg-paper", danger, index = 0, onClick, title }: PinCardProps) {
  return (
    <Pinned index={index} onClick={onClick} title={title} className={cn("gap-2 pb-4", tone, danger ? "text-coral-700" : "text-mud")}>
      <span className="flex w-full items-center gap-2">
        <span className={cn("shrink-0", danger ? "text-coral-600" : "text-mud-soft")}>{icon}</span>
        {count !== undefined && count > 0 && (
          <span className="ml-auto rounded-full border border-rim bg-clay px-2 font-label text-[12px] leading-5 font-bold text-paper tabular-nums">{count}</span>
        )}
      </span>
      <span className="font-label text-[16px] leading-tight font-bold">{label}</span>
      {/* Mud-soft, not faint: the faint grey washes out on the tinted notes. */}
      {hint && <span className={cn("line-clamp-2 font-label text-[12px] leading-snug [overflow-wrap:anywhere]", danger ? "text-coral-800/80" : "text-mud-soft")}>{hint}</span>}
    </Pinned>
  );
}

export interface PinToggleProps {
  label: string;
  count: number;
  active: boolean;
  index?: number;
  onClick: () => void;
  title?: string;
}

/** A filter on the board: a pinned card turned on and off, grey at rest and yellow while on. */
export function PinToggle({ label, count, active, index = 0, onClick, title }: PinToggleProps) {
  return (
    <Pinned index={index} onClick={onClick} title={title} aria-pressed={active}
      className={cn("gap-1 pb-3.5 font-label", active ? "bg-note text-mud" : "bg-paper-deep text-mud-soft hover:text-mud")}>
      <span className={cn("text-[15px] leading-tight [overflow-wrap:anywhere]", active && "font-bold")}>{label}</span>
      <span className="text-[22px] leading-none opacity-70 tabular-nums">{count}</span>
    </Pinned>
  );
}
