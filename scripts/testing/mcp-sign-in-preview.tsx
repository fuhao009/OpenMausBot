import { createRoot } from "react-dom/client";
import { McpServersPanel } from "../../desktop/src/components/McpServersPanel";
import { StoreProvider } from "../../desktop/src/state/store";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import { applySkin, readSkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(
  <StoreProvider><main className="mx-auto max-w-4xl p-8"><McpServersPanel /></main></StoreProvider>,
);
