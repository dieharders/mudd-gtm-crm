/**
 * Remove a campaign from Mudd. Only Mudd's copy goes: the spreadsheet it came from or saves to
 * is never touched (nor are Mudd's backup copies of it), so importing that file again brings the
 * campaign back as it was last saved.
 */
import { Trash2 } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { api } from "../../lib/api";
import { useCampaignList } from "../../lib/campaignList";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { fire } from "../../lib/fire";

export interface Removable {
  id: string;
  name: string;
  sourceName: string | null;
  sourcePath: string | null;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function RemoveCampaignDialog({ campaign, onClose, beforeRemove, onRemoved }: {
  /** The campaign to remove; null keeps the dialog closed. */
  campaign: Removable | null;
  onClose: () => void;
  /** Runs first, such as sending edits still waiting, which would otherwise arrive after it's gone. */
  beforeRemove?: () => Promise<void>;
  onRemoved?: () => void;
}) {
  const { refresh } = useCampaignList();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      await beforeRemove?.();
      await api.deleteCampaign(campaign.id);
      toast.success(`Removed ${campaign.name} from the app`);
      onClose();
      onRemoved?.();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const file = campaign?.sourcePath ? baseName(campaign.sourcePath) : null;
  // Once started it can't be called back: closing would only hide a removal still going ahead.
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      open={!!campaign}
      onClose={close}
      title={`Remove ${campaign?.name ?? ""} from the app?`}
      subtitle="No file is deleted: only Mudd's copy of the campaign goes."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => fire(remove())}><Trash2 size={15} /> Remove from App</Button>
        </>
      }
    >
      <div className="space-y-2.5 text-[15px] text-mud-soft">
        {file ? (
          <p><strong className="text-mud">{file}</strong> stays where it is. Import it again any time to bring the campaign back as it was last saved.</p>
        ) : campaign?.sourceName ? (
          <p>The file it came from, <strong className="text-mud">{campaign.sourceName}</strong>, isn't touched.</p>
        ) : (
          <p className="font-semibold text-rose-700">It has never been saved to a file, so this removes it for good.</p>
        )}
        <p>Edits not yet saved with Save file go with it, as do its AI recipes and suggestions.</p>
      </div>
    </Modal>
  );
}
