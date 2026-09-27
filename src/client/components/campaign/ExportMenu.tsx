/**
 * Export: Save back to the linked file, Save as…, or Download a copy.
 * Waits for pending edits first, so the file always has the latest change.
 */
import { ChevronDown, Download, FileDown, Save } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import type { Campaign } from "../../../shared/types";
import { ApiError, api } from "../../lib/api";
import type { CampaignState } from "../../hooks/useCampaign";
import { Button } from "../ui/Button";
import { MenuItem, MenuSeparator, Popover } from "../ui/Menu";
import { Modal } from "../ui/Modal";

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function ExportMenu({ campaign, state }: { campaign: Campaign; state: CampaignState }) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const download = async () => {
    const { blob, name } = await api.exportDownload(campaign.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.success(`Downloaded ${name}`);
  };

  const run = async (target: "original" | "saveAs" | "download", force = false) => {
    setBusy(true);
    try {
      await state.flush();
      if (target === "download") return await download();
      const r = await api.exportTo(campaign.id, target, force);
      if (r.cancelled) return;
      if (r.path) {
        state.setSource(r.path);
        toast.success(r.linked ? `Saved and linked ${baseName(r.path)} — next time just Save` : `Saved ${baseName(r.path)}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "changed") setConflict(err.message);
      else if (err instanceof ApiError && err.code === "unsupported") await download();
      else toast.error((err as Error).message, { duration: 8000 });
    } finally {
      setBusy(false);
    }
  };

  const linked = campaign.sourcePath;
  return (
    <>
      <div className="flex">
        <Button
          variant="primary"
          className="rounded-r-none"
          disabled={busy}
          onClick={() => run(linked ? "original" : "saveAs")}
          title={linked ? `Save to ${linked}` : "Choose where to save the .xlsx"}
        >
          <Save size={15} /> {busy ? "Saving…" : linked ? "Save to file" : "Export .xlsx"}
        </Button>
        <Popover align="right" trigger={({ toggle }) => (
          <Button variant="primary" className="rounded-l-none border-l border-clay-700 px-2" onClick={toggle} disabled={busy} aria-label="More export options">
            <ChevronDown size={15} />
          </Button>
        )}>
          {(close) => (
            <>
              <MenuItem icon={<Save size={15} />} disabled={!linked} onClick={() => { close(); void run("original"); }} hint={linked ? baseName(linked) : "Not linked to a file yet"}>
                Save to linked file
              </MenuItem>
              <MenuItem icon={<FileDown size={15} />} onClick={() => { close(); void run("saveAs"); }} hint="Choose a location">
                Save as…
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Download size={15} />} onClick={() => { close(); void run("download"); }} hint="To your Downloads folder">
                Download a copy
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
      <Modal
        open={!!conflict}
        onClose={() => setConflict(null)}
        title="The file changed outside Mudd"
        subtitle={conflict}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConflict(null)}>Cancel</Button>
            <Button onClick={() => { setConflict(null); void run("saveAs"); }}>Save as a new file</Button>
            <Button variant="primary" onClick={() => { setConflict(null); void run("original", true); }}>Replace it</Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">Mudd rebuilds the file from what it imported plus your edits here. Edits made to the file in Excel since then would be replaced; the previous version is kept next to it as a <code>.bak.xlsx</code>.</p>
      </Modal>
    </>
  );
}
