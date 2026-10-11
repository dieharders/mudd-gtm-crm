/** AI provider status and settings, shared by the sidebar, the settings dialog and the panels. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AiSettings, ProviderStatus } from "../../shared/ai";
import { api } from "./api";

interface AiState {
  settings: AiSettings | null;
  providers: ProviderStatus[];
  loading: boolean;
  /** Re-read every provider's status; resolves to it. */
  refresh: (fresh?: boolean) => Promise<ProviderStatus[]>;
  update: (patch: Partial<AiSettings>) => Promise<AiSettings>;
  open: boolean;
  setOpen: (v: boolean) => void;
}

const Ctx = createContext<AiState | null>(null);
export function useAi(): AiState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAi outside AiProvider");
  return v;
}

export function AiProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const s = await api.aiStatus(fresh);
      setSettings(s.settings);
      setProviders(s.providers);
      return s.providers;
    } finally {
      setLoading(false);
    }
  }, []);
  const update = useCallback(async (patch: Partial<AiSettings>) => {
    const s = await api.aiSettings(patch);
    setSettings(s);
    return s;
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  return <Ctx.Provider value={{ settings, providers, loading, refresh, update, open, setOpen }}>{children}</Ctx.Provider>;
}

/** The active provider's status, and whether it can run right now. */
export function useActiveProvider() {
  const { settings, providers } = useAi();
  const status = providers.find((p) => p.id === settings?.provider) ?? null;
  return { status, ready: !!status?.installed && status.auth.state === "ok" };
}
