import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import logoUrl from "./logo.png";

/** The Mudd mark: a mud brick rising from a mound, on a blue tile. The same picture as assets/icon.png. */
export function Logo({ size = 24 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false} className="shrink-0 select-none" />;
}

/** A small pastel square holding an icon or an initial, as on Clay's cards. */
export function Tile({ className, children, size = "md" }: { className?: string; children: ReactNode; size?: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? "h-6 w-6 rounded-md text-[11px]" : size === "lg" ? "h-10 w-10 rounded-xl text-base" : "h-8 w-8 rounded-lg text-sm";
  return <span className={cn("inline-flex shrink-0 items-center justify-center font-semibold", s, className)}>{children}</span>;
}
