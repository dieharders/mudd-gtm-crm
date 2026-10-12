import { LucideProvider } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Icons draw heavier than lucide's 2px default to sit with the bold type; a strokeWidth prop still wins. */}
    <LucideProvider strokeWidth={2.5}>
      <App />
    </LucideProvider>
  </StrictMode>,
);
