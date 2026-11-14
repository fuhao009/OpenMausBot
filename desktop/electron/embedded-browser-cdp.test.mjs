import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedBrowserBroker } from "./embedded-browser-cdp.mjs";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function fixture(restoreTabs) {
  const dir = mkdtempSync(join(tmpdir(), "embedded-cdp-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const messages = [], views = [], resources = new Map();
  const version = { product: "Chrome/150.0.0.0", userAgent: "fixture", revision: "fixture", protocolVersion: "1.3" };
  const sessionFor = vi.fn(async key => {
    const session = new EventEmitter();
    Object.assign(session, { setPermissionCheckHandler: vi.fn(fn => { session.check = fn; }), setPermissionRequestHandler: vi.fn(fn => { session.request = fn; }), setDevicePermissionHandler: vi.fn(), closeAllConnections: vi.fn(async () => {}), flushStorageData: vi.fn(), cookies: { flushStore: vi.fn(async () => {}), get: vi.fn(async () => []), set: vi.fn(async () => {}) }, clearStorageData: vi.fn(async () => {}) });
    const value = { session, downloadDir: join(dir, key), release: vi.fn(), restoreTabs, saveTabs: vi.fn(async () => {}) };
    resources.set(key, value); return value;
  });
  let serial = 0;
  const createView = vi.fn(async options => {
    const id = `target-${++serial}`;
    const wc = new EventEmitter(), dbg = new EventEmitter();
    let dead = false, url = "about:blank", bounds = { x: 0, y: 0, ...options.viewport };
    Object.assign(wc, { session: options.session, debugger: dbg, getURL: () => url, getTitle: () => "fixture", isDestroyed: () => dead, setWebRTCIPHandlingPolicy: vi.fn(), loadURL: vi.fn(async next => { url = next; wc.emit("did-navigate"); }) });
    let attached = false;
    Object.assign(dbg, { attach: vi.fn(() => { attached = true; }), isAttached: () => attached, detach: vi.fn(() => { attached = false; dbg.emit("detach", {}, "closed"); }), sendCommand: vi.fn(async (method, params, sessionId) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: id, type: "page", browserContextId: `context-${options.profileKey}` } };
      if (method === "Target.attachToTarget") { const sessionId = `native-${id}`; dbg.emit("message", {}, "Target.attachedToTarget", { sessionId, targetInfo: { targetId: id, type: "page", browserContextId: `context-${options.profileKey}` } }, ""); return { sessionId }; }
      if (method === "Target.detachFromTarget") dbg.emit("message", {}, "Target.detachedFromTarget", { sessionId: params.sessionId }, "");
      return { method, params, sessionId };
    }) });
    const view = { webContents: wc, getBounds: () => bounds, setBounds: vi.fn(next => { bounds = next; }), destroy: () => { dead = true; wc.emit("destroyed"); } };
    views.push(view); return view;
  });
  const activate = vi.fn(async () => {});
  const broker = createEmbeddedBrowserBroker({ sessionFor, createView, activate, closeView: async view => view.destroy(), send: message => messages.push(message), version });
  cleanups.push(() => broker.close());
  let nextId = 0;
  const open = async (profileKey = "one", fresh = true) => { await broker.receive({ type: "hezuo:embedded-browser-open", requestId: profileKey, profileKey, fresh, egressPort: 45123, viewport: { width: 640, height: 480 } }); return messages.find(m => m.type === "hezuo:embedded-browser-open-result" && m.requestId === profileKey); };
  const command = async (lease, method, params = {}, sessionId) => {
    const id = ++nextId;
    await broker.receive({ type: "hezuo:embedded-browser-cdp", leaseId: lease.leaseId, generation: lease.generation, message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) });
    return messages.filter(m => m.type === "hezuo:embedded-browser-cdp").map(m => JSON.parse(m.message)).find(m => m.id === id);
  };
  const events = method => messages.filter(m => m.type === "hezuo:embedded-browser-cdp").map(m => JSON.parse(m.message)).filter(m => m.method === method);
  const attach = async lease => { await command(lease, "Target.setAutoAttach", { autoAttach: true, flatten: true }); return events("Target.attachedToTarget").at(-1).params.sessionId; };
  return { broker, open, command, events, attach, messages, resources, views, activate, version };
}

