#!/usr/bin/env node
// SECRETS. No secret is ever accepted on the command line or stored in the
// config. The config holds 0600 file paths under <data-dir>/secrets/, and each
// is opened O_NOFOLLOW with a private-mode and regular-file check. Sources are
// the environment (OMB_LOCAL_UPSTREAM_KEY, OMB_LOCAL_SMTP_URL), a --*-file flag
// naming an existing private file, or the OMP models.yml that already holds the
// upstream key. The operator's own password is never stored at all: `whoami`
// takes it from OMB_LOCAL_OPERATOR_PASSWORD for that one run, or falls back to
// the existing OTP prompt.
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import tls from "node:tls";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readOpenModels } from "./local-gateway/models.mjs";
import { MAILER_SOURCE } from "./local-gateway/mailer-worker.mjs";
import { parseSmtpURL, sendSmtpMessage } from "./local-gateway/smtp.mjs";
import { esbuild, miniflareRuntime, sqlSplitter } from "../../scripts/product-fixture/runtime.mjs";
import { boundLogFile, prepareLogFile, trimLogFile } from "./local-gateway/log-bounding.mjs";
import {
  SERVICE_NODE_MAJOR, ServiceError, installService, nodeCandidates, serviceStatus, servicePaths, uninstallService,
} from "./local-gateway/service.mjs";
import { AccountLookupError, d1DatabaseFiles, findAccountByEmail } from "./local-gateway/operator-bootstrap.mjs";
import { GATEWAY_D1_IDENTITY, assertLegacyGatewayRetired, migrateGatewayIdentity } from "./local-gateway/identity-migration.mjs";
import { createCompanionRelay, createDisconnectBridge, createGatewayFront } from "./local-gateway/companion-relay.mjs";
import { directEgress } from "./local-gateway/egress.mjs";

import { DEFAULT_DATA_DIR, DEFAULT_PORT, DEFAULT_MAX_OUTPUT_TOKENS, EMAIL, SECRET_FILES, UsageError, RefusalError, fail, readPrivateFile, writePrivateFile, secretPath, hasSecret, exactHTTPSOrigin, gatewayOrigin, certificateFor, trustGatewayCertificate, readGatewayConfig, writeConfig, envValue, seededModels, resolveGatewayConfig } from "./local-gateway/config.mjs";
export { UsageError, RefusalError, exactHTTPSOrigin, gatewayOrigin, trustGatewayCertificate, readGatewayConfig, resolveGatewayConfig };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_DIR = path.join(ROOT, "gateway", "control-plane");
const MIGRATIONS_DIR = path.join(WORKER_DIR, "migrations");
const MIGRATIONS_TABLE = "d1_migrations";
/** The D1 binding's stable name; persistence is scoped to <data-dir>/state. */
const D1_NAME = GATEWAY_D1_IDENTITY;

