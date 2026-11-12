import { createRoot } from "react-dom/client";
import { UsageSection } from "../../desktop/src/components/UsageSection";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import { applySkin, readSkin } from "../../desktop/src/lib/skins";
import { StoreProvider } from "../../desktop/src/state/store";
import "../../desktop/src/styles.css";

// Served only by scripts/verify-usage-traces.ts: the Usage page alone, at the width of the Settings page it lives on.
setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <main className="min-h-screen bg-panel px-3 py-5 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[880px]"><UsageSection /></div>
    </main>
  </StoreProvider>,
);
