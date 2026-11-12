import { createRoot } from "react-dom/client";
import App from "../../desktop/src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../desktop/src/lib/analytics";
import { setAdvancedMode } from "../../desktop/src/lib/interface-mode";
import { markSimpleModePromptSeen } from "../../desktop/src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

// Served only by scripts/verify-sidebar-groups.ts: the real app against its disposable fixture. ?mode=simple is Simple
// mode, ?skin= the skin.
const params = new URLSearchParams(location.search);
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
setAdvancedMode(params.get("mode") !== "simple");
applySkin((params.get("skin") ?? "daylight") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
