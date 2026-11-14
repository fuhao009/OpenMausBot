import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const PREFIX = "hezuo:embedded-browser-";
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_TABS = 8;
const MAX_PENDING = 256;
const PAGE = new Set(`Page.enable Page.setLifecycleEventsEnabled Page.navigate Page.navigateToHistoryEntry Page.getNavigationHistory Page.reload Page.stopLoading Page.getFrameTree Page.createIsolatedWorld Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument Page.setInterceptFileChooserDialog Page.handleJavaScriptDialog Page.captureScreenshot Page.getLayoutMetrics Page.startScreencast Page.stopScreencast Page.screencastFrameAck Page.bringToFront Page.close DOM.getDocument DOM.describeNode DOM.resolveNode DOM.querySelector DOM.focus DOM.getContentQuads DOM.getBoxModel DOM.scrollIntoViewIfNeeded DOM.getNodeForLocation DOM.setFileInputFiles DOM.getFrameOwner Accessibility.getFullAXTree Accessibility.queryAXTree Emulation.setUserAgentOverride Emulation.setFocusEmulationEnabled Emulation.setDeviceMetricsOverride Emulation.clearDeviceMetricsOverride Network.enable Network.disable Network.getCookies Network.deleteCookies Network.setUserAgentOverride Log.enable Log.disable Fetch.enable Fetch.disable Fetch.continueRequest Fetch.continueWithAuth Fetch.fulfillRequest Fetch.failRequest Runtime.evaluate Runtime.callFunctionOn Runtime.terminateExecution Runtime.runIfWaitingForDebugger Runtime.releaseObject Runtime.releaseObjectGroup Target.setAutoAttach Target.detachFromTarget`.split(" "));
const WORKER = new Set("Emulation.setUserAgentOverride Network.setUserAgentOverride Runtime.runIfWaitingForDebugger Target.setAutoAttach".split(" "));
const DEVICE_METHOD = /^(?:Input\.(?:dispatchKeyEvent|insertText|dispatchMouseEvent|dispatchTouchEvent|emulateTouchFromMouseEvent|synthesizePinchGesture|synthesizeScrollGesture|synthesizeTapGesture|setIgnoreInputEvents)|WebAuthn\.(?:enable|disable|addVirtualAuthenticator|removeVirtualAuthenticator|addCredential|getCredential|getCredentials|removeCredential|clearCredentials|setUserVerified|setAutomaticPresenceSimulation|setResponseOverrideBits|setCredentialProperties))$/;
const DENIED = /^(?:Runtime\.(?:enable|addBinding)|Console\.|Debugger\.|Profiler\.|HeapProfiler\.|Tracing\.|SystemInfo\.|Network\.getAllCookies)/;
const PERMISSIONS = new Map([
  ["clipboard-write", "clipboard-sanitized-write"], ["clipboard-read", "clipboard-read"],
  ["notifications", "notifications"], ["geolocation", "geolocation"], ["camera", "media"], ["microphone", "media"],
  ["midi", "midi"], ["persistent-storage", "persistent-storage"], ["storage-access", "storage-access"],
  ["top-level-storage-access", "top-level-storage-access"], ["background-sync", "background-sync"],
  ["display-capture", "display-capture"], ["local-network-access", "local-network-access"],
]);
const fail = (message, code = -32602) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validUrl = value => { try { const url = new URL(value); return ["http:", "https:", "data:", "blob:"].includes(url.protocol) || value === "about:blank"; } catch { return false; } };
const matches = (info, filter) => !Array.isArray(filter) || filter.find(entry => !entry.type || entry.type === info.type)?.exclude !== true && filter.some(entry => !entry.type || entry.type === info.type);

/** Private, process-owned CDP endpoint. Construct one broker per authenticated utility process.
 * sessionFor(key) returns proxy-ready {session, downloadDir, release?, restoreTabs?, saveTabs?}.
 * Tab snapshots are {urls: string[], active: number}; they restore URLs, not history/sessionStorage.
 * createView({profileKey, session, viewport, opener, onPopup}) returns an initialized
 * about:blank {webContents, getBounds, setBounds}; popup session safety must be configured synchronously.
 * No renderer IPC, global target discovery, or app-wide debugging endpoint is used.
 */
