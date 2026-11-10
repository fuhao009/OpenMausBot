import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateDefaultDataRoot } from "./default-data-root-migration.mjs";

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hezuo-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Previous names below are migration fixtures, not current defaults.
for (const predecessor of [".openmausbot", ".opengrokbot"]) {
  test(`moves ${predecessor} completely and is idempotent`, t => {
    const root = home(t), old = path.join(root, predecessor);
    fs.mkdirSync(path.join(old, "events"), { recursive: true });
    fs.writeFileSync(path.join(old, "events", "history"), "history");
    const destination = migrateDefaultDataRoot(root);
    assert.equal(destination, path.join(root, ".hezuo"));
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readFileSync(path.join(destination, "events", "history"), "utf8"), "history");
    assert.equal(migrateDefaultDataRoot(root), destination);
  });
}

test("explicit directory, including empty override, never migrates", t => {
  const root = home(t);
  fs.mkdirSync(path.join(root, ".openmausbot"));
  assert.equal(migrateDefaultDataRoot(root, ""), "");
  assert.equal(migrateDefaultDataRoot(root, "/configured"), "/configured");
  assert.deepEqual(fs.readdirSync(root), [".openmausbot"]);
});

test("conflicting destination or multiple predecessors refuse without modifying data", t => {
  const root = home(t);
  fs.mkdirSync(path.join(root, ".openmausbot"));
  fs.mkdirSync(path.join(root, ".hezuo"));
  assert.throws(() => migrateDefaultDataRoot(root), /Conflicting/);
  fs.rmdirSync(path.join(root, ".hezuo"));
  fs.mkdirSync(path.join(root, ".opengrokbot"));
  assert.throws(() => migrateDefaultDataRoot(root), /Conflicting/);
  assert.deepEqual(fs.readdirSync(root).sort(), [".opengrokbot", ".openmausbot"].sort());
});

test("a running legacy server prevents root move", t => {
  const root = home(t), old = path.join(root, ".openmausbot");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "openmausbot-server.lease"), JSON.stringify({
    version: 1, pid: process.pid, host: os.hostname(), token: randomUUID(), createdAt: Date.now(),
  }));
  assert.throws(() => migrateDefaultDataRoot(root), /previous desktop\/server/);
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.existsSync(path.join(root, ".hezuo")), false);
});
