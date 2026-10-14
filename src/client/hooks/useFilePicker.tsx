/**
 * Picking a file to import: the native Open dialog where there is one (it gives the file's path,
 * which Save file needs), a plain file input otherwise. Busy from the click until the file is
 * read, the dialog's time included, so a second click opens no second dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { DialogKind } from "../../shared/types";
import { api, type DialogResult } from "../lib/api";

export type PickedFile = File | { path: string };

// Whether this computer has a native Open dialog: asked once for the app, known by the first click.
let dialogs: boolean | null = null;
let asked = false;
function askDialogs() {
  if (asked) return;
  asked = true;
  api.env().then((e) => (dialogs = e.dialogs)).catch(() => (dialogs = false));
}

/**
 * `onPick` reads the file and reports its own errors. `start` opens the dialog (or the file
 * input); `take` reads a file from elsewhere, one dropped on the window, under the same busy.
 * Render `fileInput` once.
 */
export function useFilePicker(kind: DialogKind, extensions: readonly string[], onPick: (src: PickedFile) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  // Set at once, not on the next render, so a second click right after the first sees it.
  const holding = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(askDialogs, []);

  const hold = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    if (holding.current) return undefined;
    holding.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      holding.current = false;
      setBusy(false);
    }
  }, []);

  const take = useCallback((src: PickedFile) => hold(() => onPick(src)), [hold, onPick]);

  const start = useCallback(async () => {
    if (holding.current) return;
    // No dialog here: the file input, in the click itself, where the browser allows it.
    if (!dialogs) {
      input.current?.click();
      return;
    }
    const fallBack = await hold(async () => {
      let pick: DialogResult;
      try {
        pick = await api.openDialog(kind);
      } catch (err) {
        toast.error(`Could not open the file dialog: ${(err as Error).message}`);
        return true;
      }
      if ("path" in pick) await onPick({ path: pick.path });
      return "unsupported" in pick;
    });
    if (fallBack) input.current?.click();
  }, [hold, kind, onPick]);

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={extensions.join(",")}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void take(f);
      }}
    />
  );
  return { start, take, busy, fileInput };
}
