// The macOS login service for `gateway/local/local-gateway.mjs`: one LaunchAgent per
// data directory, running the same gateway this checkout exposes on the
// command line. Everything a service needs is durable and private:
//
//   * Node is cloned (APFS `cp -c`, copy-on-write) to <data-dir>/service/node,
//     so the job never points at /tmp or at an npm cache that may be replaced.
//   * The plist carries paths and one non-secret environment variable, never a
//     key, token, or password. Secrets keep living in <data-dir>/secrets/.
//   * stdout and stderr go to <data-dir>/logs/gateway.log, created 0600 before
//     launchd opens it; the process itself trims it (see log-bounding.mjs).
//
// `install` refuses to start while an unmanaged gateway is already running:
// the operator stops that one first, so two processes never fight over the
// port or the D1 store.
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { prepareLogFile } from "./log-bounding.mjs";
import { GATEWAY_LABEL, LEGACY_RUNTIME_DIRECTORY, assertLegacyGatewayRetired } from "./identity-migration.mjs";

export const SERVICE_LABEL = GATEWAY_LABEL;
export const SERVICE_LOG_NAME = "gateway.log";
/** Node must be recent enough for the gateway's `node:sqlite` and ESM use. */
export const SERVICE_NODE_MAJOR = 24;

export class ServiceError extends Error {}

function fail(message) {
  throw new ServiceError(message);
}

/** Every path the service uses, derived from one data directory. The
 * LaunchAgent's file name follows its label, as launchd expects. */
export function servicePaths({ dataDir, home = homedir(), logName = SERVICE_LOG_NAME, label = SERVICE_LABEL }) {
  const serviceDir = path.join(dataDir, "service");
  const logDirectory = path.join(dataDir, "logs");
  return {
    serviceDir,
    node: path.join(serviceDir, "node"),
    stagedPlist: path.join(serviceDir, `${label}.plist`),
    installedPlist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    logDirectory,
    log: path.join(logDirectory, logName),
  };
}

/** Control characters a plist cannot carry; XML 1.0 forbids them outright. */
const XML_FORBIDDEN = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]"); // eslint-disable-line no-control-regex

