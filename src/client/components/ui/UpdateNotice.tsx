/** The sidebar's "new version" card: update in place and restart, or download it by hand. */
import { ArrowUpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { UpdateInfo } from "../../../shared/types";
import { api } from "../../lib/api";
import { Button } from "./Button";

const CHECK_EVERY = 6 * 60 * 60_000;

/** Ask for a newer release now and every few hours. A failed check just means nothing to offer. */
export function useUpdateCheck(): UpdateInfo | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const check = () => void api.update().then(setInfo, () => {});
    check();
    const timer = setInterval(check, CHECK_EVERY);
    return () => clearInterval(timer);
  }, []);
  return info;
}

/** Bound by main.ts in Mudd's own window (not in a browser): start the new version, quit this one. */
const nativeRestart = () => (window as { __muddRestart?: () => void }).__muddRestart;

export function UpdateNotice({ info }: { info: UpdateInfo | null }) {
  const [installing, setInstalling] = useState(false);
  // Installed here, or (after a reload) by the server before this page asked.
  const [installed, setInstalled] = useState<string | null>(null);
  const done = installed ?? info?.installed ?? null;
  const version = done ?? info?.latest?.version;
  if (!info || !version) return null;
  const openRelease = () => info.latest && void api.openUrl(info.latest.url);

  const install = async () => {
    setInstalling(true);
    try {
      setInstalled((await api.installUpdate()).version);
      nativeRestart()?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="mx-3 mb-2 rounded-xl border border-brand-200 bg-brand-50 px-2.5 py-2">
      <p className="flex items-center gap-2 text-[12.5px] font-medium">
        <ArrowUpCircle size={14} className="shrink-0 text-brand-600" /> Mudd {version} is {done ? "installed" : "available"}
      </p>
      {done ? (
        <p className="mt-1 text-[11px] text-ink-soft">{installed && nativeRestart() ? "Restarting…" : "Restart Mudd to finish."}</p>
      ) : info.blocked ? (
        <>
          <p className="mt-1 text-[11px] text-ink-soft">{info.blocked}</p>
          <Button size="sm" variant="primary" className="mt-2" onClick={openRelease}>Download</Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-ink-soft">Mudd restarts to finish, and stops any AI research in progress.</p>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="primary" disabled={installing} onClick={() => void install()}>
              {installing ? "Updating…" : "Update & restart"}
            </Button>
            <Button size="sm" variant="ghost" onClick={openRelease}>What's new</Button>
          </div>
        </>
      )}
    </div>
  );
}
