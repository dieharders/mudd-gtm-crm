import { Ban } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Popover } from "../ui/Menu";

export function ScreenOutButton({ count, onConfirm, align = "left" }: { count: number; onConfirm: (reason: string) => void; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Popover align={align} open={open} onOpenChange={(v) => { setOpen(v); if (!v) setReason(""); }} className="w-80 p-3" trigger={({ toggle }) => (
      <Button size="sm" onClick={toggle}><Ban size={13} /> Screen out</Button>
    )}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(reason); setOpen(false); setReason(""); }}>
        <label className="label" htmlFor="so-reason">Why {count === 1 ? "does this prospect" : `do these ${count}`} fail the filter?</label>
        <textarea id="so-reason" autoFocus rows={3} className="field text-xs" placeholder="Optional — e.g. has an in-house creative team" value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit(); }} />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" type="submit">Screen out</Button>
        </div>
      </form>
    </Popover>
  );
}
