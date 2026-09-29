import { Check, Copy, LayoutList } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import type { CampaignSummary } from "../../../shared/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { fire } from "../../lib/fire";

const GENERIC = ["Name", "Company", "Title", "Email", "LinkedIn", "Phone", "Location", "Website", "Status", "Next step", "Next date", "Meeting URL", "Meeting at", "Notes", "Source", "Intro message", "Screened out", "Screened reason"];

export function NewCampaignDialog({ open, onClose, campaigns }: { open: boolean; onClose: () => void; campaigns: CampaignSummary[] }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [layout, setLayout] = useState<"generic" | "copy">("generic");
  const [copyFrom, setCopyFrom] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setLayout("generic");
      setCopyFrom(campaigns[0]?.id ?? "");
    }
  }, [open, campaigns]);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const c = await api.createCampaign(name, layout === "copy" && copyFrom ? { copyFrom } : "generic");
      onClose();
      void navigate(`/c/${c.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      subtitle="One list of prospects. Screening one out keeps it in the list, greyed out, until you restore it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => fire(submit())} disabled={!name.trim() || saving || (layout === "copy" && !copyFrom)}>
            {saving ? "Creating…" : "Create campaign"}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label className="label" htmlFor="nc-name">Name</label>
          <input id="nc-name" autoFocus className="field" placeholder="e.g. Q4 accelerators" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <span className="label">Starting columns</span>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice active={layout === "generic"} onClick={() => setLayout("generic")} icon={<LayoutList size={16} />} title="Generic prospect list" desc="Name, company, contact details, status, meeting and intro message." />
            <Choice active={layout === "copy"} onClick={() => setLayout("copy")} disabled={!campaigns.length} icon={<Copy size={16} />} title="Copy another campaign" desc={campaigns.length ? "Same columns and dropdowns, no rows." : "No campaigns to copy yet."} />
          </div>
        </div>
        {layout === "generic" ? (
          <div className="flex flex-wrap gap-1.5">
            {GENERIC.map((h) => <span key={h} className="rounded-md border border-line bg-zinc-50 px-1.5 py-0.5 text-xs text-ink-soft">{h}</span>)}
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="nc-copy">Copy columns from</label>
            <select id="nc-copy" className="field" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <p className="text-xs text-ink-faint">You can add, rename and retype columns at any time. Exports use the same look as your tracker sheets.</p>
      </form>
    </Modal>
  );
}

function Choice({ active, onClick, icon, title, desc, disabled }: { active: boolean; onClick: () => void; icon: ReactNode; title: string; desc: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative rounded-xl border p-3 text-left transition",
        active ? "border-brand-400 bg-brand-50 ring-2 ring-brand-100" : "border-line hover:border-line-strong",
        disabled && "opacity-50",
      )}
    >
      {active && <Check size={14} className="absolute top-3 right-3 text-brand-600" />}
      <div className="flex items-center gap-2 text-sm font-medium"><span className="text-brand-500">{icon}</span>{title}</div>
      <p className="mt-1 text-xs text-ink-soft">{desc}</p>
    </button>
  );
}