const USAGE = `usage: node gateway/local/local-gateway.mjs <command> [options]

commands:
  init      write the 0600 config and copy any given secret into <data-dir>/secrets/
  start     run the gateway in the foreground
  status    print running state, origin, and readiness (never a secret)
  stop      ask this gateway to shut down cleanly
  migrate   apply pending D1 migrations while the gateway is stopped
  identity-migrate  move stopped storage to --data-dir without changing D1, TLS or origin
  whoami    print the account id/email of an operator sign-in
  operator  allow one already-registered account email to administer AI
            (no account is created, no AI permission or points are granted)
  service   install | status | uninstall the macOS login service (launchd)

service options (macOS):
  --node <file>                Node binary to clone into <data-dir>/service/node
                               (default: a stable installed Node >= 24)
  --json                       print the machine-readable result

operator options:
  --operator-email <address>   an existing, registered account (exact match)
  --remove                     remove that account id from the operator list
  --json                       print the machine-readable result

init options:
  --config <file>              config path (default: <data-dir>/gateway.json)
  --data-dir <dir>             persistent state root (default: .omb-scratch/local-gateway)
  --host <host>                bind host (default: 127.0.0.1)
  --port <port>                bind port (default: ${DEFAULT_PORT})
  --public-host <host>         origin host; required when --host is not loopback
  --cert <pem> --key <pem>     TLS material; omit to generate one under <data-dir>/tls/
  --email-from <address>       sender for sign-in codes
  --smtp-file <file>           private file holding the SMTP submission URL
  --email-verification <mode>  required | off (default: required with mail, else off)
  --upstream-base <url>        exact HTTPS API base of the model upstream
  --upstream-key-file <file>   private file holding the upstream bearer
  --open-models <file>         an OMP models.yml to mirror (metadata + key)
  --open-models-provider <n>   provider block to mirror (default: the only one)
  --models <file>              a verified catalog in the Worker's AI_MODELS shape
  --rates <file|json>          {"modelId":{"inputMicroPointsPerMillion":…}}
  --rate <microPoints>         one uniform rate for the enabled default model
                               (1,000 points per million tokens = 1000000000)
  --default-model <id>         the one mirrored model to enable and start from
  --operator-id <id>           account id allowed to use /v1/operator/ai/*
  --max-output-tokens <n>      hard per-request output ceiling (default: ${DEFAULT_MAX_OUTPUT_TOKENS})

secret sources (never the command line): OMB_LOCAL_UPSTREAM_KEY,
OMB_LOCAL_SMTP_URL; or the --*-file flags above. The operator password is
never stored: \`whoami\` reads OMB_LOCAL_OPERATOR_PASSWORD for that run only, or
prompts for an emailed code.

other environment: OMB_LOCAL_HOST, OMB_LOCAL_PORT, OMB_LOCAL_PUBLIC_HOST,
OMB_LOCAL_DATA_DIR, OMB_LOCAL_CERT, OMB_LOCAL_KEY, OMB_LOCAL_EMAIL_FROM,
OMB_LOCAL_EMAIL_VERIFICATION, OMB_LOCAL_OPEN_MODELS,
OMB_LOCAL_OPEN_MODELS_PROVIDER, OMB_LOCAL_MODELS, OMB_LOCAL_RATES,
OMB_LOCAL_RATE, OMB_LOCAL_DEFAULT_MODEL, OMB_LOCAL_OPERATOR_IDS,
OMB_LOCAL_MAX_OUTPUT_TOKENS.

A model mirrored from models.yml is enabled only when it is the chosen
--default-model and it has explicit rates. Every other mirrored model stays
disabled, even if rates were supplied for it: enabling a model is a separate
operator decision about that model's verified limits and capabilities.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  if (command === "--help" || command === "-h") return { help: true };
  // `service install` and `service status` share one flag set, so the verb is
  // read from the first positional and the rest are ordinary --flags.
  if (command === "service") {
    const verb = rest[0];
    if (!verb || verb.startsWith("--")) fail("service needs a verb: install, status, or uninstall");
    options.serviceAction = verb;
    rest.shift();
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "help") {
      options.help = true;
      continue;
    }
    if (name === "json" || name === "remove") {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
    index += 1;
    options[name.replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = value;
  }
  return options;
}


/* ── runtime helpers ───────────────────────────────────────────────────── */

const secretCache = new Map();

/** A stable Better Auth secret for this data directory, created once, 0600,
 * and re-read through the same no-symlink/private-mode rule. */
function betterAuthSecret(dataDir) {
  if (secretCache.has(dataDir)) return secretCache.get(dataDir);
  const file = secretPath(dataDir, SECRET_FILES.auth);
  let secret;
  if (existsSync(file)) {
    secret = readPrivateFile(file, "the Better Auth secret").trim();
    if (secret.length < 32) fail(`${file} is too short; delete it to rotate (this ends every session)`);
  } else {
    secret = randomBytes(32).toString("base64url");
    writePrivateFile(file, secret);
  }
  secretCache.set(dataDir, secret);
  return secret;
}

function upstreamCredential(config) {
  if (hasSecret(config.dataDir, SECRET_FILES.upstream)) {
    return readPrivateFile(secretPath(config.dataDir, SECRET_FILES.upstream), "the upstream key").trim();
  }
  if (config.upstreamKeySource === "openModels" && config.openModelsFile) {
    const seeded = seededModels(readOpenModels(config.openModelsFile), config.openModelsProvider);
    const key = typeof seeded.providerEntry.apiKey === "string" ? seeded.providerEntry.apiKey.trim() : "";
    if (key === "") fail("models.yml no longer carries an upstream key; run init with --upstream-key-file");
    return key;
  }
  return null;
}

function smtpURL(config) {
  if (!config.smtp) return null;
  return readPrivateFile(secretPath(config.dataDir, SECRET_FILES.smtp), "the SMTP URL").trim();
}

/** The Worker's own vars: no SMTP credential, no password, no file path. */
export function workerVars(config, origin) {
  const vars = {
    BETTER_AUTH_URL: origin,
    ALLOWED_ORIGINS: "",
    AUTH_EMAIL_VERIFICATION: config.emailVerification,
    AI_OPERATOR_USER_IDS: JSON.stringify(config.operatorIds ?? []),
  };
  if (config.emailFrom) vars.EMAIL_FROM = config.emailFrom;
  if (config.upstreamBase && config.models?.some((model) => model.enabled) && config.defaultModel) {
    vars.AI_UPSTREAM_BASE_URL = config.upstreamBase;
    vars.AI_MODELS = JSON.stringify(config.models);
    vars.AI_DEFAULT_MODEL = config.defaultModel;
  }
  return vars;
}

/** Bundles the Worker exactly as a deploy would, once per process. */
async function bundleWorker(cacheFile) {
  const { build } = await esbuild();
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  await build({
    entryPoints: [path.join(WORKER_DIR, "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: cacheFile,
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  return readFileSync(cacheFile, "utf8");
}

/**
 * Wrangler's own D1 bookkeeping (`d1_migrations`), so `wrangler d1 migrations
 * apply` on this database sees these rows and never re-runs a migration.
 *
 * Each migration's statements AND its bookkeeping row are one `db.batch`, which
 * D1 runs as a single transaction: a crash can never leave the schema applied
 * without the row that says so, so a replay either does all of it or none.
 */
export async function applyMigrations(db) {
  let split;
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`).run();
  const applied = new Set((await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all()).results.map((row) => row.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    split ??= await sqlSplitter();
    const statements = split(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (statements.length === 0) continue;
    await db.batch([
      ...statements.map((statement) => db.prepare(statement)),
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).bind(file),
    ]);
    ran.push(file);
  }
  return { applied: [...applied].sort(), ran, pending: files.filter((file) => !applied.has(file) && !ran.includes(file)) };
}

