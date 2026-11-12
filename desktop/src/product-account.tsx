import { createRoot } from "react-dom/client";
import { ProductAccountGate } from "./components/ProductAccountGate";
import { loadLocale } from "./lib/i18n";
import "./styles.css";

await loadLocale(navigator.language);
const root = document.getElementById("root");
if (!root) throw new Error("product_account_root_missing");
createRoot(root).render(<ProductAccountGate />);
