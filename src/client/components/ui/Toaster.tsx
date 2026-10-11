import toast, { Toaster } from "react-hot-toast";

export function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      toastOptions={{
        className: "bg-mud! text-paper! font-ui! text-[15px]! leading-snug! rounded-xl! border-2! border-rim! px-4! py-3! max-w-md! shadow-hard!",
        success: { iconTheme: { primary: "#6fd392", secondary: "#2b1e16" } },
        error: { iconTheme: { primary: "#ff8a8a", secondary: "#2b1e16" }, duration: 6000 },
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
          className="rounded-md bg-paper/15 px-2.5 py-1 text-[13px] font-bold text-paper hover:bg-paper/25"
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
