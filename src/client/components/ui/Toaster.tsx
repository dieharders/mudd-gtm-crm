import { Check, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import toast, { ToastBar, Toaster, type Toast } from "react-hot-toast";
import { cn } from "../../lib/cn";

/** Marks an attention toast (see attentionToast): a blank toast with a look of its own. */
const ATTENTION = "toast-attention";

/**
 * Speech-bubble callouts: a light colored fill under a thick dark outline, with a pointer
 * underneath, and a bright pill on the top edge saying what kind of toast it is.
 * Yellow for info, mint for success, pink for errors, blue while loading, clay for a heads-up.
 */
const LOOK = {
  loading: { fill: "bg-lake-soft", pill: "bg-lake", label: "Loading", icon: <LoaderCircle size={15} strokeWidth={3} className="animate-spin" /> },
  blank: { fill: "bg-note", pill: "bg-sun text-mud!", label: "Info", icon: <Info size={15} strokeWidth={3} /> },
  success: { fill: "bg-note-mint", pill: "bg-leaf", label: "Success", icon: <Check size={15} strokeWidth={4} /> },
  error: { fill: "bg-note-pink", pill: "bg-rose", label: "Error", icon: <span className="text-[15px] font-black">!</span> },
  attention: { fill: "bg-note", pill: "bg-clay", label: "Heads up", icon: <TriangleAlert size={14} strokeWidth={3} /> },
} as const;

function Bubble({ t, icon, message }: { t: Toast; icon: React.ReactNode; message: React.ReactNode }) {
  const kind = t.className === ATTENTION ? "attention" : t.type;
  const look = kind in LOOK ? LOOK[kind as keyof typeof LOOK] : null;
  const fill = look?.fill ?? "bg-note";
  return (
    <div className={cn("relative max-w-md rounded-2xl border-[3px] border-mud px-4 py-3 font-sans text-[15px] leading-snug font-semibold text-mud shadow-dialog", fill, look && "mt-4 pt-5", t.visible ? "animate-toast-in" : "animate-toast-out")}>
      {look && (
        <span className={cn("absolute top-0 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border-[3px] border-mud px-3.5 py-0.5 text-[13px] font-extrabold tracking-wide whitespace-nowrap text-white uppercase", look.pill)}>
          {look.icon}
          {look.label}
        </span>
      )}
      {/* A line of text is centred under the pill; a caller's own layout (the release notes' list) is left as it is. */}
      <div className={cn("flex items-center justify-center gap-2", typeof t.message === "string" && "text-center")}>
        {/* The pill already shows the type's icon; info keeps a caller's own icon, like ⚠️. */}
        {(!look || kind === "blank") && icon}
        {message}
      </div>
      {/* The pointer: a square turned 45° so only its outlined bottom corner pokes out. */}
      <span className={cn("absolute -bottom-[10px] left-1/2 size-4 -translate-x-1/2 rotate-45 border-r-[3px] border-b-[3px] border-mud", fill)} />
    </div>
  );
}

export function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      gutter={22}
      toastOptions={{
        error: { duration: 6000 },      }}
    >
      {(t) => (
        // The library's own scale-from-top animation is switched off; Bubble flies in from below instead.
        <ToastBar toast={t} style={{ background: "none", boxShadow: "none", padding: 0, maxWidth: "none", animation: "none" }}>
          {({ icon, message }) => <Bubble t={t} icon={icon} message={message} />}
        </ToastBar>
      )}
    </Toaster>
  );
}

/** A button in a toast: it dismisses the toast, then does its thing. `quiet` for the one that only dismisses. */
function ToastButton({ t, onClick, quiet, children }: { t: Toast; onClick?: () => void; quiet?: boolean; children: ReactNode }) {
  return (
    <button
      className={cn(
        "rounded-lg border-2 px-2.5 py-0.5 text-[13px] font-extrabold whitespace-nowrap text-mud",
        quiet ? "border-transparent hover:border-mud/40" : "border-mud bg-paper hover:bg-paper-deep",
      )}
      onClick={() => {
        toast.dismiss(t.id);
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

/** A toast with an Undo button. */
export function undoToast(message: string, onUndo: () => void) {
  toast(
    (t) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <ToastButton t={t} onClick={onUndo}>Undo</ToastButton>
      </span>
    ),
    { duration: 5000 },
  );
}

/**
 * A heads-up before something with consequences: what will happen, a button to go ahead and one
 * to leave it. It waits a good while for an answer, and goes once one is given.
 */
export function attentionToast(message: ReactNode, action: { label: string; onClick: () => void }, id?: string) {
  toast(
    (t) => (
      <span className="flex flex-col items-center gap-2.5 text-center">
        <span>{message}</span>
        <span className="flex gap-2">
          <ToastButton t={t} onClick={action.onClick}>{action.label}</ToastButton>
          <ToastButton t={t} quiet>Not now</ToastButton>
        </span>
      </span>
    ),
    { id, className: ATTENTION, duration: 15_000 },
  );
}

export type SaveState = "saving" | "saved" | "error";

/**
 * The quiet note in the lower corner as a campaign saves: "Saving…", then "Saved" for a moment.
 * "Not saved" stays, while `sticky`, until a later write goes through; the error itself has its
 * own toast. One note per `id`, each call replacing the last.
 */
export function saveNote(state: SaveState, id: string, sticky = true) {
  toast.custom((t) => <SaveNote t={t} state={state} />, {
    id,
    position: "bottom-right",
    duration: state === "saved" ? 1200 : state === "error" && !sticky ? 6000 : Infinity,
  });
}

function SaveNote({ t, state }: { t: Toast; state: SaveState }) {
  return (
    // Faint, and clicked through: it is only there to be glanced at.
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none! inline-flex items-center gap-1.5 rounded-lg bg-paper/80 px-2.5 py-1 font-label text-[12px]",
        state === "error" ? "text-rose-600" : "text-mud-faint",
        t.visible ? "animate-fade-in" : "animate-fade-out",
      )}
    >
      {state === "saving" ? <LoaderCircle size={11} className="animate-spin" /> : state === "saved" ? <Check size={11} /> : <TriangleAlert size={11} />}
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Not saved"}
    </span>
  );
}
