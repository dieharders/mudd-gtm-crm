import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A page's title, written on a sticky note pinned to the board, with an optional small line above
 * it. With onClick, the title is a button whose hit area stretches over the whole note.
 */
export function PageTitle({ children, kicker, onClick, className }: { children: ReactNode; kicker?: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <div className={cn("relative inline-block -rotate-1 rounded-lg border-2 border-rim bg-note px-6 pt-4 pb-3 shadow-hard-sm select-none", className)}>
      <span aria-hidden className="pin" />
      {kicker && <div className="mb-1.5 font-label text-sm">{kicker}</div>}
      <h1 className="font-display text-[2.5rem] leading-none font-bold tracking-tight">
        {onClick ? (
          <button type="button" onClick={onClick} className="cursor-pointer outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-lake/60">
            {children}
          </button>
        ) : children}
      </h1>
    </div>
  );
}
