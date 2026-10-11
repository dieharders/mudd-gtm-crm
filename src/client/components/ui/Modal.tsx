import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/** `locked` holds the dialog open (Escape, the backdrop and × do nothing) while work in it must not be cut short. */
export function Modal({
  open, onClose, title, subtitle, children, footer, width = "max-w-lg", locked = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  locked?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!locked) onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, locked]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/30 p-6 pt-[10vh] animate-fade-in" onMouseDown={locked ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn("w-full rounded-2xl border border-line bg-panel shadow-2xl shadow-zinc-900/10 animate-pop", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
          </div>
          <button className="-mr-1 rounded-md p-1 text-ink-faint hover:bg-zinc-100 hover:text-ink disabled:pointer-events-none disabled:opacity-40" onClick={onClose} disabled={locked} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-zinc-50/60 px-5 py-3 rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}
