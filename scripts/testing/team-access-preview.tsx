// The whole app as one person of a Team Cloud sees it: scripts/verify-team-bot-access.ts sends every request as them.
// ?mode=simple|advanced and ?skin= pick the mode and the skin.
import { createRoot } from "react-dom/client";
import App from "../../desktop/src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../desktop/src/lib/analytics";
import { setAdvancedMode } from "../../desktop/src/lib/interface-mode";
import { markSimpleModePromptSeen } from "../../desktop/src/lib/simple-mode-prompt";
import { applySkinChoice, SKIN_IDS, type SkinId } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

const params = new URLSearchParams(location.search);
const skin = params.get("skin") ?? "daylight";
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
setAdvancedMode(params.get("mode") === "advanced");
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "daylight");
createRoot(document.getElementById("root")!).render(<App />);
