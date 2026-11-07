import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCompanionStorage, sidecarEnvironment } from "./companion-storage.mjs";

const folder = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omb-companion-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test("without a configured root the settings stay in userData, exactly as before product accounts", async t => {
  const userData = await folder(t);
  const storage = createCompanionStorage({ userData: () => userData });
  assert.equal(storage.enabledAtRest(), false);
  assert.equal(storage.sidecarDirectory(), null, "the sidecar keeps its own default folder");
  storage.rememberEnabled(true); storage.rememberKeepAwake(true);
  assert.deepEqual(JSON.parse(await readFile(path.join(userData, "companion-settings.json"), "utf8")), { enabled: true, keepAwake: true });
  assert.equal(storage.enabledAtRest(), true);
});

test("a configured account root keeps its own settings and its own paired fleet, never userData's", async t => {
  const userData = await folder(t), account = path.join(await folder(t), "product-accounts", "abc123");
  const storage = createCompanionStorage({ userData: () => userData });
  storage.rememberEnabled(true);
  storage.configure(account);
  assert.deepEqual(storage.sidecarDirectory(), path.join(account, "companion"));
  assert.equal(storage.enabledAtRest(), false, "another account's switch is not this account's");
  storage.rememberKeepAwake(true);
  assert.deepEqual(JSON.parse(await readFile(path.join(account, "companion-settings.json"), "utf8")), { enabled: false, keepAwake: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(userData, "companion-settings.json"), "utf8")), { enabled: true, keepAwake: false },
    "the previous account's record is untouched");
  storage.configure(null);
  assert.equal(storage.enabledAtRest(), true, "back to the app's own record");
  assert.equal(storage.sidecarDirectory(), null);
});

test("a running sidecar refuses a storage change, and only absolute roots are accepted", async t => {
  const userData = await folder(t);
  let busy = false;
  const storage = createCompanionStorage({ userData: () => userData, busy: () => busy });
  storage.configure(path.join(userData, "one"));
  busy = true;
  assert.throws(() => storage.configure(path.join(userData, "two")), /Stop the companion/);
  assert.deepEqual(storage.sidecarDirectory(), path.join(userData, "one", "companion"), "the refused change kept the old folder");
  busy = false;
  for (const bad of ["relative/companion", "", "a\0b"]) assert.throws(() => storage.configure(bad), /absolute path/);
  storage.configure(undefined); assert.equal(storage.sidecarDirectory(), null, "an omitted root resets to the app's own record");
});

test("an unreadable settings record reads as off, and a failed save leaves the old file alone", async t => {
  const root = await folder(t);
  const storage = createCompanionStorage({ userData: () => root });
  await writeFile(path.join(root, "companion-settings.json"), "{not json");
  assert.equal(storage.enabledAtRest(), false);
  assert.equal(storage.keepAwakeAtRest(), false);
  storage.rememberEnabled(true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "companion-settings.json"), "utf8")), { enabled: true, keepAwake: false });
});

test("the sidecar environment never inherits endpoints and an account folder beats an inherited paired-fleet folder", () => {
  const base = { HOME: "/home/person", PATH: "/bin", OMB_COMPANION_DIR: "/home/person/.openmausbot-companion",
    OMB_COMPANION_HOSTED_URL: "https://other.example.test", OMB_COMPANION_INTERNAL_ORIGIN: "/tmp/other.sock", OMB_PHONE_SECRET_PUBLIC_KEY: "leak" };
  const configured = sidecarEnvironment({ base, directory: "/accounts/abc/companion", internalOrigin: "/tmp/own.sock",
    hostedUrl: "https://own.example.test", secretPublicKey: "A".repeat(87) });
  assert.equal(configured.OMB_COMPANION_DIR, "/accounts/abc/companion");
  assert.equal(configured.OMB_COMPANION_INTERNAL_ORIGIN, "/tmp/own.sock");
  assert.equal(configured.OMB_COMPANION_HOSTED_URL, "https://own.example.test");
  assert.equal(configured.OMB_PHONE_SECRET_PUBLIC_KEY, "A".repeat(87));
  assert.equal(configured.HOME, "/home/person", "HOME stays: the sidecar only reads it to find Tailscale");
  assert.equal(base.OMB_COMPANION_DIR, "/home/person/.openmausbot-companion", "the parent environment is not mutated");

  const unconfigured = sidecarEnvironment({ base, internalOrigin: "/tmp/own.sock" });
  assert.equal(unconfigured.OMB_COMPANION_DIR, "/home/person/.openmausbot-companion", "no configured root keeps previous behaviour");
  assert.equal("OMB_COMPANION_HOSTED_URL" in unconfigured, false);
  assert.equal(unconfigured.OMB_COMPANION_INTERNAL_ORIGIN, "/tmp/own.sock", "the inherited endpoint is replaced, never kept");
  assert.equal("OMB_PHONE_SECRET_PUBLIC_KEY" in unconfigured, false);

  const shortKey = sidecarEnvironment({ base, secretPublicKey: "short" });
  assert.equal("OMB_PHONE_SECRET_PUBLIC_KEY" in shortKey, false);
});
