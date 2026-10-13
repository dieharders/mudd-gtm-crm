/**
 * The sidebar's "new version" card: update in place and restart, or download it by hand. When the
 * sidebar is folded to its icon rail, the same notice is one note-coloured icon button whose title
 * carries the words, and whose click puts them in a heads-up toast with the card's first button.
 */
import { ArrowUpCircle, Info } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { UpdateInfo } from "../../../shared/types";
import { api } from "../../lib/api";
import { Button } from "./Button";
import { attentionToast } from "./Toaster";

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
    : info.blocked ?? "Mudd restarts to finish, and stops anything in-progress.";
  // What the rail's one button offers: restart when a restart is all that is left, otherwise
  // install (or, when installing here is blocked, open the download page). It only says so, in a
  // toast whose own button does it: the bare icon is easily clicked just to see what it is. The
  // restart is called with no arguments: the webview binding serialises them, and a click event cannot be.
  const restart = nativeRestart();
  const compact = done ? restart && { label: "Restart", onClick: () => restart() }
    : info.blocked ? { label: "Download", onClick: openRelease } : { label: "Update & restart", onClick: () => void install() };
  const offer = compact && (() => attentionToast(<><b>{headline}.</b> {detail}</>, compact, "update"));

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
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={installing} onClick={() => void install()}>
              {installing ? "Updating…" : "Update & restart"}
            </Button>
            <Button size="icon" variant="ghost" className="h-9 w-9 text-rim/65 hover:border-transparent hover:bg-transparent hover:text-rim" title="What's new" aria-label="What's new" onClick={openRelease}>
              <Info size={28} />
            </Button>
          </div>
        )}
      </div>
      <div className="mx-2.5 mb-2.5 wide:hidden">
        <Button
          size="icon"
          className="w-full bg-note hover:bg-note/70"
          title={`${headline}. ${detail}`}
          aria-label={`${headline}. ${detail}`}
          disabled={installing || !offer}
          onClick={offer || undefined}
        >
          <ArrowUpCircle size={18} className="text-clay-deep" />
        </Button>
      </div>
    </>
  );
}
