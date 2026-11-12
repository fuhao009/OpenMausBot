// The sandboxed local page that stands in front of a managed product's workspace.
import { fileURLToPath } from "node:url";
import { PRODUCT_ACCOUNT_CHANNELS, sanitizeProductAccountState } from "./product-account-wire.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ACCOUNT_PAGE = "product-account.html";
const ACCOUNT_PATH = `/${ACCOUNT_PAGE}`;

// Settings open in the same local page as a new document at a known query.
const SETTINGS_KEYS = new Set(["desktop-settings", "share-computer"]);

function sameWorkspaceDocument(approvedValue, actualValue) {
  const approved = normalizeLocalDocumentUrl(approvedValue);
  const actual = normalizeLocalDocumentUrl(actualValue);
  if (approved === null || actual === null) return false;
  if (approved === actual) return true;
  let left, right;
  try { left = new URL(approved); right = new URL(actual); } catch { return false; }
  if (left.origin !== right.origin || left.pathname !== right.pathname || left.search !== "" || right.pathname !== "/") return false;
  const keys = [...right.searchParams.keys()];
  return keys.includes("desktop-settings") && keys.every(key => SETTINGS_KEYS.has(key));
}

function sameDocument(approvedValue, actualValue, accountPage) {
  const approved = typeof approvedValue === "function" ? approvedValue() : approvedValue;
  if (accountPage) {
    const expected = normalizeAccountDocumentUrl(approved);
    const current = normalizeAccountDocumentUrl(actualValue);
    return expected !== null && current !== null && expected === current;
  }
  return sameWorkspaceDocument(approved, actualValue);
}

/** A file or loopback document address, without its fragment; nothing from the network passes. */
export function normalizeLocalDocumentUrl(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  url.hash = "";
  if (url.protocol === "file:") {
    // file://server/share names another machine's path; only this machine's files load.
    if (url.hostname && url.hostname !== "localhost") return null;
    return `file://${url.pathname}${url.search}`;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return `${url.origin}${url.pathname}${url.search}`;
  return null;
}

export function normalizeAccountDocumentUrl(value) {
  const normalized = normalizeLocalDocumentUrl(value);
  if (!normalized) return null;
  let url;
  try { url = new URL(normalized); } catch { return null; }
  const expected = url.protocol === "file:" ? url.pathname.endsWith(`/${ACCOUNT_PAGE}`) : url.pathname === ACCOUNT_PATH;
  return expected ? normalized : null;
}

/** `documentUrl` is the approved address, or a getter for the address of the window's current navigation. */
export function showsDocument(win, documentUrl, { accountPage = false } = {}) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  return sameDocument(documentUrl, win.webContents?.mainFrame?.url, accountPage);
}

export function ownsDocument(event, win, documentUrl, { accountPage = false } = {}) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  if (!event?.sender || event.sender !== win.webContents) return false;
  if (!event.senderFrame || event.senderFrame !== win.webContents?.mainFrame) return false;
  return sameDocument(documentUrl, event.senderFrame.url, accountPage);
}

export function createProductAccountWindow({
  BrowserWindow,
  url,
  preload = fileURLToPath(new URL("./product-account-preload.cjs", import.meta.url)),
  partition,
  iconPath,
  parent,
  title = "Hezuo",
  width = 980,
  height = 720,
  show = true,
  onClose,
} = {}) {
  const approved = normalizeAccountDocumentUrl(url);
  if (!approved) throw new Error("The account window needs its packaged local page.");
  if (typeof BrowserWindow !== "function") throw new Error("A BrowserWindow constructor is required.");
  let closing = false, disposed = false, documentUrl = approved;
  let resolveLoaded;
  const loaded = new Promise(resolve => { resolveLoaded = resolve; });
  const window = new BrowserWindow({
    width, height, minWidth: 480, minHeight: 560,
    show: show === true, title, icon: iconPath, parent,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload,
      ...(partition ? { partition } : {}),
    },
  });
  const contents = window.webContents;
  window.setMenu?.(null);
  contents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  contents.on?.("will-navigate", (event, target) => {
    if (normalizeLocalDocumentUrl(target) !== documentUrl) event.preventDefault?.();
  });
  contents.on?.("will-attach-webview", event => event.preventDefault?.());
  contents.on?.("did-navigate", (_event, target) => {
    const next = normalizeAccountDocumentUrl(target);
    if (next) documentUrl = next;
  });
  const settle = () => {
    const current = normalizeAccountDocumentUrl(contents.getURL?.());
    if (current) documentUrl = current;
    resolveLoaded();
  };
  contents.once?.("did-finish-load", settle);
  contents.once?.("did-fail-load", () => resolveLoaded());
  contents.once?.("render-process-gone", () => resolveLoaded());
  window.once?.("closed", () => { closing = true; disposed = true; resolveLoaded(); });
  window.on?.("close", () => {
    if (closing || disposed || window.isDestroyed?.()) return;
    closing = true;
    onClose?.();
  });
  try { Promise.resolve(window.loadURL(approved)).catch(() => resolveLoaded()); }
  catch { resolveLoaded(); }

  return {
    window,
    loaded,
    get documentUrl() { return documentUrl; },
    get disposed() { return disposed; },
    owns(event) { return !disposed && ownsDocument(event, window, documentUrl, { accountPage: true }); },
    /** A malformed state is not sent. */
    sendState(state) {
      if (disposed || !showsDocument(window, documentUrl, { accountPage: true })) return null;
      let safe;
      try { safe = sanitizeProductAccountState(state); } catch { return null; }
      contents.send?.(PRODUCT_ACCOUNT_CHANNELS.stateChanged, safe);
      return safe;
    },
    close() {
      if (disposed) return;
      closing = true;
      try { window.close(); } catch { /* already closing */ }
    },
  };
}
