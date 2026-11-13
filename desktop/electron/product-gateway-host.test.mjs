import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearProductAccountTrust,
  createProductGatewayHost,
  readProductAccountTrust,
  writeProductAccountTrust,
} from "./product-gateway-host.mjs";

const dirs = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omb-gateway-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("product account trust file", () => {
  it("writes origin, public CA, and user id, and never a bearer token", () => {
    const root = scratch();
    const file = writeProductAccountTrust(root, {
      origin: "https://gateway.example:8787",
      ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      userId: "user-1",
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toMatch(/token|bearer|omb_/i);
    const stored = readProductAccountTrust(file);
    expect(stored.origin).toBe("https://gateway.example:8787");
    expect(stored.userId).toBe("user-1");
    expect(stored.ca).toContain("BEGIN CERTIFICATE");
    expect(stored.ca).toContain("MIIB");
  });

  it("rejects a missing field and can be cleared", () => {
    const root = scratch();
    const file = writeProductAccountTrust(root, {
      origin: "https://gateway.example:8787",
      ca: "CERT",
      userId: "user-1",
    });
    writeFileSync(file, JSON.stringify({ origin: "https://gateway.example:8787", userId: "user-1" }));
    expect(readProductAccountTrust(file)).toBeNull();
    clearProductAccountTrust(root);
    expect(readProductAccountTrust(file)).toBeNull();
  });
});

describe("installation credential lifecycle", () => {
  const identity = { id: "11111111-1111-4111-8111-111111111111" };
  function hostFixture() {
    const root = scratch();
    const timers = new Map();
    const calls = [];
    const changes = [];
    const tunnels = [];
    let fail = false;
    let now = 100_000;
    const account = { token: "fixture-account", user: { id: "fixture-user" } };
    const host = createProductGatewayHost({
      origin: "https://gateway.example", ca: "CERT", root,
      originTarget: { port: 1234 }, now: () => now,
      setTimer: (callback, delay) => { timers.set(callback, delay); return callback; },
      clearTimer: callback => timers.delete(callback),
      useAccount: callback => callback(account), onChange: value => changes.push(value),
      client: { ensureInstallation: async input => {
        calls.push(input);
        if (fail) throw new Error("offline");
        return { installation: identity, credential: "fixture-credential", credentialExpiresAt: now + 6 * 86_400_000 };
      } },
      createTunnel: options => {
        tunnels.push(options);
        return { start: async () => ({ status: "ready" }), stop: async () => {}, getStatus: () => ({ status: "ready" }) };
      },
    });
    return { host, account, calls, changes, tunnels, timers,
      fail: value => { fail = value; }, advance: value => { now += value; },
      tick: async () => {
        const callback = timers.keys().next().value;
        timers.delete(callback); callback();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      } };
  }

  it("renews six days before expiration and backs off a failed renewal", async () => {
    const f = hostFixture();
    await f.host.start(f.account);
    expect([...f.timers.values()]).toEqual([1000]);
    f.fail(true);
    await f.tick();
    expect(f.changes.at(-1)).toEqual({ errorCode: "installation_renewal_failed" });
    const delay = [...f.timers.values()][0];
    expect(delay).toBeGreaterThan(60_000);
    await f.tick();
    expect([...f.timers.values()][0]).toBeGreaterThan(delay);
    f.fail(false);
    await f.tick();
    expect(f.calls.at(-1).currentCredential).toBeUndefined();
    expect(f.changes.at(-1)).toEqual({ errorCode: "" });
    await f.host.stop();
    expect(f.timers.size).toBe(0);
  });

  it("stops renewal on replacement and registers a fresh identity on continue", async () => {
    const f = hostFixture();
    await f.host.start(f.account);
    const oldId = f.calls[0].clientInstanceId;
    f.tunnels.at(-1).onChange({ status: "replaced" });
    expect(f.host.isStarted()).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(f.changes.at(-1)).toEqual({ errorCode: "installation_replaced" });
    await f.host.continueHere(f.account);
    expect(f.calls.at(-1).clientInstanceId).not.toBe(oldId);
    expect(f.calls.at(-1).currentCredential).toBeUndefined();
    await f.host.stop();
  });
});
