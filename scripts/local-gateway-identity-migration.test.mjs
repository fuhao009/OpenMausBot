import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATEWAY_D1_IDENTITY, GATEWAY_LABEL, LEGACY_GATEWAY_LABEL, assertLegacyGatewayRetired, migrateGatewayIdentity } from "./local-gateway/identity-migration.mjs";

test("gateway branding retains the durable D1 identity", () => {
  assert.equal(GATEWAY_LABEL, "com.hezuo.gateway");
  assert.notEqual(GATEWAY_D1_IDENTITY, "hezuo-local-gateway");
});

test("legacy service safety fails closed without printing launchctl output", () => {
  const home = mkdtempSync(path.join(tmpdir(), "gateway-identity-"));
  try {
    for (const status of [0, 1, null]) {
      assert.throws(() => assertLegacyGatewayRetired({ home, platform: "darwin", run: () => ({ status, stdout: "sensitive", stderr: "sensitive" }) }), /cannot be established/);
    }
    assert.doesNotThrow(() => assertLegacyGatewayRetired({ home, platform: "darwin", run: () => ({ status: 113 }) }));
    const agents = path.join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, `${LEGACY_GATEWAY_LABEL}.plist`), "installed");
    assert.throws(() => assertLegacyGatewayRetired({ home, platform: "darwin", run: () => { throw new Error("must not query"); } }), /Retire/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("offline migration refuses an existing destination without touching state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gateway-identity-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "HezuoGateway");
    mkdirSync(source);
    mkdirSync(destination);
    const configPath = path.join(source, "gateway.json");
    const original = JSON.stringify({ version: 1, dataDir: source, host: "127.0.0.1", port: 18487 });
    writeFileSync(configPath, original, { mode: 0o600 });
    await assert.rejects(migrateGatewayIdentity({ configPath, destination }), /already exists/);
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline move retains D1 bytes, secrets, certificate and origin", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gateway-identity-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "HezuoGateway");
    for (const dir of ["state", "secrets", "tls"]) mkdirSync(path.join(source, dir), { recursive: true });
    const files = { "state/store.sqlite": "database", "state/store.sqlite-wal": "wal", "secrets/better-auth-secret": "auth", "secrets/upstream-key": "key", "tls/gateway-cert.pem": "cert", "tls/gateway-key.pem": "private" };
    for (const [file, value] of Object.entries(files)) writeFileSync(path.join(source, file), value, { mode: 0o600 });
    const configPath = path.join(source, "gateway.json");
    const config = { version: 1, dataDir: source, host: "127.0.0.1", port: 0, publicHost: "127.0.0.1", certFile: path.join(source, "tls/gateway-cert.pem"), keyFile: path.join(source, "tls/gateway-key.pem"), openModelsFile: "/external/models.yml" };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const result = await migrateGatewayIdentity({ configPath, destination, home: root, platform: "darwin", run: () => ({ status: 113 }) });
    for (const [file, value] of Object.entries(files)) assert.equal(readFileSync(path.join(destination, file), "utf8"), value);
    const moved = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(moved, { ...config, dataDir: destination, certFile: path.join(destination, "tls/gateway-cert.pem"), keyFile: path.join(destination, "tls/gateway-key.pem") });
    assert.equal(result.serviceInstalled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
