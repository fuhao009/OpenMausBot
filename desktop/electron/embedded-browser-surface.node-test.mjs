import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createEmbeddedBrowserSurfaceManager, embeddedBrowserPartition } from "./embedded-browser-surface.mjs";

function fixture() {
  const children = [];
  const created = [];
  const owner = { isDestroyed: () => false, getContentSize: () => [1000, 800], webContents: { getZoomFactor: () => 2 },
    contentView: { addChildView(view) { children.push(view); }, removeChildView(view) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); } } };
  const manager = createEmbeddedBrowserSurfaceManager({ owner, createNativeView(options) {
    const contents = new EventEmitter();
    Object.assign(contents, { isDestroyed: () => false, isFocused: () => false, focus() { this.focused = true; },
      loadURL: async () => {}, setWindowOpenHandler(handler) { this.openHandler = handler; }, close() { this.emit("destroyed"); } });
    const view = { options, webContents: contents, setBounds(bounds) { this.bounds = bounds; }, getBounds() { return this.bounds; },
      setVisible(value) { this.visible = value; }, setBackgroundColor(value) { this.background = value; } };
    created.push(view); return view;
  } });
  return { manager, created, children };
}

test("model view stays visible behind a separate input shield until the exact server grant", async () => {
  const { manager, created } = fixture();
  const view = await manager.createView({ profileKey: "a", session: {}, viewport: { width: 1280, height: 800 } });
  const binding = { surfaceId: "one", revision: 1, accountKey: "account", profileKey: "a" };
  manager.attach(binding);
  manager.layout({ ...binding, bounds: { x: 10, y: 20, width: 100, height: 200 }, visible: true });
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 20, y: 40, width: 200, height: 400 });
  const shield = created[1];
  assert.equal(shield.visible, true);
  assert.equal(shield.background, "#00000000");
  manager.setInteractive({ ...binding, revision: 0 }, true);
  assert.equal(shield.visible, true);
  manager.setInteractive(binding, true);
  assert.equal(shield.visible, false);
  manager.focus(binding);
  assert.equal(view.webContents.focused, true);
  manager.setHidden(binding, true);
  manager.layout({ ...binding, bounds: { x: 10, y: 20, width: 100, height: 200 }, visible: true });
  assert.equal(view.visible, false);
  assert.equal(shield.visible, false);
  manager.setHidden(binding, false);
  assert.equal(view.visible, true);
  assert.equal(shield.visible, true);
  manager.detach(binding);
  assert.equal(view.visible, false);
  await manager.closeAll();
});

test("stale surface operations cannot affect a replacement profile", async () => {
  const { manager } = fixture();
  const first = await manager.createView({ profileKey: "a", session: {} });
  const second = await manager.createView({ profileKey: "b", session: {} });
  const old = { surfaceId: "old", revision: 1, accountKey: "account", profileKey: "a" };
  const next = { ...old, surfaceId: "new", revision: 2, profileKey: "b" };
  manager.attach(old); manager.attach(next);
  manager.layout({ ...next, bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true });
  manager.detach(old); manager.setInteractive(old, true);
  assert.equal(first.visible, false); assert.equal(second.visible, true);
  await manager.closeAll();
});

test("browser partitions separate product accounts and profiles", () => {
  assert.notEqual(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("b", "p"));
  assert.notEqual(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("a", "q"));
  assert.equal(embeddedBrowserPartition("a", "p"), embeddedBrowserPartition("a", "p"));
});
