import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon";

// Paper buttons (styles.css): a rimmed card on a ledge that presses down. Ghost has no card at all.
const VARIANTS: Record<Variant, string> = {
  primary: "paper-btn paper-btn-primary",
  secondary: "paper-btn",
  subtle: "paper-btn bg-clay-soft text-clay-deep hover:bg-clay-soft/60",
  danger: "paper-btn text-rose-700 hover:bg-note-pink",
  ghost:
    "inline-flex h-11 shrink-0 items-center justify-center gap-2.5 rounded-xl px-4 font-ui text-[15px] font-bold whitespace-nowrap text-mud-soft transition select-none hover:bg-paper-deep hover:text-mud disabled:pointer-events-none disabled:opacity-50",
};
const SIZES: Record<Size, string> = {
  sm: "h-9 gap-2 rounded-lg px-3.5 text-[13px]",
  md: "",
  icon: "h-11 w-11 justify-center px-0",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cn(VARIANTS[variant], SIZES[size], className)} {...rest} />;
});
