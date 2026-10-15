import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** A page's title, written on a sticky note pinned to the board, with an optional small line above it. */
export function PageTitle({ children, kicker, onClick, className }: { children: ReactNode; kicker?: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <div onClick={onClick} className={cn("relative inline-block -rotate-1 rounded-lg border-2 border-rim bg-note px-6 pt-4 pb-3 shadow-hard-sm select-none", onClick && "cursor-pointer", className)}>
      <span aria-hidden className="pin" />
      {kicker && <div className="mb-1.5 font-label text-sm">{kicker}</div>}
      <h1 className="font-display text-[2.5rem] leading-none font-bold tracking-tight">{children}</h1>
    </div>
  );
}