function mailTransport(config) {
  const url = smtpURL(config);
  if (!url) return null;
  const target = parseSmtpURL(url);
  // A private SMTP CA is trusted exactly like any other: as an extra root for
  // these connections, never by turning verification off.
  const extraCA = envValue(process.env, "OMB_LOCAL_SMTP_CA");
  const targetWithCA = extraCA
    ? { ...target, ca: [...tls.getCACertificates("default"), readFileSync(path.resolve(extraCA), "utf8")] }
    : target;
  const counters = { sent: 0, failed: 0 };
  // Miniflare accepts only a plain function as a fetch service binding, so the
  // counters hang off a closure instead of the function object.
  const handler = async (request) => {
    if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
    let message;
    try {
      message = await request.json();
    } catch {
      counters.failed += 1;
      return Response.json({ error: "mail_message_invalid" }, { status: 400 });
    }
    if (!message || typeof message !== "object" || typeof message.subject !== "string"
        || (typeof message.to !== "string" && !Array.isArray(message.to))) {
      counters.failed += 1;
      return Response.json({ error: "mail_message_invalid" }, { status: 400 });
    }
    try {
      await sendSmtpMessage(targetWithCA, message);
      counters.sent += 1;
      return Response.json({ accepted: 1 });
    } catch (error) {
      counters.failed += 1;
      // The stable code only: never the address, subject, body, or credential.
      const code = error?.name === "SmtpError" ? error.message : "mail_delivery_failed";
      console.error(`[local-gateway] mail delivery failed: ${code}`);
      return Response.json({ error: code }, { status: 502 });
    }
  };
  return { handler, stats: () => ({ ...counters }) };
}

/** Miniflare options for one phase. `port` 0 binds an ephemeral port. */
/**
 * A request to this gateway that verifies its certificate explicitly. Node's
 * global trust store is read once per connection, but a process may have made
 * requests before this certificate existed, so the CA is passed per request.
 * Verification is never disabled.
 */
function gatewayRequest(url, certPath, { method = "GET", path: requestPath } = {}) {
  const target = new URL(url);
  const ca = [...tls.getCACertificates("default"), readFileSync(certPath, "utf8")];
  // RFC 6066 forbids SNI for an address literal. The certificate names this
  // exact host (a generated one carries it as an IP SAN), so the check that
  // matters is the one against `hostname` above — not an SNI entry that the
  // TLS stack would drop anyway.
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const isAddress = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host,
      port: target.port,
      path: requestPath ?? `${target.pathname}${target.search}`,
      method,
      ca,
      ...(isAddress ? {} : { servername: host }),
      headers: { accept: "application/json" },
      timeout: 10_000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body = (body + chunk).slice(0, 4_096); });
      response.on("end", () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("gateway_timeout")));
    request.on("error", reject);
    request.end();
  });
}

function runtimeOptions({ runtime, config, port, script, mail, bindings, host = null, disconnectBridge = null }) {
  const certificate = certificateFor(config);
  const workers = [{
    name: "hezuo-local-gateway",
    modules: true,
    script,
    compatibilityDate: "2026-08-25",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    // The persistent database the Worker's `DB` binding resolves to.
    d1Databases: { DB: D1_NAME },
    serviceBindings: {
      ...(mail ? { EMAIL: { name: "hezuo-local-mailer", entrypoint: "EmailSender" } } : {}),
      ...(disconnectBridge ? { LOCAL_GATEWAY_DISCONNECT: request => disconnectBridge.fetch(request) } : {}),
    },
    outboundService: directEgress,
  }];
  if (mail) {
    workers.push({
      name: "hezuo-local-mailer",
      modules: true,
      script: MAILER_SOURCE,
      compatibilityDate: "2026-08-25",
      compatibilityFlags: ["nodejs_compat"],
      serviceBindings: { MAIL: mail.handler },
    });
  }
  return runtime.convertV4MiniflareOptions({
    host: host ?? (config.host === "localhost" ? "127.0.0.1" : config.host.replace(/^\[|\]$/g, "")),
    port,
    https: true,
    httpsKey: readFileSync(certificate.keyPath, "utf8"),
    httpsCert: readFileSync(certificate.certPath, "utf8"),
    workers,
    // The Worker's real scheduled handler (reservation recovery, expiry
    // sweeps) can be triggered on demand through /cdn-cgi/local/scheduled.
    unsafeTriggerHandlers: true,
    resourcePersistencePath: path.join(config.dataDir, "state"),
    resourceTmpPath: path.join(config.dataDir, "tmp"),
  });
}

