/**
 * AI settings: which CLI Mudd drives, whether it is installed and signed in, which plan it
 * bills, and the model and effort used for research.
 */
import { Check, ClipboardCopy, ExternalLink, Loader2, LogIn, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { PROVIDERS, PROVIDER_IDS, type ProviderId, type ProviderStatus } from "../../../shared/ai";
import { api } from "../../lib/api";
import { useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Tile } from "../ui/Logo";
import { Modal } from "../ui/Modal";

const TILES: Record<ProviderId, string> = { claude: "bg-orange-100 text-orange-700", codex: "bg-zinc-800 text-white" };
const GLYPH: Record<ProviderId, string> = { claude: "✳", codex: "◎" };

export function AiSettingsDialog() {
  const ai = useAi();
  const [checking, setChecking] = useState(false);
  const s = ai.settings;
  if (!s) return null;

  const check = async () => {
    setChecking(true);
    await ai.refresh(true).catch(() => {});
    setChecking(false);
  };

  return (
    <Modal
      open={ai.open}
      onClose={() => ai.setOpen(false)}
      width="max-w-2xl"
      title="AI settings"
      subtitle="Mudd runs research on your own Claude Code or Codex sign-in, so it bills your plan. No API keys are stored here."
      footer={
        <>
          <Button variant="ghost" onClick={check} disabled={checking}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check again
          </Button>
          <Button variant="primary" onClick={() => ai.setOpen(false)}>Done</Button>
        </>
      }
    >
      <div className="space-y-3">
        {PROVIDER_IDS.map((id) => (
          <ProviderCard key={id} id={id} status={ai.providers.find((p) => p.id === id)} active={s.provider === id} onPick={() => ai.update({ provider: id })} onRefresh={check} />
        ))}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="ai-model">Model for {PROVIDERS[s.provider].label}</label>
          {s.provider === "codex" ? (
            <input id="ai-model" className="field" defaultValue={s.model.codex} placeholder="default"
              onBlur={(e) => ai.update({ model: { ...s.model, codex: e.target.value.trim() || "default" } })} />
          ) : (
            <select id="ai-model" className="field" value={s.model.claude} onChange={(e) => ai.update({ model: { ...s.model, claude: e.target.value } })}>
              {PROVIDERS.claude.models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          )}
        </div>
        <div>
          <label className="label" htmlFor="ai-effort">Effort</label>
          <select id="ai-effort" className="field" value={s.effort[s.provider]} onChange={(e) => ai.update({ effort: { ...s.effort, [s.provider]: e.target.value } })}>
            {PROVIDERS[s.provider].efforts.map((e) => <option key={e} value={e}>{e === "low" ? "Low (fast, recommended)" : e === "medium" ? "Medium" : "High (thorough, slower)"}</option>)}
          </select>
        </div>
      </div>

      {s.provider === "claude" && (
        <label className="mt-4 flex items-start gap-2.5 rounded-xl bg-zinc-50 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-500" checked={s.credentialMode === "subscription"}
            onChange={(e) => ai.update({ credentialMode: e.target.checked ? "subscription" : "auto" }).then(() => ai.refresh())} />
          <span>
            <span className="font-medium">Bill my Claude subscription only</span>
            <span className="block text-xs text-ink-soft">Ignores an ANTHROPIC_API_KEY in your environment so research never switches to per-token billing. Turned off automatically if that key is your only sign-in.</span>
          </span>
        </label>
      )}

      <p className="mt-4 flex items-start gap-2 text-xs text-ink-soft">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-600" />
        Nothing is sent anywhere until you press Run. Then the columns you choose, for the rows you choose, go to {PROVIDERS[s.provider].vendor} through your CLI, which may search the web. Research turns can't run commands or touch your files.
      </p>
    </Modal>
  );
}

function ProviderCard({ id, status, active, onPick, onRefresh }: { id: ProviderId; status?: ProviderStatus; active: boolean; onPick: () => void; onRefresh: () => void }) {
  const info = PROVIDERS[id];
  const [signingIn, setSigningIn] = useState(false);
  const auth = status?.auth;
  const signIn = async () => {
    setSigningIn(true);
    const r = await api.aiSignIn(id).catch((e) => ({ ok: false, message: (e as Error).message }));
    setSigningIn(false);
    if (r.ok) toast.success("A terminal opened with the sign-in. Finish it there, then press Check again.", { duration: 7000 });
    else toast.error(r.message ?? "Couldn't start the sign-in.");
  };
  const copyInstall = () => navigator.clipboard.writeText(info.install).then(() => toast.success("Install command copied"), () => toast.error("Couldn't copy"));

  return (
    <div className={cn("rounded-2xl border p-4 transition", active ? "border-brand-300 bg-brand-50/50 shadow-[0_0_0_3px_var(--color-brand-100)]" : "border-line bg-white")}>
      <div className="flex items-start gap-3">
        <Tile size="lg" className={TILES[id]}>{GLYPH[id]}</Tile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{info.label}</h3>
            <span className="text-xs text-ink-faint">{info.vendor} · {info.plan}</span>
          </div>
          {!status ? (
            <p className="mt-1 text-xs text-ink-faint"><Loader2 size={12} className="inline animate-spin" /> Checking…</p>
          ) : !status.installed ? (
            <div className="mt-1.5 text-xs">
              <p className="text-ink-soft">{status.outdated ? `Version ${status.outdated} is too old. Update it:` : "Not installed. Install it, then sign in:"}</p>
              <button onClick={copyInstall} className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 font-mono text-[11.5px] text-zinc-100 hover:bg-zinc-800" title="Copy">
                {info.install} <ClipboardCopy size={11} />
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="tag bg-zinc-100 text-zinc-600">v{status.version ?? "?"}</span>
              {auth?.state === "ok" ? (
                <>
                  <span className="tag bg-emerald-100 text-emerald-800"><Check size={11} /> {auth.account ?? "Signed in"}</span>
                  {auth.plan && <span className="tag bg-violet-100 text-violet-800 capitalize">{auth.plan}</span>}
                  {auth.subscription ? (
                    <span className="tag bg-emerald-50 text-emerald-700">Bills your subscription</span>
                  ) : (
                    <span className="tag bg-yellow-100 text-yellow-800"><TriangleAlert size={11} /> Per-token billing{auth.keySource ? ` (${auth.keySource})` : ""}</span>
                  )}
                </>
              ) : auth?.state === "logged_out" ? (
                <span className="tag bg-yellow-100 text-yellow-800">Not signed in</span>
              ) : (
                <span className="tag bg-zinc-100 text-zinc-600">Couldn't read the sign-in status</span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {active ? (
            <span className="tag bg-brand-500 text-white"><Check size={11} /> In use</span>
          ) : (
            <Button size="sm" onClick={onPick}>Use {info.label}</Button>
          )}
          {status?.installed && auth?.state !== "ok" && (
            <Button size="sm" variant="primary" onClick={signIn} disabled={signingIn}><LogIn size={13} /> Sign in</Button>
          )}
          {status && !status.installed && (
            <button className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink" onClick={onRefresh}>
              <ExternalLink size={11} /> I installed it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
