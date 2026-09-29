import { useState } from "react";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import { CampaignPage } from "./components/campaign/CampaignPage";
import { HomePage, MeetingsPage } from "./components/campaigns/HomePage";
import { ImportProvider } from "./components/campaigns/ImportFlow";
import { NewCampaignDialog } from "./components/campaigns/NewCampaignDialog";
import { Sidebar } from "./components/ui/Sidebar";
import { AppToaster } from "./components/ui/Toaster";
import { AiSettingsDialog } from "./components/ai/AiSettings";
import { AiProvider } from "./lib/aiStatus";
import { CampaignListProvider, useCampaignList } from "./lib/campaignList";

/** A fresh campaign page per campaign: switching in the sidebar starts clean, undo included. */
function CampaignRoute() {
  const { id } = useParams();
  return <CampaignPage key={id} />;
}

function Shell() {
  const [creating, setCreating] = useState(false);
  const { campaigns } = useCampaignList();
  return (
    <div className="flex h-full">
      <Sidebar onNewCampaign={() => setCreating(true)} />
      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<HomePage onNewCampaign={() => setCreating(true)} />} />
          <Route path="/c/:id" element={<CampaignRoute />} />
          <Route path="/meetings" element={<MeetingsPage />} />
          <Route path="*" element={<HomePage onNewCampaign={() => setCreating(true)} />} />
        </Routes>
      </main>
      <NewCampaignDialog open={creating} onClose={() => setCreating(false)} campaigns={campaigns ?? []} />
      <AiSettingsDialog />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <CampaignListProvider>
        <AiProvider>
          <ImportProvider>
            <Shell />
            <AppToaster />
          </ImportProvider>
        </AiProvider>
      </CampaignListProvider>
    </BrowserRouter>
  );
}