export function createEmbeddedBrowserBroker({ createView, sessionFor, send, version, activate, closeView }) {
  const leases = new Map();
  const profiles = new Set();
  const closingProfiles = new Map();
  let closed = false;
  const post = (lease, message) => {
    if (!lease.closed) send({ type: `${PREFIX}cdp`, leaseId: lease.id, generation: lease.generation, message: JSON.stringify(message) });
  };
  const event = (lease, method, params, sessionId) => post(lease, { method, params, ...(sessionId ? { sessionId } : {}) });
  const infoOf = target => ({ ...target.info, url: target.view.webContents.getURL(), title: target.view.webContents.getTitle(), attached: true });
  const ownedTarget = (lease, id) => { const target = lease.targets.get(id); if (!target) throw fail("Target is not owned by this browser."); return target; };
  const ownedRoute = (lease, id) => { const route = lease.routes.get(id); if (!route) throw fail("Session is not owned by this browser."); return route; };
  const context = (lease, params) => {
    if (params.browserContextId !== undefined && params.browserContextId !== lease.contextId) throw fail("Browser context is not owned by this browser.");
  };
  function saveTabs(lease) {
    if (!lease.saveTabs || lease.restoring) return lease.saving ?? Promise.resolve();
    const tabs = [...lease.targets.values()];
    const snapshot = { urls: tabs.map(target => target.view.webContents.getURL()).map(url => validUrl(url) ? url : "about:blank"), active: Math.max(0, tabs.findIndex(target => target.info.targetId === lease.active)) };
    lease.saving = (lease.saving ?? Promise.resolve()).then(() => lease.saveTabs(snapshot));
    // Event callbacks cannot await; retain the error and fail the next explicit operation.
    lease.saving.catch(error => { lease.saveError = error; });
    return lease.saving;
  }
  async function activateTarget(lease, target) {
    await activate(target.view);
    lease.active = target.info.targetId;
    await saveTabs(lease);
  }
  function publish(lease, target) {
    if (target.published || !lease.autoAttach || !matches(target.info, lease.autoFilter)) return;
    target.published = true;
    event(lease, "Target.attachedToTarget", { sessionId: target.primary.id, targetInfo: infoOf(target), waitingForDebugger: false });
    for (const queued of target.queued.splice(0)) event(lease, queued.method, queued.params, queued.sessionId);
  }
  function routeEvent(lease, target, method, params, sessionId) {
    if (target.published) event(lease, method, params, sessionId);
    else if (target.queued.length < 1024) target.queued.push({ method, params, sessionId });
    else void terminate(lease, "The browser event queue exceeded its limit.");
  }
  function removeRoute(lease, route, notify = true) {
    for (const child of [...lease.routes.values()]) if (child.parent === route.id) removeRoute(lease, child, notify);
    if (!lease.routes.delete(route.id)) return;
    if (route.native) route.target.native.delete(route.native);
    if (notify && route.target.published) event(lease, "Target.detachedFromTarget", { sessionId: route.id, targetId: route.target.info.targetId }, route.parent ?? undefined);
  }
  function forgetTarget(lease, target) {
    if (!lease.targets.delete(target.info.targetId)) return;
    for (const off of target.offs) off();
    removeRoute(lease, target.primary);
    for (const route of [...lease.routes.values()]) if (route.target === target) removeRoute(lease, route);
    if (lease.active === target.info.targetId) lease.active = lease.targets.keys().next().value;
    if (!lease.closed) void saveTabs(lease);
    if (lease.discover) event(lease, "Target.targetDestroyed", { targetId: target.info.targetId });
  }
  async function register(lease, view, opener) {
    if (lease.closed || lease.targets.size >= MAX_TABS) { await closeView(view); throw fail("The browser cannot open another tab."); }
    const wc = view.webContents;
    if (wc.session !== lease.session) { await closeView(view); throw fail("The tab has the wrong browser session."); }
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const dbg = wc.debugger;
    dbg.attach("1.3");
    let nativeInfo;
    if (lease.closed) { dbg.detach(); await closeView(view); throw fail("The browser closed while attaching."); }
    try { ({ targetInfo: nativeInfo } = await dbg.sendCommand("Target.getTargetInfo")); }
    catch (error) { dbg.detach(); await closeView(view); throw error; }
    if (lease.closed) { dbg.detach(); await closeView(view); throw fail("The browser closed while attaching."); }
    if (!nativeInfo?.targetId || nativeInfo.type !== "page") { dbg.detach(); await closeView(view); throw fail("The view did not expose a page target."); }
    if (nativeInfo.browserContextId) {
      if (lease.contextId && lease.contextId !== nativeInfo.browserContextId) { dbg.detach(); await closeView(view); throw fail("The tab has the wrong browser context."); }
      lease.contextId = nativeInfo.browserContextId;
    }
    const target = { view, info: { ...nativeInfo, ...(opener ? { openerId: opener.info.targetId } : {}) }, native: new Map(), published: false, queued: [], offs: [], windowId: ++lease.nextWindow, attaching: 0 };
    const primary = { id: randomUUID(), native: null, parent: null, kind: "page", target };
    target.primary = primary;
    lease.targets.set(nativeInfo.targetId, target);
    lease.routes.set(primary.id, primary);
    const listen = (emitter, name, listener) => { emitter.on(name, listener); target.offs.push(() => emitter.removeListener(name, listener)); };
    listen(dbg, "message", (_, method, incoming, nativeParent) => {
      if (lease.closed || !lease.targets.has(target.info.targetId)) return;
      const parent = nativeParent ? target.native.get(nativeParent) : primary;
      if (!parent) return;
      let params = incoming;
      if (method === "Target.attachedToTarget") {
        const childInfo = params.targetInfo;
        if (!childInfo || typeof params.sessionId !== "string") return;
        const self = childInfo.targetId === target.info.targetId;
        if (!self && !["iframe", "worker", "service_worker", "shared_worker"].includes(childInfo.type)) { void dbg.sendCommand("Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => {}); return; }
        // A self attachment is permitted only while an explicit owned viewer attach is outstanding.
        if (self && !target.attaching) { void dbg.sendCommand("Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => {}); return; }
        if (childInfo.browserContextId && lease.contextId && childInfo.browserContextId !== lease.contextId) { void dbg.sendCommand("Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => {}); return; }
        const route = { id: randomUUID(), native: params.sessionId, parent: self ? null : parent.id, kind: childInfo.type, target };
        target.native.set(route.native, route);
        lease.routes.set(route.id, route);
        params = { ...params, sessionId: route.id };
        routeEvent(lease, target, method, params, self ? undefined : parent.id);
        return;
      }
      if (method === "Target.detachedFromTarget") { const route = target.native.get(params.sessionId); if (route) removeRoute(lease, route); return; }
      // A native discovery event must never disclose another page or context.
      if (method.startsWith("Target.") && !["Target.targetCrashed"].includes(method)) return;
      routeEvent(lease, target, method, params, parent.id);
    });
    listen(dbg, "detach", () => forgetTarget(lease, target));
    listen(wc, "destroyed", () => forgetTarget(lease, target));
    listen(wc, "render-process-gone", (_, details) => event(lease, "Target.targetCrashed", { targetId: target.info.targetId, status: details.reason, errorCode: details.exitCode }));
    const changed = () => {
      if (lease.discover && lease.targets.has(target.info.targetId)) event(lease, "Target.targetInfoChanged", { targetInfo: infoOf(target) });
      if (!lease.closed) void saveTabs(lease);
    };
    listen(wc, "page-title-updated", changed);
    listen(wc, "did-navigate", changed);
    listen(wc, "did-navigate-in-page", changed);
    if (lease.discover && matches(target.info, lease.discoverFilter)) event(lease, "Target.targetCreated", { targetInfo: infoOf(target) });
    lease.active = target.info.targetId;
    void saveTabs(lease);
    publish(lease, target);
    return target;
  }
  async function newTarget(lease, opener) {
    if (lease.targets.size + lease.creating >= MAX_TABS) throw fail("The browser tab limit was reached.");
    lease.creating++;
    try {
      let target;
      const view = await createView({ profileKey: lease.key, session: lease.session, viewport: lease.viewport, opener: opener?.view, onPopup: async popup => {
        try { return await register(lease, popup, target); }
        catch (error) { await closeView(popup); throw error; }
      } });
      target = await register(lease, view, opener);
      return target;
    } finally { lease.creating--; }
  }
  function permissions(lease) {
    function check(permission, origin, details = {}) {
      const names = permission === "media" ? (details.mediaTypes ?? ["video", "audio"]).map(type => type === "video" ? "camera" : "microphone") : [...PERMISSIONS].filter(([, value]) => value === permission).map(([name]) => name);
      if (!names.length) return false;
      return names.every(name => (lease.permissions.get(`${origin}|${name}`) ?? lease.permissions.get(`*|${name}`)) === "granted");
    }
    lease.session.setPermissionCheckHandler((wc, permission, origin, details) => (!wc || [...lease.targets.values()].some(t => t.view.webContents === wc)) && check(permission, origin, details));
    lease.session.setPermissionRequestHandler((wc, permission, callback, details) => callback([...lease.targets.values()].some(t => t.view.webContents === wc) && check(permission, details.requestingOrigin ?? (() => { try { return new URL(details.requestingUrl).origin; } catch { return ""; } })(), details)));
    lease.session.setDevicePermissionHandler(() => false);
  }
  function downloads(lease) {
    const onDownload = (_, item, wc) => {
      const target = [...lease.targets.values()].find(t => t.view.webContents === wc);
      if (!target || !lease.downloadEnabled || lease.downloads.size >= 160) { item.cancel(); return; }
      const guid = randomUUID();
      const filePath = join(lease.downloadDir, guid);
      item.setSavePath(filePath);
      lease.downloads.set(guid, item);
      event(lease, "Browser.downloadWillBegin", { frameId: target.info.targetId, guid, url: item.getURL(), suggestedFilename: item.getFilename() });
      const progress = (state, terminal) => {
        const receivedBytes = item.getReceivedBytes();
        const totalBytes = item.getTotalBytes();
        if (!terminal && Math.max(receivedBytes, totalBytes) > 1024 ** 3) item.cancel();
        event(lease, "Browser.downloadProgress", { guid, state, receivedBytes, totalBytes, ...(state === "completed" ? { filePath } : {}) });
        if (terminal) lease.downloads.delete(guid);
      };
      item.on("updated", () => progress("inProgress", false));
      item.once("done", (_, state) => progress(state === "completed" ? "completed" : "canceled", true));
    };
    lease.session.on("will-download", onDownload);
    lease.offDownload = () => lease.session.removeListener("will-download", onDownload);
  }
  function terminate(lease, reason) {
    if (lease.termination) return lease.termination;
    lease.closed = true;
    leases.delete(lease.id);
    // Register the barrier before any await. A new open of this key must not
    // reuse its Electron Session until download/listener/storage teardown ends.
    const termination = Promise.resolve().then(async () => {
      try {
        try { await saveTabs(lease); } catch { /* Closing still releases native resources. */ }
        for (const item of lease.downloads.values()) item.cancel();
        lease.downloads.clear();
        lease.offDownload?.();
        lease.session?.setPermissionCheckHandler(() => false);
        lease.session?.setPermissionRequestHandler((_, __, callback) => callback(false));
        for (const target of [...lease.targets.values()]) {
          for (const off of target.offs) off();
          try { if (target.view.webContents.debugger.isAttached()) target.view.webContents.debugger.detach(); } catch {}
          try { await closeView(target.view); } catch {}
        }
        lease.targets.clear(); lease.routes.clear();
        await lease.session?.closeAllConnections();
        await lease.session?.cookies.flushStore();
        lease.session?.flushStorageData();
      } finally {
        try { await lease.release?.(); }
        finally {
          profiles.delete(lease.key);
          closingProfiles.delete(lease.key);
          send({ type: `${PREFIX}closed`, leaseId: lease.id, generation: lease.generation, reason });
        }
      }
    });
    lease.termination = termination;
    closingProfiles.set(lease.key, termination);
    return termination;
  }
  async function rootCommand(lease, method, params) {
    context(lease, params);
    switch (method) {
      case "Browser.getVersion": return typeof version === "function" ? version() : version;
      case "Browser.close": return {};
      case "Target.setDiscoverTargets":
        if (typeof params.discover !== "boolean") throw fail("discover must be boolean.");
        lease.discover = params.discover; lease.discoverFilter = params.filter;
        if (lease.discover) for (const target of lease.targets.values()) if (matches(target.info, params.filter)) event(lease, "Target.targetCreated", { targetInfo: infoOf(target) });
        return {};
      case "Target.setAutoAttach":
        if (params.flatten !== true || typeof params.autoAttach !== "boolean") throw fail("Flat auto-attachment is required.");
        lease.autoAttach = params.autoAttach; lease.autoFilter = params.filter;
        if (lease.autoAttach) for (const target of lease.targets.values()) publish(lease, target);
        return {};
      case "Target.getTargets": return { targetInfos: [...lease.targets.values()].filter(t => matches(t.info, params.filter)).map(infoOf) };
      case "Target.getTargetInfo": {
        const target = params.targetId === undefined ? lease.targets.values().next().value : ownedTarget(lease, params.targetId);
        if (!target) throw fail("The browser has no live page.");
        return { targetInfo: infoOf(target) };
      }
      case "Target.createTarget": {
        if (!validUrl(params.url) || Object.keys(params).some(k => !["url", "browserContextId"].includes(k))) throw fail("Unsupported target creation parameters.");
        const target = await newTarget(lease);
        if (params.url !== "about:blank") await target.view.webContents.loadURL(params.url);
        return { targetId: target.info.targetId };
      }
      case "Target.closeTarget": { const target = ownedTarget(lease, params.targetId); await closeView(target.view); return { success: !lease.targets.has(target.info.targetId) || target.view.webContents.isDestroyed() }; }
      case "Target.activateTarget": await activateTarget(lease, ownedTarget(lease, params.targetId)); return {};
      case "Target.attachToTarget": {
        if (params.flatten !== true) throw fail("Flat attachment is required.");
        const target = ownedTarget(lease, params.targetId);
        target.attaching++;
        try {
          const result = await target.view.webContents.debugger.sendCommand(method, { targetId: params.targetId, flatten: true });
          const route = target.native.get(result.sessionId);
          if (!route) throw fail("The native session did not attach.", -32000);
          return { sessionId: route.id };
        } finally { target.attaching--; }
      }
      case "Target.detachFromTarget": {
        const route = ownedRoute(lease, params.sessionId);
        if (!route.native) throw fail("The primary session cannot be detached independently.");
        await route.target.view.webContents.debugger.sendCommand(method, { sessionId: route.native });
        removeRoute(lease, route); return {};
      }
      case "Browser.getWindowForTarget": { const target = ownedTarget(lease, params.targetId); return { windowId: target.windowId, bounds: { ...target.view.getBounds(), windowState: "normal" } }; }
      case "Browser.getWindowBounds":
      case "Browser.setWindowBounds": {
        const target = [...lease.targets.values()].find(t => t.windowId === params.windowId);
        if (!target) throw fail("Window is not owned by this browser.");
        if (method.endsWith("setWindowBounds")) {
          const b = params.bounds;
          if (!object(b) || Object.keys(b).some(k => !["width", "height", "windowState"].includes(k)) || b.windowState && b.windowState !== "normal" || [b.width, b.height].some(v => v !== undefined && (!Number.isInteger(v) || v < 1 || v > 8192))) throw fail("Invalid scoped window bounds.");
          await target.view.setBounds({ ...target.view.getBounds(), ...(b.width ? { width: b.width } : {}), ...(b.height ? { height: b.height } : {}) });
          return {};
        }
        return { bounds: { ...target.view.getBounds(), windowState: "normal" } };
      }
      case "Browser.setPermission": {
        const name = params.permission?.name;
        if (!PERMISSIONS.has(name) || !["granted", "denied", "prompt"].includes(params.setting) || Object.keys(params.permission).some(k => k !== "name")) throw fail("Unsupported permission descriptor.");
        if (params.embeddedOrigin !== undefined && params.embeddedOrigin !== params.origin) throw fail("Embedded-origin permission overrides are unsupported.");
        const origin = params.origin === undefined ? "*" : new URL(params.origin).origin;
        lease.permissions.set(`${origin}|${name}`, params.setting);
        return {};
      }
      case "Browser.resetPermissions": lease.permissions.clear(); return {};
      case "Browser.setDownloadBehavior":
        if (!["allowAndName", "deny"].includes(params.behavior) || params.behavior === "allowAndName" && (typeof params.downloadPath !== "string" || resolve(params.downloadPath) !== lease.downloadDir) || params.eventsEnabled !== undefined && params.eventsEnabled !== true) throw fail("Only the approved download directory and tracked downloads are supported.");
        lease.downloadEnabled = params.behavior === "allowAndName"; return {};
      case "Browser.cancelDownload": {
        const item = lease.downloads.get(params.guid); if (!item) throw fail("Download is not owned by this browser."); item.cancel(); return {};
      }
      case "Storage.getCookies": {
        const cookies = await lease.session.cookies.get({});
        return { cookies: cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expirationDate ?? -1, size: Buffer.byteLength(cookie.name + cookie.value), httpOnly: cookie.httpOnly, secure: cookie.secure, session: cookie.session, ...(cookie.sameSite && cookie.sameSite !== "unspecified" ? { sameSite: ({ no_restriction: "None", lax: "Lax", strict: "Strict" })[cookie.sameSite] } : {}) })) };
      }
      case "Storage.setCookies": {
        if (!Array.isArray(params.cookies) || params.cookies.length > 1000) throw fail("Invalid cookie list.");
        const converted = params.cookies.map(cookie => {
          if (!object(cookie) || Object.keys(cookie).some(key => !["name", "value", "url", "domain", "path", "secure", "httpOnly", "sameSite", "expires"].includes(key)) || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw fail("Unsupported cookie fields.");
          const url = cookie.url ?? `${cookie.secure ? "https" : "http"}://${String(cookie.domain ?? "").replace(/^\./, "")}${cookie.path || "/"}`;
          if (!["http:", "https:"].includes(new URL(url).protocol)) throw fail("Invalid cookie URL.");
          if (cookie.sameSite !== undefined && !["None", "Lax", "Strict"].includes(cookie.sameSite)) throw fail("Invalid cookie SameSite.");
          if (cookie.expires !== undefined && (!Number.isFinite(cookie.expires) || cookie.expires < -1)) throw fail("Invalid cookie expiration.");
          return { url, name: cookie.name, value: cookie.value, ...(cookie.domain ? { domain: cookie.domain } : {}), ...(cookie.path ? { path: cookie.path } : {}), ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}), ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}), ...(cookie.sameSite ? { sameSite: ({ None: "no_restriction", Lax: "lax", Strict: "strict" })[cookie.sameSite] } : {}), ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expirationDate: cookie.expires } : {}) };
        });
        for (const cookie of converted) await lease.session.cookies.set(cookie);
        return {};
      }
      case "Storage.clearCookies": await lease.session.clearStorageData({ storages: ["cookies"] }); return {};
      case "Storage.clearDataForOrigin": {
        if (typeof params.origin !== "string" || new URL(params.origin).origin !== params.origin) throw fail("A serialized origin is required.");
        const map = { appcache: "appcache", cookies: "cookies", file_systems: "filesystem", indexeddb: "indexdb", local_storage: "localstorage", shader_cache: "shadercache", websql: "websql", service_workers: "serviceworkers", cache_storage: "cachestorage" };
        if (typeof params.storageTypes !== "string") throw fail("storageTypes is required.");
        const types = params.storageTypes.split(",");
        if (types.some(t => t !== "all" && !map[t])) throw fail("Unsupported storage type.");
        await lease.session.clearStorageData({ origin: params.origin, ...(types.includes("all") ? {} : { storages: types.map(t => map[t]) }) }); return {};
      }
      default: throw fail("Method is not allowed on the scoped browser.", -32601);
    }
  }
  async function sessionCommand(lease, route, method, params) {
    if (DENIED.test(method)) throw fail("Method is forbidden.", -32601);
    const document = route.kind === "page" || route.kind === "iframe";
    if (!(document ? PAGE.has(method) || DEVICE_METHOD.test(method) : ["worker", "service_worker", "shared_worker"].includes(route.kind) ? WORKER.has(method) : method === "Runtime.runIfWaitingForDebugger")) throw fail("Method is not allowed on this session.", -32601);
    if (params.browserContextId !== undefined || params.targetId !== undefined) throw fail("Cross-target parameters are forbidden.");
    if (method === "Page.navigate" && !validUrl(params.url)) throw fail("Navigation scheme is forbidden.");
    if (method === "Page.addScriptToEvaluateOnNewDocument" && (typeof params.worldName !== "string" || !params.worldName)) throw fail("A named isolated world is required.");
    if (method === "Target.setAutoAttach" && params.flatten !== true) throw fail("Flat attachment is required.");
    if (method === "Target.detachFromTarget") {
      const child = ownedRoute(lease, params.sessionId);
      if (!child.native || child.parent !== route.id) throw fail("Session is not a child of the caller.");
      params = { ...params, sessionId: child.native };
    }
    if (method === "Page.bringToFront") { await activateTarget(lease, route.target); return {}; }
    if (method === "Page.close") { await closeView(route.target.view); return {}; }
    return route.target.view.webContents.debugger.sendCommand(method, params, ...(route.native ? [route.native] : []));
  }
  async function receive(message) {
    if (!object(message) || ![`${PREFIX}open`, `${PREFIX}cdp`, `${PREFIX}release`].includes(message.type)) return false;
    if (message.type === `${PREFIX}open`) {
      if (typeof message.requestId !== "string" || message.requestId.length > 200) return true;
      let lease;
      try {
        const closing = closingProfiles.get(message.profileKey);
        if (closing) await closing;
        if (closed || typeof message.profileKey !== "string" || !message.profileKey || message.profileKey.length > 512 || profiles.has(message.profileKey)) throw fail("The browser profile is unavailable.");
        if (!object(message.viewport) || [message.viewport.width, message.viewport.height].some(v => !Number.isInteger(v) || v < 1 || v > 8192)) throw fail("Invalid viewport.");
        if (!Number.isInteger(message.egressPort) || message.egressPort < 1 || message.egressPort > 65535) throw fail("A valid profile egress gate is required.");
        profiles.add(message.profileKey);
        lease = { id: randomUUID(), generation: randomUUID(), key: message.profileKey, viewport: message.viewport, targets: new Map(), routes: new Map(), downloads: new Map(), permissions: new Map(), nextWindow: 0, creating: 0, pending: new Set(), closed: false, autoAttach: false, discover: false };
        leases.set(lease.id, lease);
        const resources = await sessionFor(message.profileKey, { egressPort: message.egressPort });
        if (lease.closed) { await resources.release?.(); throw fail("The browser closed while acquiring its profile."); }
        lease.session = resources.session; lease.release = resources.release; lease.saveTabs = resources.saveTabs;
        if (typeof resources.downloadDir !== "string" || !isAbsolute(resources.downloadDir)) throw fail("The approved download directory is unavailable.");
        lease.downloadDir = resolve(resources.downloadDir);
        mkdirSync(lease.downloadDir, { recursive: true, mode: 0o700 });
        if (closed || lease.closed) throw fail("The browser closed while opening.");
        permissions(lease); downloads(lease);
        lease.restoring = true;
        if (message.fresh && lease.saveTabs) await lease.saveTabs({ urls: [], active: 0 });
        const saved = !message.fresh && object(resources.restoreTabs) ? resources.restoreTabs : null;
        const urls = Array.isArray(saved?.urls) ? saved.urls.filter(url => typeof url === "string" && validUrl(url)).slice(0, MAX_TABS) : [];
        for (const url of urls.length ? urls : ["about:blank"]) {
          const target = await newTarget(lease);
          if (url !== "about:blank") await target.view.webContents.loadURL(url);
        }
        const tabs = [...lease.targets.values()];
        const active = Number.isInteger(saved?.active) ? Math.min(Math.max(saved.active, 0), tabs.length - 1) : 0;
        lease.restoring = false;
        await activateTarget(lease, tabs[active]);
        if (lease.closed) throw fail("The browser closed while opening.");
        send({ type: `${PREFIX}open-result`, requestId: message.requestId, ok: true, leaseId: lease.id, generation: lease.generation, version: (typeof version === "function" ? version() : version).product, pageLimit: null });
      } catch {
        if (lease) await terminate(lease, "Browser opening failed.");
        send({ type: `${PREFIX}open-result`, requestId: message.requestId, ok: false, error: "The embedded browser could not open." });
      }
      return true;
    }
    const lease = leases.get(message.leaseId);
    if (!lease || lease.closed || message.generation !== lease.generation) return true;
    if (message.type === `${PREFIX}release`) { await terminate(lease, "The browser was released."); return true; }
    let command;
    try { if (typeof message.message !== "string" || Buffer.byteLength(message.message) > MAX_MESSAGE) throw fail("Invalid CDP message."); command = JSON.parse(message.message); }
    catch { await terminate(lease, "Invalid CDP message."); return true; }
    if (!object(command) || !Number.isSafeInteger(command.id) || command.id < 0 || typeof command.method !== "string" || command.method.length > 128 || command.params !== undefined && !object(command.params) || command.sessionId !== undefined && typeof command.sessionId !== "string") { await terminate(lease, "Invalid CDP command."); return true; }
    if (lease.pending.has(command.id) || lease.pending.size >= MAX_PENDING) { await terminate(lease, "The browser command queue exceeded its limit."); return true; }
    lease.pending.add(command.id);
    try {
      if (lease.saveError && command.method !== "Browser.close") throw fail("The browser tab state could not be saved.", -32000);
      const result = command.sessionId ? await sessionCommand(lease, ownedRoute(lease, command.sessionId), command.method, command.params ?? {}) : await rootCommand(lease, command.method, command.params ?? {});
      post(lease, { id: command.id, result: result ?? {} });
      if (!command.sessionId && command.method === "Browser.close") await terminate(lease, "The browser was closed.");
    } catch (error) { post(lease, { id: command.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.code ? error.message : "The scoped browser command failed." } }); }
    finally { lease.pending.delete(command.id); }
    return true;
  }
  return {
    receive,
    async closeLeases() { await Promise.all([...closingProfiles.values(), ...[...leases.values()].map(lease => terminate(lease, "The browser views were closed."))]); },
    async activateTarget(profileKey, targetId) {
      const lease = [...leases.values()].find(candidate => candidate.key === profileKey && !candidate.closed);
      const target = lease?.targets.get(targetId);
      if (!target) return false;
      await activateTarget(lease, target);
      return true;
    },
    async close() { closed = true; await Promise.all([...closingProfiles.values(), ...[...leases.values()].map(lease => terminate(lease, "The desktop connection closed."))]); },
  };
}
