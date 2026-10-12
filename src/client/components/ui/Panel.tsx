import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/**
 * A large centred dialog for the campaign's workspaces (Discover, Enrich, Review, Templates):
 * a paper card over a dimmed board, with a header row and a body the caller lays out
 * (usually a rail and a main column). Closes on the backdrop; nested dialogs stop the click.
 * Escape closes it too, except from a field, where it belongs to the field; a Modal open on top
 * takes the key first and stops it.
 */
export function Panel({ title, subtitle, icon, actions, onClose, closeLabel = "Close", width = "max-w-[1080px]", children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Extra header controls, left of the close button. */
  actions?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  /** A max-width class; the panel is as wide as the window allows below it. */
  width?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, select") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-mud/35 p-4 animate-fade-in md:p-8" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn("flex h-full max-h-[920px] w-full flex-col overflow-hidden rounded-2xl border-2 border-rim-deep bg-paper shadow-dialog animate-pop", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 border-b-2 border-rim/40 px-6 py-4">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[22px] leading-tight font-bold text-mud">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-[14px] text-mud-soft">{subtitle}</p>}
          </div>
          {actions}
          <Button size="icon" variant="ghost" onClick={onClose} aria-label={closeLabel}><X size={20} /></Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A left-rail entry in a Panel: icon, label with an optional count, and a hint line. */
export const railItem = (active: boolean) =>
  cn("flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition", active ? "border-rim bg-paper text-mud shadow-hard-sm" : "border-transparent hover:bg-paper-deep");
