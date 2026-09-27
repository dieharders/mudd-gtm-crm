import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-clay-600 text-white shadow-xs hover:bg-clay-700 active:bg-clay-800 disabled:bg-clay-300",
  secondary: "border border-line bg-white text-ink shadow-xs hover:border-line-strong hover:bg-stone-50 disabled:text-ink-faint",
  ghost: "text-ink-soft hover:bg-stone-100 hover:text-ink disabled:text-ink-faint",
  subtle: "bg-clay-50 text-clay-700 hover:bg-clay-100",
  danger: "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50",
};
const SIZES: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
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
        "inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-colors select-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
