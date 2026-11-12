import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../../desktop/src/components/PluginsPanel";
import { StoreProvider } from "../../desktop/src/state/store";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import { applySkin, readSkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><PluginsPanel /></StoreProvider>);
