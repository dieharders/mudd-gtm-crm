/**
 * Import contacts: pick a contacts CSV (as Export contacts as CSV writes one) and add its people
 * to the campaign's prospects, by Prospect ID or Company. The native Open dialog where there is
 * one, a plain file input otherwise. One undo step takes them all out again.
 */
import { useCallback } from "react";
import toast from "react-hot-toast";
import { CONTACTS_EXTENSIONS } from "../../../shared/types";
import type { CampaignState } from "../../hooks/useCampaign";
import { useFilePicker, type PickedFile } from "../../hooks/useFilePicker";

const people = (n: number) => `${n} contact${n === 1 ? "" : "s"}`;

export function useImportContacts(state: CampaignState) {
  const { importContacts } = state;
  const run = useCallback(async (src: PickedFile) => {
    try {
      const r = await importContacts(src);
      if (r.contacts.length) toast.success(`Imported ${people(r.contacts.length)} from ${r.fileName}`);
      else toast(`No new contacts in ${r.fileName}`, { icon: "ℹ️" });
      if (r.duplicates) toast(`${people(r.duplicates)} already there, so not added again.`, { icon: "ℹ️", duration: 6000 });
      if (r.skipped) toast(`${people(r.skipped)} matched no prospect by Prospect ID or Company, and ${r.skipped === 1 ? "wasn't" : "weren't"} added.`, { icon: "⚠️", duration: 8000 });
      if (r.mismatched) toast(`${people(r.mismatched)} linked by Prospect ID name a Company that isn't that prospect's. Check them.`, { icon: "⚠️", duration: 10_000 });
    } catch (err) {
      toast.error((err as Error).message, { duration: 8000 });
    }
  }, [importContacts]);

  return useFilePicker("contacts", CONTACTS_EXTENSIONS, run);
}
