/**
 * Save file: write the campaign back over the file it was imported from, with no dialog. When
 * Mudd does not know where that file is, it goes to Downloads, and later saves go there too.
 * Waits for pending edits first, so the file always has the latest change.
 */
import { ChevronDown, CloudUpload, Save } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import type { Campaign } from "../../../shared/types";
import { ApiError, api } from "../../lib/api";
import type { CampaignState } from "../../hooks/useCampaign";
import { Button } from "../ui/Button";
import { MenuItem, Popover } from "../ui/Menu";
import { Modal } from "../ui/Modal";

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function ExportMenu({ campaign, state }: { campaign: Campaign; state: CampaignState }) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const save = async (opts: { force?: boolean; copy?: boolean } = {}) => {
    setBusy(true);
    try {
      await state.flush();
      const r = await api.saveFile(campaign.id, opts);
      if (r.linked) state.setSource(r.path);
      if (opts.copy) toast.success(`Saved a copy: ${baseName(r.path)} in Downloads`);
      else if (r.path === campaign.sourcePath) toast.success(`Saved ${baseName(r.path)}`);
      else toast.success(`Saved ${baseName(r.path)} in Downloads. Save file keeps saving there.`, { duration: 6000 });
    } catch (err) {
      if (err instanceof ApiError && err.code === "changed") setConflict(err.message);
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
          onClick={() => void save()}
          title={linked ? `Save to ${linked}` : "Save the .xlsx to your Downloads folder"}
        >
          <Save size={15} /> {busy ? "Saving…" : "Save file"}
        </Button>
        <Popover align="right" trigger={({ toggle }) => (
          <Button variant="primary" className="rounded-l-none border-l-2 border-clay-deep px-2" onClick={toggle} disabled={busy} aria-label="More save options">
            <ChevronDown size={15} />
          </Button>
        )}>
          {(close) => (
            <>
              <MenuItem icon={<Save size={15} />} onClick={() => { close(); void save(); }} hint={linked ? baseName(linked) : "To Downloads"}>
                Save file
              </MenuItem>
              <MenuItem icon={<CloudUpload size={15} />} disabled onClick={() => {}} hint="SharePoint · coming soon">
                Save to cloud
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
            <Button onClick={() => { setConflict(null); void save({ copy: true }); }}>Save a copy to Downloads</Button>
            <Button variant="primary" onClick={() => { setConflict(null); void save({ force: true }); }}>Replace it</Button>
          </>
        }
      >
        <p className="text-sm text-mud-soft">Mudd writes your edits into the file as it was imported. Changes made to it in Excel since then would be replaced; the previous version is kept next to it as a <code>.bak.xlsx</code>.</p>
      </Modal>
    </>
  );
}
