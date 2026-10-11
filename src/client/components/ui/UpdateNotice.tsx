/**
 * The sidebar's "new version" card: update in place and restart, or download it by hand. When the
 * sidebar is folded to its icon rail, the same notice is one note-coloured icon button whose title
 * carries the words and whose click does what the card's first button would.
 */
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

  const headline = `Mudd ${version} is ${done ? "installed" : "available"}`;
  const detail = done ? (installed && nativeRestart() ? "Restarting…" : "Restart Mudd to finish.")
    : info.blocked ?? "Mudd restarts to finish, and stops any AI research in progress.";
  // What the rail's one button does: restart when a restart is all that is left, otherwise install
  // (or, when installing here is blocked, open the download page).
  const compactAction = done ? nativeRestart() : info.blocked ? openRelease : () => void install();

  return (
    <>
      <div className="mx-3 mb-3 hidden rounded-xl border-2 border-rim bg-note px-3 py-2.5 shadow-hard-sm wide:block">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          <ArrowUpCircle size={16} className="shrink-0 text-clay-deep" /> {headline}
        </p>
        <p className="mt-1 font-label text-[12px] text-mud-soft">{detail}</p>
        {done ? null : info.blocked ? (
          <Button size="sm" variant="primary" className="mt-2" onClick={openRelease}>Download</Button>
        ) : (
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" disabled={installing} onClick={() => void install()}>
              {installing ? "Updating…" : "Update & restart"}
            </Button>
            <Button size="sm" variant="ghost" onClick={openRelease}>What's new</Button>
          </div>
        )}
      </div>
      <div className="mx-2.5 mb-2.5 wide:hidden">
        <Button
          size="icon"
          className="w-full bg-note hover:bg-note/70"
          title={`${headline}. ${detail}`}
          aria-label={`${headline}. ${detail}`}
          disabled={installing || !compactAction}
          onClick={compactAction}
        >
          <ArrowUpCircle size={18} className="text-clay-deep" />
        </Button>
      </div>
    </>
  );
}
