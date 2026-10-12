import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
/** `xs` is for actions inside a list row or next to a line of small text; `icon` is a square. */
type Size = "xs" | "sm" | "md" | "icon";

// Paper buttons (styles.css): a rimmed card on a ledge that presses down. Ghost has no card, only a
// rim that appears on hover, so it is the same size as the others and lines up beside them.
// Disabled ones still take the pointer, for their title: each hover tint is undone while disabled.
const VARIANTS: Record<Variant, string> = {
  primary: "btn btn-primary",
  secondary: "btn",
  subtle: "btn text-clay-deep hover:bg-clay-soft disabled:hover:bg-paper",
  danger: "btn text-rose-700 hover:bg-note-pink disabled:hover:bg-paper",
  ghost:
    "inline-flex h-11 shrink-0 items-center justify-center gap-2.5 rounded-xl border-2 border-transparent px-4 font-sans text-[15px] font-bold whitespace-nowrap text-mud-soft transition select-none hover:bg-paper-deep hover:text-mud disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-mud-soft",
};
const SIZES: Record<Size, string> = {
  xs: "h-7 gap-1.5 rounded-md px-2.5 text-[12px]",
  sm: "h-9 gap-2 rounded-lg px-3.5 text-[13px]",
  md: "",
  icon: "h-11 w-11 justify-center px-0",
};

function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string): string {
  // A ghost icon button is a plain glyph until hovered, when its rim shows it is a control.
  return cn(VARIANTS[variant], SIZES[size], variant === "ghost" && size === "icon" && "text-mud-faint hover:border-rim disabled:hover:border-transparent disabled:hover:text-mud-faint", className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
});
