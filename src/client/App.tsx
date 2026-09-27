import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { CampaignPage } from "./components/campaign/CampaignPage";
import { HomePage } from "./components/campaigns/HomePage";
import { ImportProvider } from "./components/campaigns/ImportFlow";
import { Logo } from "./components/ui/Logo";
import { AppToaster } from "./components/ui/Toaster";

export function App() {
  return (
    <BrowserRouter>
      <ImportProvider>
        <div className="flex h-full flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
            <Link to="/" className="flex items-center gap-2 rounded-md pr-1 hover:opacity-80">
              <Logo />
              <span className="text-[15px] font-semibold tracking-tight">
                Mudd<span className="text-clay-500">.io</span>
              </span>
            </Link>
            <span className="ml-auto hidden text-xs text-ink-faint sm:block">Local only · nothing leaves this computer</span>
          </header>
          <main className="min-h-0 flex-1">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/c/:id" element={<CampaignPage />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          </main>
        </div>
        <AppToaster />
      </ImportProvider>
    </BrowserRouter>
  );
}