function xml(value) {
  if (XML_FORBIDDEN.test(value)) fail(`unexpected control character in ${JSON.stringify(value)}`);
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The LaunchAgent for one gateway. `RunAtLoad` starts it at login (and on
 * bootstrap); a clean exit stays stopped, while a crash restarts after
 * `ThrottleInterval`. No secret appears in ProgramArguments or the
 * environment — only paths and the log location.
 */
export function gatewayPlist({
  label = SERVICE_LABEL,
  node,
  script,
  configPath,
  home = homedir(),
  workingDirectory,
  logPath,
  keepAlive = true,
}) {
  for (const [name, value] of Object.entries({ node, script, configPath, home, workingDirectory, logPath })) {
    if (typeof value !== "string" || value === "") fail(`${name} is required`);
  }
  const arguments_ = [node, script, "start", "--config", configPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xml(label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...arguments_.map((argument) => `\t\t<string>${xml(argument)}</string>`),
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(home)}</string>`,
    "\t\t<key>PATH</key>",
    "\t\t<string>/usr/bin:/bin:/usr/sbin:/sbin</string>",
    "\t\t<key>OMB_LOCAL_LOG_FILE</key>",
    `\t\t<string>${xml(logPath)}</string>`,
    "\t</dict>",
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xml(workingDirectory)}</string>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    keepAlive ? "\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>" : "\t<false/>",
    "\t<key>ThrottleInterval</key>",
    "\t<integer>10</integer>",
    "\t<key>Umask</key>",
    "\t<integer>63</integer>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(logPath)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The major version a Node binary reports, or null when it does not run. */
function nodeMajor(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  const match = /^v(\d+)\.\d+\.\d+\s*$/.exec(result.stdout ?? "");
  return match ? Number(match[1]) : null;
}

function cloneOrCopy(source, target) {
  const temporary = `${target}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  let cloned = false;
  if (process.platform === "darwin") {
    // `cp -c` asks APFS for a copy-on-write clone: no extra blocks for a Node
    // binary that never changes in place.
    const result = spawnSync("cp", ["-c", source, temporary], { stdio: "ignore", timeout: 120_000 });
    cloned = result.status === 0 && existsSync(temporary);
  }
  if (!cloned) copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, target);
}

/**
 * Puts one verified Node at `<data-dir>/service/node` and returns its path and
 * version. A source inside /tmp is allowed: the copy is what the service runs,
 * so the installed job never depends on the temporary directory.
 */
export function stageNode({ source, target }) {
  let stats;
  try {
    stats = statSync(source);
  } catch {
    fail(`node not found at ${source}; pass --node <path to node >= ${SERVICE_NODE_MAJOR}>`);
  }
  if (!stats.isFile()) fail(`${source} is not a file`);
  const sourceMajor = nodeMajor(source);
  if (sourceMajor === null) fail(`${source} is not a working node binary`);
  if (sourceMajor < SERVICE_NODE_MAJOR) {
    fail(`${source} is Node ${sourceMajor}; the gateway needs Node ${SERVICE_NODE_MAJOR} or newer`);
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  cloneOrCopy(source, target);
  const copiedMajor = nodeMajor(target);
  if (copiedMajor === null || copiedMajor < SERVICE_NODE_MAJOR) {
    rmSync(target, { force: true });
    fail(`the copied node at ${target} does not run; the service was not installed`);
  }
  return { path: target, major: copiedMajor };
}

/** Candidate nodes, most durable first. `process.execPath` is last because a
 * caller may itself be a temporary Node; the copy makes it durable either way.
 * `stageNode` does the real work of proving a candidate runs, so existence is
 * the only test needed here. */
export function nodeCandidates({ requested, execPath = process.execPath, home = homedir(), exists = existsSync } = {}) {
  const candidates = [];
  if (requested) candidates.push(requested);
  candidates.push(
    path.join(home, ".local", "share", "hezuo-runtime", "node_modules", "node", "bin", "node"),
    path.join(home, ".local", "share", LEGACY_RUNTIME_DIRECTORY, "node_modules", "node", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  );
  if (execPath) candidates.push(execPath);
  return [...new Set(candidates)].filter((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
}

export function launchdDomain({ uid = process.getuid?.(), label = SERVICE_LABEL } = {}) {
  if (!Number.isInteger(uid)) fail("cannot determine the current user id");
  return { domain: `gui/${uid}`, target: `gui/${uid}/${label}`, uid };
}

/** The parsed `launchctl print` answer: loaded state, pid, and the config its
 * arguments name — or null when the domain has no such job. The config path is
 * what makes a job *this* gateway's job: two data directories share one label
 * only when someone installs them over each other, and reporting the wrong
 * one's pid would be worse than reporting nothing. */
export function loadedService(label = SERVICE_LABEL) {
  const { target } = launchdDomain({ label });
  const result = spawnSync("launchctl", ["print", target], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  const text = result.stdout ?? "";
  const state = /^\s*state = (\S+)\s*$/m.exec(text)?.[1] ?? null;
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(text)?.[1] ?? 0) || null;
  const runs = Number(/^\s*runs = (\d+)\s*$/m.exec(text)?.[1] ?? 0) || null;
  const plist = /^\s*path = (\S+)\s*$/m.exec(text)?.[1] ?? null;
  const argumentsBlock = /arguments = \{([\s\S]*?)\n\s*\}/.exec(text)?.[1] ?? "";
  const arguments_ = [...argumentsBlock.matchAll(/^\s*(\S.*)$/gm)].map((match) => match[1].trim());
  const configIndex = arguments_.indexOf("--config");
  const configPath = configIndex === -1 ? null : arguments_[configIndex + 1] ?? null;
  return { state, pid, runs, plist, configPath };
}

/** The loaded job when it runs `configPath`, else null (no job, or someone
 * else's). `foreign` names the other job so a refusal can say why. */
function jobForConfig(label, configPath) {
  const loaded = loadedService(label);
  if (loaded === null) return { loaded: null, foreign: null };
  if (configPath && loaded.configPath !== path.resolve(configPath)) return { loaded: null, foreign: loaded };
  return { loaded, foreign: null };
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8", timeout: 30_000 });
}

function delay(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function bootout(label) {
  const { target } = launchdDomain({ label });
  launchctl(["bootout", target]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (loadedService(label) === null) return true;
    delay(100);
  }
  return loadedService(label) === null;
}

function writePrivateFile(file, text, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

/** The running state the gateway itself records, for `status` only. */
export function readRuntimeState(dataDir) {
  try {
    const state = JSON.parse(readFileSync(path.join(dataDir, "gateway-runtime.json"), "utf8"));
    return {
      pid: Number.isInteger(state?.pid) ? state.pid : null,
      origin: typeof state?.origin === "string" ? state.origin : null,
      startedAt: typeof state?.startedAt === "string" ? state.startedAt : null,
      configPath: typeof state?.configPath === "string" ? state.configPath : null,
    };
  } catch {
    return null;
  }
}

/**
 * Installs (or replaces) the LaunchAgent and starts it. The caller has already
 * verified that no unmanaged gateway is running for this config.
 */
export function installService({ configPath, dataDir, node, script, home = homedir(), label = SERVICE_LABEL }) {
  if (process.platform !== "darwin") fail("the login service is written for macOS (launchd)");
  assertLegacyGatewayRetired({ home });
  if (!existsSync(script)) fail(`${script} does not exist`);
  const paths = servicePaths({ dataDir, home, label });
  const stagedNode = stageNode({ source: node, target: paths.node });
  // launchd creates a missing log itself, world-readable; the file must exist
  // first, 0600, or the gateway's diagnostics end up readable by every account.
  prepareLogFile(paths.log);
  const plist = gatewayPlist({
    label,
    node: stagedNode.path,
    script: path.resolve(script),
    configPath: path.resolve(configPath),
    home,
    workingDirectory: dataDir,
    logPath: paths.log,
  });
  writePrivateFile(paths.stagedPlist, plist);
  writePrivateFile(paths.installedPlist, plist);
  if (!bootout(label)) fail("the previous gateway service did not stop; refusing to start another");

  const { domain, uid } = launchdDomain({ label });
  const bootstrap = launchctl(["bootstrap", domain, paths.installedPlist]);
  if (bootstrap.status !== 0) {
    fail(`launchctl bootstrap failed: ${(bootstrap.stderr || bootstrap.stdout || "unknown error").trim()}`);
  }
  // A disabled label would stay loaded but never run after the next login.
  launchctl(["enable", `gui/${uid}/${label}`]);
  const loaded = loadedService(label);
  if (loaded === null) fail("launchctl bootstrap reported success but the job is not loaded");
  // The gateway spends its first start applying migrations (tens of seconds on
  // a cold database) and writes nothing until it is ready. Wait for that
  // readiness so `install` reports a gateway that actually answers, instead of
  // a launchd pid whose log is still empty.
  const ready = awaitGatewayReady(dataDir, { configPath });
  return {
    ready,
    label,
    installedPlist: paths.installedPlist,
    node: stagedNode.path,
    log: paths.log,
    domain,
    loaded,
  };
}

/** Waits (bounded) for the gateway to publish its runtime metadata, i.e. for
 * its HTTP listener to be up. A timeout is reported, not thrown: the job is
 * installed either way, and `status` distinguishes the states. */
function awaitGatewayReady(dataDir, { timeoutMs = 180_000, configPath = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The metadata must name this config: a gateway still running for another
    // data directory would otherwise look like this job's own successful start.
    const runtime = readRuntimeState(dataDir);
    if (runtime?.origin && (configPath === null || runtime.configPath === path.resolve(configPath))) {
      return { ready: true, stillStarting: false, afterMs: timeoutMs - (deadline - Date.now()), origin: runtime.origin, pid: runtime.pid };
    }
    delay(250);
  }
  // Not a failure to report as one: a cold start bundles the Worker and runs
  // every migration before it publishes anything, and a loaded machine can
  // take minutes. The job is installed; `status` tells starting from stopped.
  return { ready: false, stillStarting: true, afterMs: timeoutMs, origin: null, pid: null };
}

export function uninstallService({ dataDir, home = homedir(), label = SERVICE_LABEL }) {
  if (process.platform !== "darwin") fail("the login service is written for macOS (launchd)");
  const paths = servicePaths({ dataDir, home, label });
  const stopped = bootout(label);
  rmSync(paths.installedPlist, { force: true });
  rmSync(paths.stagedPlist, { force: true });
  // The staged Node exists only for this job; accounts, secrets, logs and the
  // database all stay exactly where they are.
  rmSync(paths.node, { force: true });
  try {
    rmSync(paths.serviceDir, { recursive: true, force: true });
  } catch { /* a partially removed directory is not an uninstall failure */ }
  return { label, stopped, removedPlist: paths.installedPlist, log: paths.log, dataDir };
}

export function serviceStatus({ dataDir, home = homedir(), label = SERVICE_LABEL, configPath = null }) {
  const paths = servicePaths({ dataDir, home, label });
  const { loaded, foreign } = jobForConfig(label, configPath);
  return {
    label,
    installed: existsSync(paths.installedPlist),
    loaded: loaded !== null,
    // Same label, different config: a job exists, but it is not this gateway's.
    foreign: foreign === null ? null : { state: foreign.state, pid: foreign.pid, configPath: foreign.configPath },
    state: loaded?.state ?? null,
    pid: loaded?.pid ?? null,
    runs: loaded?.runs ?? null,
    node: existsSync(paths.node) ? paths.node : null,
    installedPlist: existsSync(paths.installedPlist) ? paths.installedPlist : null,
    log: existsSync(paths.log) ? { path: paths.log, bytes: statSync(paths.log).size } : null,
    runtime: readRuntimeState(dataDir),
  };
}
