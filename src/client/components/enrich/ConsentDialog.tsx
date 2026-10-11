/** Asked once, before the first run: rows leave this computer only after the user says so. */
import { ShieldCheck } from "lucide-react";
import { PROVIDERS } from "../../../shared/ai";
import { useAi } from "../../lib/aiStatus";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export function ConsentDialog({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { settings } = useAi();
  // A run can't start without a provider; the server says so if one is tried.
  if (!settings?.provider) return null;
  const p = PROVIDERS[settings.provider];
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Send prospect data to your AI?"
      subtitle={`Enrichment runs on your ${p.label} sign-in (${p.vendor}).`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Not now</Button>
          <Button variant="primary" onClick={onConfirm}><ShieldCheck size={15} /> Allow and run</Button>
        </>
      }
    >
      <ul className="space-y-2 text-sm text-ink-soft">
        <li>• For each row you run, the columns the recipe uses are sent to {p.vendor} through your {p.label} CLI, and it may search the web about that prospect.</li>
        <li>• Discovery sends your ICP thesis and the names of the companies already in the campaign, and searches the web for companies and people that fit.</li>
        <li>• Research turns can only search and read web pages. They can't run commands or open your files.</li>
        <li>• Results come back as suggestions. Your sheet only changes when you accept one, or for empty cells if you turned on auto-fill.</li>
        <li>• Usage counts toward your {p.plan} plan's limits.</li>
      </ul>
      <p className="mt-3 text-xs text-ink-faint">Mudd asks once. You can see what's in use any time under AI settings in the sidebar.</p>
    </Modal>
  );
}
