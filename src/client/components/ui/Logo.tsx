import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The Mudd mark: three orange mud bricks rising from the ground on a blue tile, dome-topped like
 * a Dugtrio, each with a lighter patch where a face would be. Drawn once as a hard shadow and
 * once filled and outlined, back to front. Keep assets/icon.svg identical.
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="mudd-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5eb2f7" />
          <stop offset="1" stopColor="#1b5fa8" />
        </linearGradient>
        <path id="mudd-l" d="M4.2 18.6V11a2.4 2.4 0 0 1 4.8 0v7.6z" transform="rotate(-5 6.6 18.6)" />
        <path id="mudd-r" d="M15 18.6V11.4a2.4 2.4 0 0 1 4.8 0v7.2z" transform="rotate(5 17.4 18.6)" />
        <path id="mudd-f" d="M9.1 19.4V8.3a2.9 2.9 0 0 1 5.8 0v11.1z" />
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#mudd-g)" />
      <g fill="#2b1e16" stroke="#2b1e16" strokeWidth="1.1" strokeLinejoin="round" transform="translate(0.6 0.6)">
        <use href="#mudd-l" />
        <use href="#mudd-r" />
        <use href="#mudd-f" />
      </g>
      <g fill="#d97757" stroke="#2b1e16" strokeWidth="1.1" strokeLinejoin="round">
        <use href="#mudd-l" />
        <ellipse cx="6.6" cy="12.4" rx="1.2" ry="0.9" fill="#f3b391" stroke="none" transform="rotate(-5 6.6 18.6)" />
        <use href="#mudd-r" />
        <ellipse cx="17.4" cy="12.8" rx="1.2" ry="0.9" fill="#f3b391" stroke="none" transform="rotate(5 17.4 18.6)" />
        <use href="#mudd-f" />
        <ellipse cx="12" cy="10" rx="1.5" ry="1.15" fill="#f3b391" stroke="none" />
      </g>
      <ellipse cx="12" cy="20.3" rx="9.4" ry="1.4" fill="#2b1e16" />
    </svg>
  );
}

/** A small pastel square holding an icon or an initial, as on Clay's cards. */
export function Tile({ className, children, size = "md" }: { className?: string; children: ReactNode; size?: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? "h-6 w-6 rounded-md text-[11px]" : size === "lg" ? "h-10 w-10 rounded-xl text-base" : "h-8 w-8 rounded-lg text-sm";
  return <span className={cn("inline-flex shrink-0 items-center justify-center font-semibold", s, className)}>{children}</span>;
}
