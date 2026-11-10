import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { migrateProductProfile } from "./product-profile-migration.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";

// Migration fixtures deliberately retain predecessor storage/protocol names.
const OLD = "OpenMausBot Product";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hezuo-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = Object.assign(new EventEmitter(), {
    paths: { appData: root }, name: "Hezuo", locked: false,
    getPath(key) { return this.paths[key]; },
    setPath(key, value) { this.paths[key] = value; },
    setName(value) { this.name = value; },
    requestSingleInstanceLock() { this.locked = true; return true; },
    releaseSingleInstanceLock() { this.locked = false; },
  });
  return { root, app, source: path.join(root, OLD), destination: path.join(root, "Hezuo Product") };
}

test("moves complete profile without decoding login, preserves partitions and encryption identity across restarts", t => {
  const { app, source, destination } = fixture(t);
  const partition = "Partitions/product-account";
  fs.mkdirSync(path.join(source, partition), { recursive: true });
  const unreadable = Buffer.from([0, 255, 17, 43]);
  fs.writeFileSync(path.join(source, "product-account.bin"), unreadable);
  fs.writeFileSync(path.join(source, partition, "Cookies"), "session");
  assert.deepEqual(migrateProductProfile({ app, isProduct: true }), { directory: destination, legacyEncryption: true });
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readFileSync(path.join(destination, "product-account.bin")), unreadable);
  assert.equal(fs.readFileSync(path.join(destination, partition, "Cookies"), "utf8"), "session");
  assert.equal(app.paths.userData, destination);
  assert.equal(app.paths.sessionData, destination);
  assert.equal(app.name, OLD);
  app.emit("ready");
  assert.equal(app.name, "Hezuo Product");
  assert.equal(migrateProductProfile({ app, isProduct: true }).legacyEncryption, true);
  assert.equal(app.name, OLD);
  app.emit("ready");
  assert.equal(app.name, "Hezuo Product");
});

test("fresh Product uses new encryption identity; standard and fixtures are untouched", t => {
  const { app, root } = fixture(t);
  assert.equal(migrateProductProfile({ app, isProduct: false }), null);
  assert.equal(migrateProductProfile({ app, isProduct: true, fixture: true }), null);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(migrateProductProfile({ app, isProduct: true }).legacyEncryption, false);
  assert.equal(app.name, "Hezuo Product");
});

test("existing destination is never merged or overwritten", t => {
  const { app, source, destination } = fixture(t);
  fs.mkdirSync(source); fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, "old"), "old");
  fs.writeFileSync(path.join(destination, "new"), "new");
  assert.throws(() => migrateProductProfile({ app, isProduct: true }), /refusing to merge/);
  assert.deepEqual(fs.readdirSync(source), ["old"]);
  assert.deepEqual(fs.readdirSync(destination), ["new"]);
});

test("running previous desktop prevents move", t => {
  const { app, source, destination } = fixture(t);
  fs.mkdirSync(source);
  app.requestSingleInstanceLock = () => false;
  assert.throws(() => migrateProductProfile({ app, isProduct: true }), /Close the previous/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);
});

function oldLease(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "openmausbot-server.lease"), JSON.stringify({
    version: 1, pid: process.pid, host: os.hostname(), token: randomUUID(), createdAt: Date.now(),
  }));
}

test("live legacy account server blocks migration and leaves login intact", t => {
  const { app, source, destination } = fixture(t);
  oldLease(path.join(source, "product-accounts", "account", "workspace"));
  fs.writeFileSync(path.join(source, "product-account.bin"), "unreadable");
  assert.throws(() => migrateProductProfile({ app, isProduct: true }), /previous desktop\/server/);
  assert.equal(fs.readFileSync(path.join(source, "product-account.bin"), "utf8"), "unreadable");
  assert.equal(fs.existsSync(destination), false);
  assert.equal(app.locked, false);
});

test("renamed server cannot bypass a live legacy owner or delegated child", t => {
  const { root } = fixture(t);
  oldLease(root);
  assert.throws(() => acquireDataDirLease(root), /previous desktop\/server/);
  fs.unlinkSync(path.join(root, "openmausbot-server.lease"));
  oldLease(path.join(root, ".openmausbot-server-child"));
  assert.throws(() => acquireDataDirLease(root), /previous desktop\/server/);
  assert.equal(fs.existsSync(path.join(root, "hezuo-server.lease")), false);
});
