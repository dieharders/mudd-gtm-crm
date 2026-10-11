/** A panel header's AI status: which provider is signed in (and on which plan), or that none is. Opens AI settings. */
import { PROVIDERS } from "../../../shared/ai";
import { useActiveProvider, useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";

export function AiStatusTag() {
  const ai = useAi();
  const { status, ready } = useActiveProvider();
  const label = `${ai.settings?.provider ? PROVIDERS[ai.settings.provider].label : "No AI provider chosen"}${status?.auth.plan ? ` · ${status.auth.plan}` : ""}`;
  return (
    <button onClick={() => ai.setOpen(true)} className={cn("tag h-8 shrink-0 px-2.5 font-bold", ready ? "bg-note-mint text-mud" : "bg-note text-mud")}>
      <span className={cn("h-2 w-2 rounded-full border border-rim", ready ? "bg-emerald-400" : "bg-clay")} /> {label}
    </button>
  );
}