describe("embedded profile-scoped CDP broker", () => {
  it("initializes a real owned target contract and routes primary, secondary and OOPIF sessions independently", async () => {
    const f = fixture(), lease = await f.open();
    expect(lease.ok).toBe(true);
    expect(typeof lease.generation).toBe("string");
    const primary = await f.attach(lease);
    expect((await f.command(lease, "Runtime.evaluate", { expression: "1" }, primary)).result.sessionId).toBeUndefined();
    const secondary = (await f.command(lease, "Target.attachToTarget", { targetId: "target-1", flatten: true })).result.sessionId;
    expect(f.events("Target.attachedToTarget").at(-1).sessionId).toBeUndefined();
    expect((await f.command(lease, "Runtime.evaluate", { expression: "2" }, secondary)).result.sessionId).toBe("native-target-1");
    f.views[0].webContents.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "frame-native", targetInfo: { targetId: "frame-1", type: "iframe", browserContextId: "context-one" } }, "");
    const frame = f.events("Target.attachedToTarget").at(-1);
    expect(frame.sessionId).toBe(primary);
    expect((await f.command(lease, "Runtime.evaluate", { expression: "3" }, frame.params.sessionId)).result.sessionId).toBe("frame-native");
    await f.command(lease, "Target.detachFromTarget", { sessionId: secondary });
    expect((await f.command(lease, "Runtime.evaluate", { expression: "4" }, secondary)).error).toBeDefined();
    expect((await f.command(lease, "Runtime.evaluate", { expression: "5" }, primary)).result).toBeDefined();
  });

  it("never exposes or dispatches foreign targets, sessions, contexts or native page attachments", async () => {
    const f = fixture(), one = await f.open("one"), two = await f.open("two");
    await f.attach(one); const twoSession = await f.attach(two);
    expect((await f.command(one, "Target.getTargets", { filter: [{}] })).result.targetInfos.map(t => t.targetId)).toEqual(["target-1"]);
    for (const [method, params, session] of [
      ["Target.attachToTarget", { targetId: "target-2", flatten: true }],
      ["Target.closeTarget", { targetId: "target-2" }],
      ["Runtime.evaluate", { expression: "1" }, twoSession],
      ["Storage.getCookies", { browserContextId: "context-two" }],
      ["SystemInfo.getInfo", {}],
    ]) expect((await f.command(one, method, params, session)).error).toBeDefined();
    const before = f.events("Target.attachedToTarget").length;
    f.views[0].webContents.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "foreign", targetInfo: { targetId: "owner-ui", type: "page" } }, "");
    expect(f.events("Target.attachedToTarget")).toHaveLength(before);
  });

  it("binds Browser window actions, permission state and Storage operations to the owned session", async () => {
    const f = fixture(), lease = await f.open();
    const primary = await f.attach(lease);
    await f.command(lease, "Page.bringToFront", {}, primary);
    expect(f.activate).toHaveBeenCalledWith(f.views[0]);
    const window = (await f.command(lease, "Browser.getWindowForTarget", { targetId: "target-1" })).result;
    await f.command(lease, "Browser.setWindowBounds", { windowId: window.windowId, bounds: { width: 700 } });
    expect(f.views[0].getBounds().width).toBe(700);
    expect((await f.command(lease, "Browser.setWindowBounds", { windowId: window.windowId, bounds: { left: 100 } })).error).toBeDefined();
    await f.command(lease, "Browser.setPermission", { permission: { name: "notifications" }, setting: "granted", origin: "https://example.test" });
    expect(f.resources.get("one").session.check(f.views[0].webContents, "notifications", "https://example.test", {})).toBe(true);
    await f.command(lease, "Browser.resetPermissions");
    expect(f.resources.get("one").session.check(f.views[0].webContents, "notifications", "https://example.test", {})).toBe(false);
    const cookies = await f.command(lease, "Storage.getCookies");
    expect(cookies.result.cookies).toEqual([]);
    expect(f.resources.get("one").session.cookies.get).toHaveBeenCalledWith({});
    await f.command(lease, "Storage.clearDataForOrigin", { origin: "https://example.test", storageTypes: "cookies,local_storage" });
    expect(f.resources.get("one").session.clearStorageData).toHaveBeenCalledWith({ origin: "https://example.test", storages: ["cookies", "localstorage"] });
  });

  it("tracks only owned downloads under the approved directory and cancels by owned GUID", async () => {
    const f = fixture(), lease = await f.open();
    await f.attach(lease);
    expect((await f.command(lease, "Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/arbitrary", eventsEnabled: true })).error).toBeDefined();
    const resources = f.resources.get("one");
    await f.command(lease, "Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: resources.downloadDir, eventsEnabled: true });
    const item = new EventEmitter();
    Object.assign(item, { setSavePath: vi.fn(), getURL: () => "https://example.test/file", getFilename: () => "file.txt", getReceivedBytes: () => 12, getTotalBytes: () => 12, cancel: vi.fn() });
    resources.session.emit("will-download", {}, item, f.views[0].webContents);
    const begin = f.events("Browser.downloadWillBegin").at(-1).params;
    expect(begin.frameId).toBe("target-1");
    expect(item.setSavePath).toHaveBeenCalledWith(join(resources.downloadDir, begin.guid));
    await f.command(lease, "Browser.cancelDownload", { guid: begin.guid });
    expect(item.cancel).toHaveBeenCalledTimes(1);
    item.emit("done", {}, "completed");
    expect(f.events("Browser.downloadProgress").at(-1).params).toMatchObject({ state: "completed", filePath: join(resources.downloadDir, begin.guid) });
    expect((await f.command(lease, "Browser.cancelDownload", { guid: "foreign" })).error).toBeDefined();
  });

  it("restores safe tab URLs and active selection, while fresh clears the manifest without deleting cookies", async () => {
    const saved = { urls: ["https://one.test/", "https://two.test/", "file:///private/secret"], active: 1 };
    const f = fixture(saved), lease = await f.open("one", false);
    expect(lease.ok).toBe(true);
    expect(f.views.map(view => view.webContents.getURL())).toEqual(saved.urls.slice(0, 2));
    expect(f.activate).toHaveBeenLastCalledWith(f.views[1]);
    expect(f.resources.get("one").saveTabs).toHaveBeenLastCalledWith({ urls: saved.urls.slice(0, 2), active: 1 });
    await f.broker.receive({ type: "hezuo:embedded-browser-release", leaseId: lease.leaseId, generation: lease.generation });
    expect(f.resources.get("one").saveTabs).toHaveBeenLastCalledWith({ urls: saved.urls.slice(0, 2), active: 1 });
    const fresh = fixture(saved);
    await fresh.open("fresh", true);
    expect(fresh.views.map(view => view.webContents.getURL())).toEqual(["about:blank"]);
    expect(fresh.resources.get("fresh").saveTabs).toHaveBeenNthCalledWith(1, { urls: [], active: 0 });
    expect(fresh.resources.get("fresh").session.clearStorageData).not.toHaveBeenCalled();
  });

  it("waits for the previous profile release before accepting an immediate reopen", async () => {
    const f = fixture(), lease = await f.open();
    let release;
    const released = new Promise(resolve => { release = resolve; });
    f.resources.get("one").release.mockImplementation(() => released);
    const closing = f.broker.receive({ type: "hezuo:embedded-browser-release", leaseId: lease.leaseId, generation: lease.generation });
    const reopening = f.broker.receive({ type: "hezuo:embedded-browser-open", requestId: "restart", profileKey: "one", fresh: false, egressPort: 45123, viewport: { width: 640, height: 480 } });
    await Promise.resolve();
    expect(f.messages.some(message => message.requestId === "restart")).toBe(false);
    release();
    await Promise.all([closing, reopening]);
    const result = f.messages.find(message => message.requestId === "restart");
    expect(result.ok).toBe(true);
    expect(result.leaseId).not.toBe(lease.leaseId);
    const closedIndex = f.messages.findIndex(message => message.type === "hezuo:embedded-browser-closed" && message.leaseId === lease.leaseId);
    expect(closedIndex).toBeLessThan(f.messages.indexOf(result));
  });

  it("rejects malformed transport input and ignores stale generations", async () => {
    const f = fixture(), lease = await f.open();
    const length = f.messages.length;
    await f.broker.receive({ type: "hezuo:embedded-browser-release", leaseId: lease.leaseId, generation: "stale" });
    expect(f.messages).toHaveLength(length);
    await f.broker.receive({ type: "hezuo:embedded-browser-cdp", leaseId: lease.leaseId, generation: lease.generation, message: "{" });
    expect(f.messages.at(-1)).toMatchObject({ type: "hezuo:embedded-browser-closed", leaseId: lease.leaseId });
    expect(f.views[0].webContents.isDestroyed()).toBe(true);
  });
});
