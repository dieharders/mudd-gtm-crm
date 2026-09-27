import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** The Mudd mark: a violet tile with a playful "m" and a lemon dot. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="mudd-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9c80ff" />
          <stop offset="1" stopColor="#6744f5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#mudd-g)" />
      <path d="M6.5 16V10.5a2.25 2.25 0 0 1 4.5 0V16m0-5.5a2.25 2.25 0 0 1 4.5 0V16" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.2" cy="6.3" r="1.9" fill="#fde047" />
    </svg>
  );
}

/** A small pastel square holding an icon or an initial, as on Clay's cards. */
export function Tile({ className, children, size = "md" }: { className?: string; children: ReactNode; size?: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? "h-6 w-6 rounded-md text-[11px]" : size === "lg" ? "h-10 w-10 rounded-xl text-base" : "h-8 w-8 rounded-lg text-sm";
  return <span className={cn("inline-flex shrink-0 items-center justify-center font-semibold", s, className)}>{children}</span>;
}
