// The sidebar attention popover geometry fixture: the real Sidebar pinned to the
// ?density= before the first render, since Sidebar reads its density from
// localStorage once, at mount.
import { createRoot } from "react-dom/client";
import { saveSidebarDensity } from "../../desktop/src/lib/sidebar-preferences";
import { Sidebar } from "../../desktop/src/components/Sidebar";
import { StoreProvider } from "../../desktop/src/state/store";
import { applySkin, readSkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

const density = new URLSearchParams(window.location.search).get("density");
if (density === "comfortable" || density === "icons") {
  saveSidebarDensity(density);
}

function Fixture() {
  return <div className="flex h-screen">
    <Sidebar open onClose={() => {}} />
    <main className="p-8">
      <h1>Isolated sidebar attention verification</h1>
      <p>Nothing is selected; the attention popover opens from the header.</p>
    </main>
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
