import { Check, Copy, LayoutList, Radar } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { genericSchema } from "../../../shared/schema";
import { thesisQuestion } from "../../../shared/thesis";
import type { CampaignSummary } from "../../../shared/types";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { fire } from "../../lib/fire";

// What genericSchema() makes, read from it: the company's columns (not the hidden ID), and each
// of its contacts'.
const GENERIC = (() => {
  const s = genericSchema();
  return {
    Prospect: s.columns.filter((c) => !c.hidden).map((c) => c.header),
    Contacts: (s.contacts?.columns ?? []).map((c) => c.header),
  };
})();

type Layout = "generic" | "copy" | "discovery";
const OFFER = thesisQuestion("offer");
const AVATAR = thesisQuestion("avatar");

export function NewCampaignDialog({ open, onClose, campaigns }: { open: boolean; onClose: () => void; campaigns: CampaignSummary[] }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [layout, setLayout] = useState<Layout>("generic");
  const [copyFrom, setCopyFrom] = useState("");
  const [offer, setOffer] = useState("");
  const [avatar, setAvatar] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setLayout("generic");
      setCopyFrom(campaigns[0]?.id ?? "");
      setOffer("");
      setAvatar("");
    }
  }, [open, campaigns]);

  const discover = layout === "discovery";
  const ready = !!name.trim() && !saving && (layout !== "copy" || !!copyFrom) && (!discover || (!!offer.trim() && !!avatar.trim()));

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const c = discover
        ? await api.createCampaign(name, "discovery", { offer: offer.trim(), avatar: avatar.trim() })
        : await api.createCampaign(name, layout === "copy" && copyFrom ? { copyFrom } : "generic");
      onClose();
      // A Discovery campaign opens on its thesis, so the rest of the questions can be answered.
      void navigate(discover ? `/c/${c.id}?discover=thesis` : `/c/${c.id}`);
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
      subtitle="One list of prospects, each with its contacts. Screening one out keeps it in the list, greyed out, until you restore it."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => fire(submit())} disabled={!ready}>
            {saving ? "Creating…" : discover ? "Create & continue" : "Create campaign"}
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
          <span className="label">Start from</span>
          <div className="grid gap-3 sm:grid-cols-3">
            <Choice active={layout === "generic"} onClick={() => setLayout("generic")} icon={<LayoutList size={16} />} title="Start from scratch" desc="Companies with their contacts, status, meeting and intro message." />
            <Choice active={layout === "copy"} onClick={() => setLayout("copy")} disabled={!campaigns.length} icon={<Copy size={16} />} title="Copy columns" desc={campaigns.length ? "Another campaign's columns and dropdowns, no rows." : "No campaigns to copy yet."} />
            <Choice active={discover} onClick={() => setLayout("discovery")} icon={<Radar size={16} />} title="Discover prospects" desc="AI finds companies that fit your ideal customer, and who to talk to at each." />
          </div>
        </div>
        {layout === "generic" && (
          <div className="space-y-2.5">
            {Object.entries(GENERIC).map(([list, headers]) => (
              <div key={list} className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 font-label text-[13px] font-bold text-mud-faint">{list}</span>
                {headers.map((h) => <span key={h} className="rounded-md border border-rim/60 bg-paper-deep/60 px-2 py-0.5 font-label text-[13px] text-mud-soft">{h}</span>)}
              </div>
            ))}
          </div>
        )}
        {layout === "copy" && (
          <div>
            <label className="label" htmlFor="nc-copy">Copy columns from</label>
            <select id="nc-copy" className="field" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {discover && (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="nc-offer">{OFFER.label}</label>
              <textarea id="nc-offer" rows={2} className="field resize-y leading-relaxed" placeholder={OFFER.example} value={offer} onChange={(e) => setOffer(e.target.value)} />
              <p className="mt-1.5 text-[13px] text-mud-faint">{OFFER.help}</p>
            </div>
            <div>
              <label className="label" htmlFor="nc-avatar">{AVATAR.label}</label>
              <textarea id="nc-avatar" rows={3} className="field resize-y leading-relaxed" placeholder={AVATAR.example} value={avatar} onChange={(e) => setAvatar(e.target.value)} />
              <p className="mt-1.5 text-[13px] text-mud-faint">{AVATAR.help}</p>
            </div>
            <p className="text-[13px] text-mud-faint">The rest of the thesis comes next, with the AI able to draft what you leave blank. Nothing is sent anywhere until you run Find.</p>
          </div>
        )}
        {!discover && <p className="text-[13px] text-mud-faint">You can add, rename and retype columns at any time. Exports use the same look as your tracker sheets.</p>}
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
        "relative rounded-xl border-2 p-4 text-left transition",
        active ? "border-clay bg-clay-soft shadow-hard-sm-clay" : "border-rim/50 bg-paper hover:border-rim hover:bg-paper-deep",
        disabled && "opacity-50",
      )}
    >
      {active && <Check size={16} strokeWidth={3} className="absolute top-3 right-3 text-clay-deep" />}
      <div className="flex items-center gap-2.5 pr-5 text-[15px] font-extrabold"><span className="text-clay-deep">{icon}</span>{title}</div>
      <p className="mt-1.5 text-[13px] leading-snug text-mud-soft">{desc}</p>
    </button>
  );
}
