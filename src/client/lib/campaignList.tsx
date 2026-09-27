/** The campaign list, shared by the sidebar and the home page. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { CampaignSummary, Meeting } from "../../shared/types";
import { api } from "./api";

interface ListState {
  campaigns: CampaignSummary[] | null;
  meetings: Meeting[];
  refresh: () => void;
}
const Ctx = createContext<ListState>({ campaigns: null, meetings: [], refresh: () => {} });
export const useCampaignList = () => useContext(Ctx);

export function CampaignListProvider({ children }: { children: ReactNode }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const location = useLocation();
  const refresh = useCallback(() => {
    api.campaigns().then(setCampaigns).catch(() => setCampaigns((c) => c ?? []));
    api.meetings().then(setMeetings).catch(() => {});
  }, []);
  // Counts and names change while a campaign is open, so refresh on every navigation.
  useEffect(refresh, [refresh, location.pathname]);
  return <Ctx.Provider value={{ campaigns, meetings, refresh }}>{children}</Ctx.Provider>;
}
