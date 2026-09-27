/** A small popover menu anchored to its trigger. Closes on outside click and Escape. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Popover({
  trigger, children, align = "left", className, open: controlled, onOpenChange,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (v: boolean) => {
    if (controlled === undefined) setOwn(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  });
  const close = () => setOpen(false);
  return (
    <div className="relative inline-flex" ref={ref}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          className={cn(
            "absolute top-full z-40 mt-1.5 min-w-52 rounded-xl border border-line bg-panel p-1 shadow-xl shadow-zinc-900/10 animate-pop",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon, children, onClick, danger, disabled, hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm",
        danger ? "text-rose-700 hover:bg-rose-50" : "text-ink hover:bg-zinc-100",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      {icon && <span className={cn("shrink-0", danger ? "text-rose-500" : "text-ink-faint")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        {children}
        {hint && <span className="block truncate text-xs text-ink-faint">{hint}</span>}
      </span>
    </button>
  );
}

export const MenuSeparator = () => <div className="my-1 h-px bg-line" />;
