import { createRoot } from "react-dom/client";
import { ComputerFilesPane } from "../../desktop/src/components/ComputerFilesPane";
import { BotEditorStore, initialState, type Bot } from "../../desktop/src/state/store";
import { applySkin } from "../../desktop/src/lib/skins";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import { setLocale } from "../../desktop/src/lib/i18n";
import "../../desktop/src/styles.css";

setAnalyticsEnabled(false);
setLocale("en");
applySkin(new URLSearchParams(location.search).get("skin") === "atelier" ? "atelier" : "midnight");
const bot: Bot = await fetch("/__computer-files-fixture").then((response) => response.json());
const value = {
  state: { ...initialState, bots: [bot], selectedId: bot.id },
  dispatch: () => {},
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
};
createRoot(document.getElementById("root")!).render(
  <BotEditorStore value={value}>
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-app pt-6 text-ink">
      <h1 className="mb-4 px-5 text-lg font-medium">File reviewer · Files</h1>
      <ComputerFilesPane bot={bot} />
    </main>
  </BotEditorStore>,
);
