/**
 * AI settings: which CLI Mudd drives, whether it is installed and signed in, which plan it
 * bills, and the model and effort used for research.
 */
import { Check, Download, Loader2, LogIn, LogOut, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { PROVIDERS, PROVIDER_IDS, type ProviderId, type ProviderStatus } from "../../../shared/ai";
import { api } from "../../lib/api";
import { useAi } from "../../lib/aiStatus";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { fire } from "../../lib/fire";
import { ProviderMark } from "./BrandMarks";

export function AiSettingsDialog() {
  const ai = useAi();
  const [checking, setChecking] = useState(false);
  // Closing the dialog would end an install or sign-in in flight, so it stays open until each
  // finishes or the user cancels it on its card.
  const [working, setWorking] = useState<ProviderId[]>([]);
  const onWorking = useCallback((id: ProviderId, on: boolean) => {
    setWorking((w) => (on === w.includes(id) ? w : on ? [...w, id] : w.filter((x) => x !== id)));
  }, []);
  const s = ai.settings;
  if (!s) return null;
  const locked = working.length > 0;

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
      locked={locked}
      title="AI settings"
      subtitle="Mudd runs research on your own Claude Code or Codex sign-in, so it bills your plan. No API keys are stored here."
      footer={
        <>
          {locked && <p className="mr-auto self-center text-xs text-ink-faint">Finish or cancel the {working.map((id) => PROVIDERS[id].label).join(" and ")} setup to close this.</p>}
          <Button variant="ghost" onClick={() => fire(check())} disabled={checking}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check again
          </Button>
          <Button variant="primary" onClick={() => ai.setOpen(false)} disabled={locked}>Done</Button>
        </>
      }
    >
      {!s.provider && <p className="mb-3 text-sm text-ink-soft">No AI provider chosen yet. Pick the one whose plan you already pay for.</p>}
      <div className="space-y-3">
        {PROVIDER_IDS.map((id) => (
          <ProviderCard key={id} id={id} status={ai.providers.find((p) => p.id === id)} active={s.provider === id} onPick={() => fire(ai.update({ provider: id }))} onRefresh={() => ai.refresh(true)} onWorking={onWorking} />
        ))}
      </div>

      {s.provider && <ModelSettings provider={s.provider} />}
    </Modal>
  );
}

/** Model and effort for the chosen provider. */
function ModelSettings({ provider }: { provider: ProviderId }) {
  const ai = useAi();
  const s = ai.settings!;
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="ai-model">Model for {PROVIDERS[provider].label}</label>
        {provider === "codex" ? (
          <input id="ai-model" className="field" defaultValue={s.model.codex} placeholder="default"
            onBlur={(e) => fire(ai.update({ model: { ...s.model, codex: e.target.value.trim() || "default" } }))} />
        ) : (
          <select id="ai-model" className="field" value={s.model.claude} onChange={(e) => fire(ai.update({ model: { ...s.model, claude: e.target.value } }))}>
            {PROVIDERS.claude.models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        )}
      </div>
      <div>
        <label className="label" htmlFor="ai-effort">Effort</label>
        <select id="ai-effort" className="field" value={s.effort[provider]} onChange={(e) => fire(ai.update({ effort: { ...s.effort, [provider]: e.target.value } }))}>
          {PROVIDERS[provider].efforts.map((e) => <option key={e} value={e}>{e === "low" ? "Low (fast, recommended)" : e === "medium" ? "Medium" : "High (thorough, slower)"}</option>)}
        </select>
      </div>
    </div>
  );
}

/**
 * One provider: install it, sign in, sign out. Install downloads the vendor's own build into
 * Mudd's folder (no npm, no terminal) and goes straight on to sign-in when the new copy is
 * signed out. Sign-in runs the CLI's own command hidden and the vendor's page opens in the
 * browser; the card moves on by itself once the user is signed in.
 */
