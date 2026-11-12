import { BrowserWindow, nativeTheme, shell } from "electron";
import { desktopViewerErrorPage } from "./error-pages.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import viewerUrls from "./desktop-viewer.cjs";
const { desktopViewerUrl, sameDesktopViewerOrigin } = viewerUrls;

/** Keeps the isolated viewer lifecycle separate from main-process IPC registration. */
export function createDesktopViewerWindow({ state, APP_ICON, windowBackground }) {
function notifyDesktopViewer(open) {
  if (!state.desktopViewerOwner?.isDestroyed()) {
    state.desktopViewerOwner.send("desktop-viewer:state", {
      open,
      contextId: state.desktopViewerContextId,
    });
  }
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId) {
  if (!owner || owner.isDestroyed()) throw new Error("The Hezuo window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";

  const nextContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  // Clear the ref first so the stale window's close handler no-ops; a token-bearing URL is never retained.
  if (state.desktopViewerWindow && !state.desktopViewerWindow.isDestroyed()) {
    const previous = state.desktopViewerWindow;
    const previousOwner = state.desktopViewerOwner;
    const previousContextId = state.desktopViewerContextId;
    state.desktopViewerWindow = null;
    previous.close();
    if (previousContextId !== nextContextId && previousOwner && !previousOwner.isDestroyed()) {
      previousOwner.send("desktop-viewer:state", { open: false, contextId: previousContextId });
    }
  }
  state.desktopViewerOwner = owner.webContents;
  state.desktopViewerContextId = nextContextId;

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    modal: false,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Non-persistent partition: provider cookies stay out of the app renderer and die on exit.
      partition: "hezuo-desktop-viewer",
    },
  });
  state.desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;

  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  // A child window gets keystrokes only once focused; unfocused, typing lands in the app's composer.
  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
  viewer.on("closed", () => {
    if (state.desktopViewerWindow !== viewer) return;
    state.desktopViewerWindow = null;
    notifyDesktopViewer(false);
    state.desktopViewerOwner = null;
    state.desktopViewerContextId = null;
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = desktopViewerUrl(target);
      void shell.openExternal(external.toString());
    } catch {
    }
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {
    }
  });
  viewer.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || viewer.isDestroyed() || failedUrl.startsWith("data:")) return;
    void viewer.loadURL(desktopViewerErrorPage(description || "The viewer did not respond.", url.toString()));
  });

  notifyDesktopViewer(true);
  void viewer.loadURL(url.toString()).catch((error) => {
    if (viewer.isDestroyed()) return;
    void viewer.loadURL(desktopViewerErrorPage(error?.message ?? "The viewer did not respond.", url.toString()));
  });
  return true;
}
  return openDesktopViewer;
}
