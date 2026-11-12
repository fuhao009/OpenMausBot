import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../desktop/src/components/BrowserPanel";
import { StoreProvider, useStore } from "../../desktop/src/state/store";
import { applySkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots[0];
  return <main className="flex h-screen bg-app p-3 sm:p-6">{bot ? <BrowserPanel bot={bot} /> : "Loading isolated fixture…"}</main>;
}
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