function ProviderCard({ id, status, active, onPick, onRefresh, onWorking }: {
  id: ProviderId;
  status?: ProviderStatus;
  active: boolean;
  onPick: () => void;
  onRefresh: () => Promise<ProviderStatus[]>;
  onWorking: (id: ProviderId, on: boolean) => void;
}) {
  const info = PROVIDERS[id];
  const auth = status?.auth;
  const ready = !!status?.installed && auth?.state === "ok";
  const [busy, setBusy] = useState<"install" | "signin" | "signout" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canReopen, setCanReopen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The dialog stays open while this runs. Should the card go anyway (the app's window reloads),
  // the install or sign-in is cancelled: the server sees the stream close.
  useEffect(() => onWorking(id, busy === "install" || busy === "signin"), [id, busy, onWorking]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const signIn = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy("signin");
    setNote(null);
    setCanReopen(false);
    fire((async () => {
      let signedIn = false;
      try {
        for await (const ev of api.aiSignIn(id, ac.signal)) {
          if (ev.type === "url") setCanReopen(true);
          else if (ev.type === "done") {
            signedIn = ev.ok;
            if (!ev.ok) setNote(ev.message);
          }
        }
      } catch {
        if (!ac.signal.aborted) setNote("Couldn't reach Mudd to start the sign-in. Try again.");
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          setBusy(null);
          if (signedIn) await onRefresh().catch(() => []);
        }
      }
    })());
  }, [id, onRefresh]);

  const install = () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy("install");
    setNote(null);
    setProgress(null);
    fire((async () => {
      let installed = false;
      try {
        for await (const ev of api.aiInstall(id, ac.signal)) {
          if (ev.type === "log") setProgress(ev.line);
          else if (ev.type === "done") {
            installed = ev.ok;
            if (!ev.ok) setNote(ev.message);
          }
        }
      } catch {
        if (!ac.signal.aborted) setNote("Couldn't reach Mudd to start the install. Try again.");
      }
      if (abortRef.current !== ac) return;
      abortRef.current = null;
      setProgress(null);
      const next = installed ? (await onRefresh().catch(() => [])).find((p) => p.id === id) : null;
      // One click for a new user: having asked for it, they want to use it. Sign-in is shared
      // with their other apps, so a fresh copy is often signed in already.
      if (next?.installed && next.auth.state === "logged_out") return signIn();
      setBusy(null);
    })());
  };

  const signOut = async () => {
    setBusy("signout");
    setNote(null);
    const r = await api.aiSignOut(id).catch((e) => ({ ok: false, message: (e as Error).message }));
    await onRefresh().catch(() => []);
    setBusy(null);
    if (r.ok) toast.success(r.message);
    else setNote(r.message);
  };

  return (
    <div className={cn("rounded-2xl border p-4 transition", active ? "border-brand-300 bg-brand-50/50 shadow-[0_0_0_3px_var(--color-brand-100)]" : "border-line bg-white")}>
      <div className="flex items-start gap-3">
        <ProviderMark id={id} className="h-10 w-10 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{info.label}</h3>
            <span className="text-xs text-ink-faint">{info.vendor} · {info.plan}</span>
          </div>
          {!status ? (
            <p className="mt-1 text-xs text-ink-faint"><Loader2 size={12} className="inline animate-spin" /> Checking…</p>
          ) : busy === "install" ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-soft" role="status">
              <Loader2 size={12} className="animate-spin" /> Installing {info.label}{progress ? ` · ${progress}` : "…"}
            </p>
          ) : busy === "signin" ? (
            <div className="mt-1.5 text-xs text-ink-soft">
              <p className="flex items-center gap-1.5" role="status"><Loader2 size={12} className="animate-spin" /> Finish signing in in your browser…</p>
              {canReopen && (
                <p className="mt-1.5 text-ink-faint">
                  Closed the page? <LinkButton onClick={() => fire(api.aiSignInOpen(id))}>Open it again</LinkButton>
                </p>
              )}
            </div>
          ) : !status.installed ? (
            <p className="mt-1.5 text-xs text-ink-soft">
              {status.outdated
                ? `Version ${status.outdated} is too old for Mudd. Mudd can download a current copy from ${info.vendor} for you.`
                : `Not installed yet. Mudd can download it from ${info.vendor} for you, then you sign in with your ${info.plan} account.`}
            </p>
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
          {note && <p className="mt-1.5 text-xs text-yellow-800">{note}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!active ? (
            <Button size="sm" onClick={onPick}>Use {info.label}</Button>
          ) : ready ? (
            <span className="tag bg-brand-500 text-white"><Check size={11} /> In use</span>
          ) : (
            // Picked, but it can't run yet: the step to take is the button below.
            <span className="tag bg-zinc-100 text-zinc-600">Selected</span>
          )}
          {busy === "install" || busy === "signin" ? (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}><X size={13} /> Cancel</Button>
          ) : status && !status.installed ? (
            <Button size="sm" variant="primary" onClick={install} disabled={busy !== null}><Download size={13} /> {status.outdated ? "Update" : "Install"}</Button>
          ) : status?.installed && auth?.state !== "ok" ? (
            <Button size="sm" variant="primary" onClick={() => signIn()} disabled={busy !== null}><LogIn size={13} /> Sign in</Button>
          ) : ready ? (
            <Button size="sm" variant="ghost" onClick={() => fire(signOut())} disabled={busy !== null}>
              {busy === "signout" ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />} Sign out
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A secondary action that reads as a link, for the paths most people never need. */
function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">{children}</button>;
}