function bindingsFor(config, origin) {
  const vars = workerVars(config, origin);
  const secret = Object.hasOwn(vars, "AI_UPSTREAM_BASE_URL") ? upstreamCredential(config) : null;
  if (Object.hasOwn(vars, "AI_UPSTREAM_BASE_URL") && !secret) {
    fail("the catalog is enabled but no upstream key is available; run init with --upstream-key-file or keep --open-models");
  }
  return {
    ...vars,
    BETTER_AUTH_SECRET: betterAuthSecret(config.dataDir),
    ...(secret ? { AI_UPSTREAM_API_KEY: secret } : {}),
  };
}

function runtimeFile(dataDir) {
  return path.join(dataDir, "gateway-runtime.json");
}

/** Readiness metadata for `status`/`whoami`/`stop`. Never a secret. */
function writeRuntime(config, state) {
  writePrivateFile(runtimeFile(config.dataDir), JSON.stringify(state, null, 2));
}

function readRuntime(dataDir) {
  try {
    return JSON.parse(readFileSync(runtimeFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function configPathOf(config) {
  return config.__configPath ?? path.join(config.dataDir, "gateway.json");
}

/** True only when `pid` is a local-gateway process for this exact config, so
 * `stop` can never signal an unrelated process that reused a stale PID. */
function ownsRuntime(config, runtime) {
  if (!processAlive(runtime?.pid)) return false;
  // The metadata names the config it was written for, so a recycled PID alone
  // can never authorize a signal.
  if (runtime.configPath !== configPathOf(config)) return false;
  if (process.platform === "win32") return true;
  const result = spawnSync("ps", ["-p", String(runtime.pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const command = result.stdout ?? "";
  return command.includes("local-gateway.mjs") && command.includes(runtime.configPath);
}

/**
 * Starts the gateway.
 *
 * Migrations run on a throwaway Miniflare bound to an ephemeral loopback port
 * *before* the configured listener exists, so no request can reach a Worker
 * whose schema is not yet migrated. The real listener then starts with the
 * schema already in place; a failure before it is ready leaves nothing behind.
 * `close()` is idempotent and returns once Miniflare has shut down.
 */
export async function startLocalGateway({ config, configPath = null, log = () => {} } = {}) {
  if (!config) fail("startLocalGateway needs a resolved config");
  assertLegacyGatewayRetired();
  const effective = configPath ? { ...config, __configPath: path.resolve(configPath) } : config;
  mkdirSync(path.join(effective.dataDir, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(effective.dataDir, "tmp"), { recursive: true, mode: 0o700 });
  const origin = gatewayOrigin({ host: effective.host, port: effective.port, publicHost: effective.publicHost });
  const script = await bundleWorker(path.join(effective.dataDir, "worker", "index.js"));
  const mail = mailTransport(effective);
  const bindings = bindingsFor(effective, origin);
  const runtime = await miniflareRuntime();

  let db;
  let migrations;
  {
    const bootstrap = new runtime.Miniflare(runtimeOptions({
      runtime, config: effective, port: 0, script, mail: null, bindings,
    }));
    try {
      await bootstrap.ready;
      db = await bootstrap.getD1Database("DB");
      migrations = await applyMigrations(db);
    } finally {
      await bootstrap.dispose().catch(() => {});
    }
  }
  // `applied` is what was already recorded before this run; `ran` is what this
  // run added. Anything still unapplied after both is a real refusal, not a
  // number to print and carry on with.
  log(`migrations: ${migrations.ran.length} applied now, ${migrations.applied.length} already present, ${migrations.pending.length} still pending`);
  if (migrations.pending.length > 0) {
    throw new UsageError(`migrations remain unapplied: ${migrations.pending.join(", ")}; refusing to serve a partial schema`);
  }

  // The Worker stays on loopback. The public origin is a Node TLS front that
  // serves the companion relay and dispatches everything else to Miniflare, so
  // a phone can reach the owner's desktop without Cloudflare or Tailscale.
  const disconnectBridge = createDisconnectBridge();
  const mf = new runtime.Miniflare(runtimeOptions({
    runtime, config: effective, port: 0, host: "127.0.0.1", script, mail, bindings, disconnectBridge,
  }));
  let closed = false;
  let maintenanceTimer;
  let maintenance;
  let front;
  let relay;
  const runScheduled = () => {
    if (closed) return Promise.reject(new Error("Gateway is closed"));
    if (maintenance) return maintenance;
    maintenance = gatewayRequest(`${origin}/cdn-cgi/local/scheduled`, certificateFor(effective).certPath)
      .then(response => {
        if (!response.ok) throw new Error(`Scheduled maintenance failed (${response.status})`);
        return { status: response.status };
      }).finally(() => { maintenance = undefined; });
    return maintenance;
  };
  try {
    await mf.ready;
    const liveDb = await mf.getD1Database("DB");
    if (migrations.pending.length > 0) fail("the live runtime still reports pending migrations; refusing to serve a partial schema");
    const certificate = certificateFor(effective);
    const workerFetch = (path, init = {}) => mf.dispatchFetch(new URL(path, origin).href, init);
    relay = createCompanionRelay({ workerFetch });
    const bindHost = effective.host === "localhost" ? "127.0.0.1" : effective.host.replace(/^\[|\]$/g, "");
    front = createGatewayFront({
      origin,
      host: bindHost,
      port: effective.port,
      cert: readFileSync(certificate.certPath, "utf8"),
      key: readFileSync(certificate.keyPath, "utf8"),
      dispatchFetch: (url, init) => mf.dispatchFetch(url, init),
      relay,
      disconnectBridge,
    });
    try {
      await front.listen();
    } catch (error) {
      relay.close();
      throw error;
    }
    trustGatewayCertificate(certificate.certPath);
    const health = await gatewayRequest(`${origin}/healthz`, certificate.certPath);
    if (!health.ok) throw new UsageError(`the Worker answered /healthz with ${health.status}; check the gateway configuration`);
    await runScheduled();
    maintenanceTimer = setInterval(() => {
      void runScheduled().catch(() => log("scheduled maintenance failed; retrying on the next interval"));
    }, 60_000);
    maintenanceTimer.unref();
    const capabilities = {
      // Password sign-in is part of the Worker's fixed auth surface.
      password: true,
      emailCode: Boolean(mail),
      emailVerification: effective.emailVerification,
      ai: Boolean(effective.upstreamBase && effective.models?.some((model) => model.enabled)),
      models: effective.models?.filter((model) => model.enabled).map((model) => model.id) ?? [],
      defaultModel: effective.defaultModel,
      operatorIds: effective.operatorIds ?? [],
    };
    const certificatePath = certificate.certPath;
    writeRuntime(effective, {
      pid: process.pid,
      origin,
      port: effective.port,
      configPath: configPathOf(effective),
      startedAt: new Date().toISOString(),
      capabilities,
      certificate: certificatePath,
      migrations: { applied: migrations.applied.length + migrations.ran.length, pending: migrations.pending.length },
    });
    return {
      origin,
      port: effective.port,
      config: effective,
      configPath,
      certificate: certificatePath,
      migrations,
      capabilities,
      db: () => liveDb,
      mail: mail ? mail.stats : null,
      runScheduled,
      async status() {
        const response = await gatewayRequest(`${origin}/healthz`, certificateFor(effective).certPath);
        return { healthy: response.ok, status: response.status };
      },
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(maintenanceTimer);
        await maintenance?.catch(() => {});
        const current = readRuntime(effective.dataDir);
        if (current?.pid === process.pid) {
          try {
            unlinkSync(runtimeFile(effective.dataDir));
          } catch { /* never written, or already gone */ }
        }
        try { await front?.close(); } catch { /* already closed */ }
        await mf.dispose();
      },
    };
  } catch (error) {
    clearInterval(maintenanceTimer);
    await mf.dispose().catch(() => {});
    throw error;
  }
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

/** The operator's own identity. The password is used for this run only (from
 * the environment) and is never persisted; without it, the existing admin CLI
 * prompts for an emailed code. */
async function printWhoami({ config, origin, email, environment = process.env }) {
  const { createControlPlaneClient } = await import("../../desktop/electron/control-plane-client.mjs");
  trustGatewayCertificate(certificateFor(config).certPath);
  const password = envValue(environment, "OMB_LOCAL_OPERATOR_PASSWORD");
  if (password) {
    const client = createControlPlaneClient({ baseURL: origin });
    const { user } = await client.signInWithPassword(email, password);
    process.stdout.write(`${JSON.stringify({ userId: user.id, email: user.email })}\n`);
    return;
  }
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "gateway", "scripts", "account-ai-admin.mjs"), "whoami",
    "--origin", origin, "--operator-email", email, "--json",
  ], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...environment, NODE_EXTRA_CA_CERTS: certificateFor(config).certPath },
  });
  if (result.status !== 0) fail("the operator sign-in failed");
  process.stdout.write(result.stdout ?? "");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === undefined) {
    console.log(USAGE);
    return;
  }
  // The default config path depends on the data directory, so a run that only
  // adjusts one setting still reads (and preserves) everything already there.
  const defaultDataDir = path.resolve(
    options.dataDir ?? envValue(process.env, "OMB_LOCAL_DATA_DIR") ?? DEFAULT_DATA_DIR,
  );
  const configPath = options.config ? path.resolve(options.config) : path.join(defaultDataDir, "gateway.json");
  const previous = existsSync(configPath) ? readGatewayConfig(configPath).config : null;
  if (options.command === "identity-migrate") {
    console.log(JSON.stringify(await migrateGatewayIdentity({ configPath, destination: options.dataDir }), null, 2));
    return;
  }

  if (options.command === "init") {
    const config = resolveGatewayConfig({ options, previous });
    const target = configPath;
    writeConfig(target, config);
    const origin = gatewayOrigin({ host: config.host, port: config.port, publicHost: config.publicHost });
    console.log(JSON.stringify({
      ok: true,
      configPath: target,
      dataDir: config.dataDir,
      origin,
      emailCode: config.smtp && config.emailVerification === "required",
      emailVerification: config.emailVerification,
      ai: Object.hasOwn(workerVars(config, origin), "AI_UPSTREAM_BASE_URL"),
      models: (config.models ?? []).map((model) => ({ id: model.id, enabled: model.enabled })),
      defaultModel: config.defaultModel,
      note: "Secrets live only in <data-dir>/secrets/ (0600) and are never printed; no operator password is stored.",
    }, null, 2));
    return;
  }

  if (options.command === "start") {
    if (!configPath) fail("start needs --config <file>");
    const { config } = readGatewayConfig(configPath);
    const existing = readRuntime(config.dataDir);
    if (ownsRuntime({ ...config, __configPath: configPath }, existing)) {
      fail(`this gateway is already running (pid ${existing.pid}); run \`status\``);
    }
    const gateway = await startLocalGateway({
      config,
      configPath,
      log: (message) => console.error(`[local-gateway] ${message}`),
    });
    // Under launchd, stdout/stderr are one file launchd opened once; bounding
    // it here is the only place that can see when it has grown.
    const logFile = envValue(process.env, "OMB_LOCAL_LOG_FILE");
    if (logFile) {
      try {
        prepareLogFile(logFile);
        boundLogFile(logFile);
      } catch (error) {
        console.error(`[local-gateway] log bounding is off: ${error?.message ?? error}`);
      }
    }
    console.log(JSON.stringify({
      ok: true,
      pid: process.pid,
      origin: gateway.origin,
      certificate: gateway.certificate,
      configPath,
      capabilities: gateway.capabilities,
      migrations: gateway.migrations,
      note: "Point clients at this origin. CLI clients trust the certificate with NODE_EXTRA_CA_CERTS; the product app trusts it when packaged with --gateway-ca <certPath>.",
    }, null, 2));
    const shutdown = async (signal) => {
      console.error(`[local-gateway] ${signal}: shutting down`);
      await gateway.close().catch((error) => console.error(`[local-gateway] close failed: ${error?.message ?? error}`));
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    return;
  }

  if (options.command === "status" || options.command === "stop") {
    if (!configPath) fail(`${options.command} needs --config <file>`);
    const { config } = readGatewayConfig(configPath);
    const effective = { ...config, __configPath: configPath };
    const runtime = readRuntime(config.dataDir);
    const running = ownsRuntime(effective, runtime);
    const service = process.platform === "darwin"
      ? serviceStatus({ dataDir: config.dataDir, home: homedir(), configPath })
      : null;
    // A launchd job that has been up for less than a second has neither a pid
    // nor run metadata yet; without this the answer is a misleading "not
    // running" for the ten or so seconds a first start spends on migrations.
    const starting = !running && Boolean(service?.loaded);
    let healthy = false;
    if (running) {
      try {
        // The gateway's own certificate, so this is a verified request rather
        // than a TLS check that is switched off.
        trustGatewayCertificate(certificateFor(config).certPath);
        healthy = (await gatewayRequest(`${runtime.origin}/healthz`, certificateFor(config).certPath)).ok;
      } catch {
        healthy = false;
      }
    }
    if (options.command === "status") {
      console.log(JSON.stringify({
        running,
        starting,
        healthy,
        pid: running ? runtime.pid : (starting ? service?.pid ?? null : null),
        origin: runtime?.origin ?? gatewayOrigin({ host: config.host, port: config.port, publicHost: config.publicHost }),
        startedAt: runtime?.startedAt ?? null,
        capabilities: runtime?.capabilities ?? null,
        migrations: runtime?.migrations ?? null,
        ...(service ? { service: { installed: service.installed, loaded: service.loaded, state: service.state, runs: service.runs } } : {}),
      }, null, 2));
      return;
    }
    if (!running) {
      console.log(JSON.stringify({ ok: true, running: false, starting }, null, 2));
      return;
    }
    // A launchd job restarts itself after a signal, so `stop` would look like
    // a no-op (or a crash loop). Say what actually stops it instead.
    if (service?.loaded && service.pid === runtime.pid) {
      throw new RefusalError(
        `this gateway is managed by launchd (${service.label}); nothing was changed.\n`
        + `Remove the login service instead:  node gateway/local/local-gateway.mjs service uninstall --config ${configPath}`,
      );
    }
    process.kill(runtime.pid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && ownsRuntime(effective, runtime)) await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = !ownsRuntime(effective, runtime);
    if (!stopped) process.kill(runtime.pid, "SIGKILL");
    try {
      unlinkSync(runtimeFile(config.dataDir));
    } catch { /* already gone */ }
    console.log(JSON.stringify({ ok: stopped, running: false, forced: !stopped }, null, 2));
    return;
  }

  if (options.command === "migrate") {
    if (!configPath) fail("migrate needs --config <file>");
    const { config } = readGatewayConfig(configPath);
    if (ownsRuntime({ ...config, __configPath: configPath }, readRuntime(config.dataDir))) {
      fail("stop the gateway first: one process owns the database at a time");
    }
    const origin = gatewayOrigin({ host: config.host, port: config.port, publicHost: config.publicHost });
    const script = await bundleWorker(path.join(config.dataDir, "worker", "index.js"));
    const runtime = await miniflareRuntime();
    const mf = new runtime.Miniflare(runtimeOptions({
      runtime, config, port: 0, script, mail: null, bindings: bindingsFor(config, origin),
    }));
    try {
      await mf.ready;
      const result = await applyMigrations(await mf.getD1Database("DB"));
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } finally {
      await mf.dispose().catch(() => {});
    }
    return;
  }

  if (options.command === "whoami") {
    if (!configPath) fail("whoami needs --config <file>");
    const { config } = readGatewayConfig(configPath);
    const runtime = readRuntime(config.dataDir);
    if (!ownsRuntime({ ...config, __configPath: configPath }, runtime)) fail("the gateway is not running; start it first");
    const email = options.operatorEmail ?? envValue(process.env, "OMB_LOCAL_OPERATOR_EMAIL");
    if (!email) fail("whoami needs --operator-email <address>");
    await printWhoami({ config, origin: runtime.origin, email: String(email).trim().toLowerCase() });
    return;
  }

  if (options.command === "service") {
    return runServiceCommand({ options, configPath, home: homedir() });
  }

  if (options.command === "operator") {
    return runOperatorCommand({ options, configPath });
  }

  fail(`unknown command ${JSON.stringify(options.command)}`);
}

/**
 * `service install|status|uninstall`. The install never touches a gateway the
 * operator started by hand: it refuses while one is running, prints the stop
 * command, and writes nothing, so the switch is one deliberate step.
 */
function runServiceCommand({ options, configPath, home }) {
  const action = options.serviceAction;
  if (!["install", "status", "uninstall"].includes(action)) {
    fail(`unknown service action ${JSON.stringify(action)}; use install, status, or uninstall`);
  }
  if (process.platform !== "darwin") fail("the login service is written for macOS (launchd); elsewhere run `start` under systemd or Task Scheduler");
  if (!configPath) fail(`service ${action} needs --config <file>`);
  if (!existsSync(configPath)) fail(`${configPath} does not exist; run \`init\` first`);
  const { config } = readGatewayConfig(configPath);
  const paths = servicePaths({ dataDir: config.dataDir, home });
  const effective = { ...config, __configPath: configPath };
  const print = (value) => console.log(JSON.stringify(value, null, 2));

  if (action === "install") {
    // A job whose gateway is already up is replaced only after it has been
    // asked to stop, so `install` never leaves a second process fighting for
    // the port.
    const running = readRuntime(config.dataDir);
    // Re-running install is how the job is upgraded, so the gateway it already
    // owns is not a conflict; one started by hand is.
    const managed = serviceStatus({ dataDir: config.dataDir, home, configPath });
    if (ownsRuntime(effective, running) && !(managed.loaded && managed.pid === running.pid)) {
      throw new RefusalError(
        `a gateway started by hand is already running for this config (pid ${running.pid}); nothing was changed.\n`
        + `Stop it first:  node gateway/local/local-gateway.mjs stop --config ${configPath}\n`
        + `Then install the login service:  node gateway/local/local-gateway.mjs service install --config ${configPath}`,
      );
    }
    // launchd opens the log itself, and it never creates the directory.
    const log = prepareLogFile(paths.log);
    // Trim whatever a previous run left behind before the new job appends.
    const trimmed = trimLogFile(log);
    const node = options.node ?? process.env.OMB_LOCAL_SERVICE_NODE;
    const candidates = node ? [node] : nodeCandidates({ requested: null });
    if (candidates.length === 0) {
      fail(`no node >= ${SERVICE_NODE_MAJOR} to stage; pass --node <path>`);
    }
    let installed;
    let lastError;
    for (const candidate of candidates) {
      try {
        installed = installService({
          configPath,
          dataDir: config.dataDir,
          node: candidate,
          script: fileURLToPath(import.meta.url),
          home,
        });
        break;
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        lastError = error;
      }
    }
    if (!installed) throw lastError ?? new ServiceError("no usable node was found");
    print({
      ok: true,
      action: "install",
      ...installed,
      log,
      trimmed: trimmed.trimmed ? `${trimmed.before} -> ${trimmed.after} bytes` : "within bound",
      configPath,
      startAtLogin: true,
      ready: installed.ready,
      note: "The gateway now runs from launchd. Secrets stay in <data-dir>/secrets/; the plist carries only paths.",
    });
    return;
  }

  if (action === "status") {
    const state = serviceStatus({ dataDir: config.dataDir, home, configPath });
    const runtime = readRuntime(config.dataDir);
    const running = ownsRuntime(effective, runtime);
    print({ ok: true, action: "status", ...state, gateway: { running, pid: running ? runtime.pid : null } });
    return;
  }

  const result = uninstallService({ dataDir: config.dataDir, home });
  print({
    ok: true,
    action: "uninstall",
    ...result,
    note: "The login service is gone. The gateway is not running now; accounts, secrets, logs and the database are untouched.",
  });
}

/**
 * `operator --operator-email <registered address>`: the explicit bootstrap.
 *
 * The address is looked up read-only in this data directory's D1 store, so no
 * session, password, or running gateway is needed; its account id is added to
 * the config's operator list and nothing else is touched. Enabling AI access
 * and granting points stay separate, explicit operator actions
 * (`scripts/account-ai-admin.mjs enable|grant`).
 */
function runOperatorCommand({ options, configPath }) {
  if (!configPath) fail("operator needs --config <file>");
  const { config } = readGatewayConfig(configPath);
  const email = options.operatorEmail ?? envValue(process.env, "OMB_LOCAL_OPERATOR_EMAIL");
  if (!email) fail("operator needs --operator-email <address> (an existing, registered account)");
  const normalized = String(email).trim().toLowerCase();
  if (!EMAIL.test(normalized)) fail(`--operator-email ${JSON.stringify(email)} is not an email address`);

  const files = d1DatabaseFiles(config.dataDir);
  if (files.length === 0) {
    throw new RefusalError(`${config.dataDir} has no gateway database yet; start the gateway and register the account first`);
  }
  const account = findAccountByEmail({ dataDir: config.dataDir, email: normalized, files });
  const print = (value) => console.log(JSON.stringify(value, null, 2));

  if (account === null) {
    throw new RefusalError(
      `no account is registered as ${normalized} in this gateway's database.`
      + " Register that exact address first (the app's account form), then run this again. Nothing was changed.",
    );
  }

  const current = config.operatorIds ?? [];
  const remove = Boolean(options.remove);
  const next = remove
    ? current.filter((id) => id !== account.id)
    : [...new Set([...current, account.id])];
  const changed = next.length !== current.length;
  if (changed) writeConfig(configPath, { ...config, operatorIds: next });

  const runtime = readRuntime(config.dataDir);
  const running = ownsRuntime({ ...config, __configPath: configPath }, runtime);
  print({
    ok: true,
    action: remove ? "remove" : "add",
    email: account.email,
    userId: account.id,
    emailVerified: account.emailVerified,
    operatorIds: next,
    changed,
    configPath,
    ai: {
      enabled: account.ai.enabled,
      availableMicroPoints: account.ai.availableMicroPoints,
      reservedMicroPoints: account.ai.reservedMicroPoints,
    },
    restartRequired: changed,
    gatewayRunning: running,
    note: changed
      ? `Restart the gateway to apply this (${path.join(ROOT, "gateway", "local", "local-gateway.mjs")} service install, or stop then start). AI access and points are separate: \`node scripts/account-ai-admin.mjs enable|grant --origin <origin> --operator-email ${account.email}\`.`
      : "Already an operator; nothing changed.",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof UsageError
      ? error.message
      : error instanceof ServiceError || error instanceof RefusalError || error instanceof AccountLookupError
        ? error.message
        : `[local-gateway] ${error?.message ?? error}`;
    console.error(error instanceof UsageError ? `${message}\n\n${USAGE}` : message);
    process.exitCode = 1;
  });
}
