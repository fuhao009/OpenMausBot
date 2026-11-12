// Real conversation and task controls, connected only to the disposable server.
import { createRoot } from "react-dom/client";
import { ChatView } from "../../desktop/src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../desktop/src/components/DesktopCapabilities";
import { StoreProvider, useStore } from "../../desktop/src/state/store";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import { applySkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(candidate => candidate.id === new URLSearchParams(location.search).get("bot"));
  return <main className="flex h-screen flex-col bg-app text-ink">
    {state.error && <p role="alert">{state.error}</p>}
    <output hidden id="fixture-state">{JSON.stringify({ threadId: bot?.threadId, pending: bot?.awaitingThreadSnapshot,
      messageIds: bot?.messages.map(message => message.id) })}</output>
    {bot && <div className="min-h-0 flex-1"><ChatView bot={bot} /></div>}
  </main>;
}
setAnalyticsEnabled(false);
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
