import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { readGatewayConfig, writeConfig } from "./config.mjs";

// Persistence identity, not branding: changing it selects a different D1 store.
export const GATEWAY_D1_IDENTITY = "openmausbot-local-gateway";
export const LEGACY_GATEWAY_LABEL = "com.openmausbot.gateway";
export const GATEWAY_LABEL = "com.hezuo.gateway";
export const LEGACY_RUNTIME_DIRECTORY = "openmausbot-runtime";

export function assertLegacyGatewayRetired({ home = homedir(), platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "darwin") return;
  const plist = path.join(home, "Library", "LaunchAgents", `${LEGACY_GATEWAY_LABEL}.plist`);
  if (existsSync(plist)) throw new Error("Retire the legacy gateway LaunchAgent before starting or installing Hezuo; see the offline identity migration procedure.");
  assertJobAbsent(LEGACY_GATEWAY_LABEL, run);
}

function assertJobAbsent(label, run) {
  const result = run("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
  // launchctl uses 113 for a job absent from an existing GUI domain. Other
  // failures are not evidence that a writer has stopped.
  if (result.status !== 113) throw new Error("Gateway service is loaded or its stopped state cannot be established; nothing was migrated.");
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error("Cannot establish whether the gateway process has stopped.");
  }
}

async function assertPortFree(config) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Gateway port is occupied or unavailable; stop every gateway before migrating.")));
    server.listen(config.port, config.host, () => server.close(resolve));
  });
}

/** Explicit offline move only. Never initializes secrets, TLS or a database. */
export async function migrateGatewayIdentity({ configPath, destination, home = homedir(), platform = process.platform, run = spawnSync }) {
  if (!destination) throw new Error("identity-migrate requires --data-dir naming the destination HezuoGateway directory.");
  const { config, configPath: sourceConfig } = readGatewayConfig(configPath);
  const source = path.resolve(config.dataDir);
  const target = path.resolve(destination);
  if (source === target || target.startsWith(`${source}${path.sep}`) || source.startsWith(`${target}${path.sep}`)) {
    throw new Error("Migration requires separate, non-nested source and destination directories.");
  }
  if (existsSync(target)) throw new Error("Destination already exists; migration never merges or overwrites storage.");
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error("Source must be a real directory.");
  const relativeConfig = path.relative(source, sourceConfig);
  if (relativeConfig.startsWith("..") || path.isAbsolute(relativeConfig)) throw new Error("Place the config inside its data directory before migrating.");
  assertLegacyGatewayRetired({ home, platform, run });
  if (platform === "darwin") {
    assertJobAbsent(GATEWAY_LABEL, run);
    if (existsSync(path.join(home, "Library", "LaunchAgents", `${GATEWAY_LABEL}.plist`))) throw new Error("Retire the destination LaunchAgent before migrating.");
  }
  const runtimePath = path.join(source, "gateway-runtime.json");
  if (existsSync(runtimePath)) {
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    if (!Number.isInteger(runtime.pid) || runtime.pid < 1 || processExists(runtime.pid)) throw new Error("Gateway runtime is active or ambiguous; nothing was migrated.");
  }
  await assertPortFree(config);
  const moved = { ...config, dataDir: target };
  for (const key of ["certFile", "keyFile", "modelFile", "openModelsFile", "rates"]) {
    const value = config[key];
    if (typeof value === "string" && path.isAbsolute(value) && value.startsWith(`${source}${path.sep}`)) {
      moved[key] = path.join(target, path.relative(source, value));
    }
  }
  const targetConfig = path.join(target, relativeConfig);
  // Same-filesystem rename preserves every database/WAL, mode, key and cert.
  // EXDEV is deliberately fatal: a partial copy must never become a new store.
  renameSync(source, target);
  try { writeConfig(targetConfig, moved); } catch (error) {
    renameSync(target, source);
    throw error;
  }
  return { ok: true, configPath: targetConfig, dataDir: target, serviceInstalled: false };
}
