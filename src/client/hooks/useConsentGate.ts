/**
 * The first run asks: rows (or the thesis) leave this computer only after the user says so. The
 * server answers 403 until they have; this turns that into the consent dialog, and retries the
 * request once they agree. Shared by enrichment and Discovery, so the page shows one dialog.
 */
import { useCallback, useState } from "react";
import toast from "react-hot-toast";
import { api, ApiError } from "../lib/api";

export interface ConsentGate {
  /** The dialog to show, with what each button does; null when none is needed. */
  needsConsent: null | { confirm: () => void; cancel: () => void };
  /** Make the request; on a 403, ask, then make it again. Null when refused or failed (the error is shown). */
  withConsent: <T>(attempt: () => Promise<T>) => Promise<T | null>;
}

export function useConsentGate(): ConsentGate {
  const [needsConsent, setNeedsConsent] = useState<ConsentGate["needsConsent"]>(null);
  const withConsent = useCallback(async <T,>(attempt: () => Promise<T>): Promise<T | null> => {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return new Promise<T | null>((resolve) => {
          setNeedsConsent({
            cancel: () => {
              setNeedsConsent(null);
              resolve(null);
            },
            confirm: () => {
              setNeedsConsent(null);
              api.aiSettings({ consented: true })
                .then(attempt)
                .then(resolve)
                .catch((e: unknown) => {
                  toast.error((e as Error).message);
                  resolve(null);
                });
            },
          });
        });
      }
      toast.error((err as Error).message);
      return null;
    }
  }, []);
  return { needsConsent, withConsent };
}
