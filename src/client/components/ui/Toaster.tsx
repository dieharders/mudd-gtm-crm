import toast, { Toaster } from "react-hot-toast";

export function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      toastOptions={{
        className: "bg-zinc-900! text-zinc-100! text-sm! leading-snug! rounded-xl! px-3.5! py-2.5! max-w-md! shadow-2xl!",
        success: { iconTheme: { primary: "#34d399", secondary: "#1c1917" } },
        error: { iconTheme: { primary: "#fb7185", secondary: "#1c1917" }, duration: 6000 },
      }}
    />
  );
}

/** A toast with an Undo button. */
export function undoToast(message: string, onUndo: () => void) {
  toast(
    (t) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <button
          className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold text-white hover:bg-white/20"
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
