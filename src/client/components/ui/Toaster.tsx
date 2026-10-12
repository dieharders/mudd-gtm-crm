import { Check, Info, LoaderCircle } from "lucide-react";
import toast, { ToastBar, Toaster, type Toast } from "react-hot-toast";
import { cn } from "../../lib/cn";

/**
 * Speech-bubble callouts: a light colored fill under a thick dark outline, with a pointer
 * underneath, and a bright pill on the top edge saying what kind of toast it is.
 * Yellow for info, mint for success, pink for errors, blue while loading.
 */
const LOOK = {
  loading: { fill: "bg-lake-soft", pill: "bg-lake", label: "Loading", icon: <LoaderCircle size={15} strokeWidth={3} className="animate-spin" /> },
  blank: { fill: "bg-note", pill: "bg-sun text-mud!", label: "Info", icon: <Info size={15} strokeWidth={3} /> },
  success: { fill: "bg-note-mint", pill: "bg-leaf", label: "Success", icon: <Check size={15} strokeWidth={4} /> },
  error: { fill: "bg-note-pink", pill: "bg-rose", label: "Error", icon: <span className="text-[15px] font-black">!</span> },
} as const;

function Bubble({ t, icon, message }: { t: Toast; icon: React.ReactNode; message: React.ReactNode }) {
  const look = t.type in LOOK ? LOOK[t.type as keyof typeof LOOK] : null;
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
        {(!look || t.type === "blank") && icon}
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

/** A toast with an Undo button. */
export function undoToast(message: string, onUndo: () => void) {
  toast(
    (t) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <button
          className="rounded-lg border-2 border-mud bg-paper px-2.5 py-0.5 text-[13px] font-extrabold text-mud hover:bg-paper-deep"
          onClick={() => {
            toast.dismiss(t.id);
            onUndo();
          }}
        >
          Undo
        </button>
      </span>
    ),
    { duration: 5000 },
  );
}
