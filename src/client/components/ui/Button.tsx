import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon";

// Buttons sit on a 1px "ledge" (the bottom shadow) and press down into it: a little tactile.
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-500 text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.18),0_1px_2px_rgba(103,68,245,0.3)] hover:bg-brand-600 active:translate-y-px active:shadow-none disabled:bg-brand-300 disabled:shadow-none",
  secondary:
    "border border-line-strong bg-white text-ink shadow-[0_1px_0_rgba(23,22,29,0.06)] hover:border-zinc-400/60 hover:bg-zinc-50 active:translate-y-px active:shadow-none disabled:text-ink-faint",
  ghost: "text-ink-soft hover:bg-zinc-900/5 hover:text-ink disabled:text-ink-faint",
  subtle: "bg-brand-100 text-brand-800 hover:bg-brand-200",
  danger: "border border-rose-200 bg-white text-rose-700 shadow-[0_1px_0_rgba(23,22,29,0.06)] hover:bg-rose-50",
};
const SIZES: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-2 rounded-lg px-3.5 text-sm",
  icon: "h-8 w-8 justify-center rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center font-medium whitespace-nowrap transition select-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
