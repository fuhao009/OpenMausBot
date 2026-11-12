import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "../../desktop/src/components/ChatMarkdown";
import { applySkin } from "../../desktop/src/lib/skins";
import { setAnalyticsEnabled } from "../../desktop/src/lib/analytics";
import "../../desktop/src/styles.css";

setAnalyticsEnabled(false);
applySkin(new URLSearchParams(location.search).get("skin") === "atelier" ? "atelier" : "midnight");
const fixture = await fetch("/__table-fixture").then((response) => response.json());
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-4xl p-4 text-ink sm:p-8">
    <ChatMarkdown text={fixture.text} message={fixture.message} />
  </main>,
);
