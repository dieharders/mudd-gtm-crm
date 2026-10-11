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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-mud/35 p-6 pt-[8vh] animate-fade-in" onMouseDown={locked ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn("w-full rounded-2xl border-2 border-rim bg-paper shadow-hard-lg animate-pop", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b-2 border-rim/40 px-6 py-5">
          <div>
            <h2 className="font-display text-[22px] leading-tight font-bold text-mud">{title}</h2>
            {subtitle && <p className="mt-1 text-[15px] text-mud-soft">{subtitle}</p>}
          </div>
          <button
            className="-mr-1 rounded-lg border-2 border-transparent p-1.5 text-mud-faint transition hover:border-rim hover:bg-paper-deep hover:text-mud disabled:pointer-events-none disabled:opacity-40"
            onClick={onClose}
            disabled={locked}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-6 py-5 text-[15px]">{children}</div>
        {footer && <div className="flex justify-end gap-3 rounded-b-2xl border-t-2 border-rim/40 bg-paper-deep/40 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}
