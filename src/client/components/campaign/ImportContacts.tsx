/**
 * Import contacts: pick a contacts CSV (as Export contacts as CSV writes one) and add its people
 * to the campaign's prospects, by Prospect ID or Company. The native Open dialog where there is
 * one, a plain file input otherwise. One undo step takes them all out again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { CampaignState } from "../../hooks/useCampaign";
import { api } from "../../lib/api";

const CSV_EXTENSIONS = ".csv,.tsv,.txt";
const people = (n: number) => `${n} contact${n === 1 ? "" : "s"}`;

export function useImportContacts(state: CampaignState) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialogs = useRef<boolean | null>(null);

  useEffect(() => {
    api.env().then((e) => (dialogs.current = e.dialogs)).catch(() => (dialogs.current = false));
  }, []);

  const run = useCallback(async (src: File | { path: string }) => {
    setBusy(true);
    try {
      const r = await state.importContacts(src);
      if (r.ids.length) toast.success(`Imported ${people(r.ids.length)} from ${r.fileName}`);
      else toast(`No new contacts in ${r.fileName}`, { icon: "ℹ️" });
      if (r.duplicates) toast(`${people(r.duplicates)} already there, so not added again.`, { icon: "ℹ️", duration: 6000 });
      if (r.skipped) toast(`${people(r.skipped)} matched no prospect by Prospect ID or Company, and ${r.skipped === 1 ? "wasn't" : "weren't"} added.`, { icon: "⚠️", duration: 8000 });
      if (r.mismatched) toast(`${people(r.mismatched)} linked by Prospect ID name a different Company than that prospect. Check them.`, { icon: "⚠️", duration: 10_000 });
    } catch (err) {
      toast.error((err as Error).message, { duration: 8000 });
    } finally {
      setBusy(false);
    }
  }, [state]);

  const start = useCallback(async () => {
    if (busy) return;
    if (dialogs.current) {
      try {
        const pick = await api.openDialog();
        if ("path" in pick) {
          await run({ path: pick.path });
          return;
        }
        if ("cancelled" in pick) return;
      } catch (err) {
        toast.error(`Could not open the file dialog: ${(err as Error).message}`);
      }
    }
    input.current?.click();
  }, [busy, run]);

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={CSV_EXTENSIONS}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void run(f);
      }}
    />
  );
  return { start, busy, fileInput };
}
