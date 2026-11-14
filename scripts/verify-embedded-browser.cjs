const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { app, BrowserWindow, WebContentsView, session, desktopCapturer } = require("electron");
const { createEmbeddedBrowserSurfaceManager, embeddedBrowserPartition } = require("../desktop/electron/embedded-browser-surface.mjs");
const { createEmbeddedBrowserBroker } = require("../desktop/electron/embedded-browser-cdp.mjs");
const { createEmbeddedBrowserBackend } = require("../desktop/server/browser/embedded-backend.ts");
const { BrowserService } = require("../desktop/server/browser/service.ts");
const output = process.argv[2];
const { browserRoot, profileHash, workspaceId } = require("../desktop/server/browser/chrome/profile.ts");
const dataDir = mkdtempSync(join(tmpdir(), "embedded-browser-data-"));
const steps = [];
app.setPath("userData", dataDir);
app.setPath("home", dataDir);
async function step(name, run) {
  const start = performance.now();
  try { const detail = await run(); steps.push({ name, elapsedMs: Math.round(performance.now() - start), ok: true, detail }); }
  catch (error) { steps.push({ name, elapsedMs: Math.round(performance.now() - start), ok: false, error: String(error.message) }); throw error; }
}
let manager, broker, backend, service, owner;
const watchdog = setTimeout(() => { console.error("Embedded browser verification timed out"); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true });
  owner = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  await owner.loadURL("data:text/html,<title>Embedded browser isolation verification</title><body>Owner UI must never be a browser target</body>");
  const nativeViews = [];
  manager = createEmbeddedBrowserSurfaceManager({ owner, createNativeView: options => { const view = new WebContentsView(options); nativeViews.push(view); return view; },
    createFallbackWindow: () => new BrowserWindow({ show: true, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true } }), onFallbackClose: () => { void broker.close(); } });
  let primary;
  broker = createEmbeddedBrowserBroker({
    createView: async options => { const view = await manager.createView(options); primary ??= view; return view; },
    sessionFor: async key => ({ session: session.fromPartition(embeddedBrowserPartition("fixture", key)), downloadDir: join(browserRoot(dataDir), "downloads", profileHash(workspaceId(dataDir), key)) }),
    send: message => backend.receive(message), version: { product: `Chrome/${process.versions.chrome}`, protocolVersion: "1.3", userAgent: "EmbeddedVerification", jsVersion: process.versions.v8, revision: "fixture" },
    activate: view => manager.activate(view), closeView: view => manager.closeView(view),
  });
  backend = createEmbeddedBrowserBackend({ send: message => { void broker.receive(message); }, egressPort: async () => 1 });
  service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 60000 });
  const target = { session: "fixture-bot", key: "bot:fixture" };
  const binding = { surfaceId: "fixture-surface", revision: 1, accountKey: "fixture", profileKey: target.key };
  const call = async (name, args) => {
    const result = await service.agentRpc(target, "tools/call", { name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result)); return result;
  };
  const nonce = randomUUID();
  await step("real backend opens random nonce page", async () => {
    const url = `data:text/html,${encodeURIComponent(`<h1>${nonce}</h1><input id="field"><button id="hit" onclick="document.querySelector('h1').textContent='clicked-'+document.querySelector('input').value">Apply</button>`)}`;
    await call("agent_browser_open", { url });
    manager.attach(binding); manager.layout({ ...binding, bounds: { x: 20, y: 80, width: 1000, height: 600 }, visible: true });
    assert.equal(await primary.webContents.executeJavaScript("document.querySelector('h1').textContent"), nonce);
  });
  let viewer;
  await step("viewer attaches without changing primary document", async () => {
    viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 800 }, event => { if (event.type === "frame") event.ack(); });
    assert.equal(await primary.webContents.executeJavaScript("document.querySelector('h1').textContent"), nonce);
  });
  await step("CDP fill and click work beneath visible shield", async () => {
    await call("agent_browser_fill", { selector: "#field", text: "verified" });
    await call("agent_browser_click", { selector: "#hit" });
    assert.equal(await primary.webContents.executeJavaScript("document.querySelector('h1').textContent"), "clicked-verified");
  });
  await step("native shield absorbs human input", async () => {
    const shield = nativeViews.find(view => view !== primary && view.webContents.getURL().startsWith("data:text/html,<html"));
    assert.ok(shield);
    const before = await primary.webContents.executeJavaScript("document.querySelector('h1').textContent");
    shield.webContents.focus();
    shield.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 20, button: "left", clickCount: 1 });
    shield.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 20, button: "left", clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await primary.webContents.executeJavaScript("document.querySelector('h1').textContent"), before);
  });
  await step("human hold blocks bot and grants native focus", async () => {
    await viewer.input({ type: "takeControl" }); manager.setInteractive(binding, true); manager.focus(binding);
    await assert.rejects(service.agentRpc(target, "tools/call", { name: "agent_browser_snapshot", arguments: {} }), /paused while a person controls/);
    await viewer.input({ type: "releaseControl" }); manager.setInteractive(binding, false);
    await call("agent_browser_snapshot", {});
  });
  await step("separate profile cannot see nonce document", async () => {
    const other = { session: "other-bot", key: "bot:other" };
    const result = await service.agentRpc(other, "tools/call", { name: "agent_browser_eval", arguments: { expression: "document.documentElement.textContent" } });
    assert.ok(!JSON.stringify(result).includes(nonce));
  });
  await step("real composite window and native page screenshots", async () => {
    assert.equal(primary.getVisible(), true, "bound profile remains visible after another profile opens");
    assert.ok(owner.contentView.children.includes(primary), "bound page is attached to the owner window");
    const bounds = primary.getBounds();
    assert.deepEqual(bounds, { x: 20, y: 80, width: 1000, height: 600 });
    assert.equal(await primary.webContents.executeJavaScript("document.querySelector('h1').textContent"), "clicked-verified");
    const page = await primary.webContents.capturePage();
    assert.ok(!page.isEmpty());
    writeFileSync(join(output, "embedded-page.png"), page.toPNG());
    owner.show(); owner.focus();
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1100, height: 800 } });
    const source = sources.find(item => item.id === owner.getMediaSourceId());
    assert.ok(source && !source.thumbnail.isEmpty(), "OS composite capture of actual owner window is available");
    writeFileSync(join(output, "embedded-visible.png"), source.thumbnail.toPNG());
    return { visible: primary.getVisible(), bounds, capture: "desktopCapturer window composite" };
  });
  await step("viewer close and browser restart", async () => { await viewer.close(); await call("restart_browser", {}); await call("agent_browser_snapshot", {}); });
}).then(async () => {
  await service?.closeAll(); await broker?.close(); backend?.close(); await manager?.dispose(); owner?.destroy();
  clearTimeout(watchdog);
  writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, steps }, null, 2)); rmSync(dataDir, { recursive: true, force: true }); app.exit(0);
}).catch(async error => {
  console.error(error); writeFileSync(join(output, "result.json"), JSON.stringify({ ok: false, steps, error: String(error.message) }, null, 2));
  clearTimeout(watchdog);
  await broker?.close().catch(() => {}); owner?.destroy(); rmSync(dataDir, { recursive: true, force: true }); app.exit(1);
});
