#!/usr/bin/env node
// A persistent local gateway: this repository's real account Worker, run by
// the Miniflare its own Wrangler pins, over TLS on an explicit host/port, on a
// persistent D1 database with Wrangler-compatible migration bookkeeping,
// forwarding real inference to the operator's upstream and sending real
// sign-in mail through the operator's own SMTP submission service.
//
// Nothing here is a fixture: the Worker's account, operator, token, billing
// and usage paths are production code. Only the surrounding process (TLS
// terminator, D1 host, SMTP adapter, upstream address, catalog prices)
// belongs to this deployment.
//
//   node scripts/local-gateway.mjs init  --config gateway.json \
//     --open-models ~/.omp/agent/models.yml --default-model gpt-6-astra --rate 1000000000
//   node scripts/local-gateway.mjs start --config gateway.json
//   node scripts/local-gateway.mjs status --config gateway.json
//   node scripts/local-gateway.mjs stop  --config gateway.json
//   node scripts/local-gateway.mjs migrate --config gateway.json
//   node scripts/local-gateway.mjs whoami --config gateway.json --operator-email you@example.com
//
// Programmatic use (supervision, smoke tests):
//   import { startLocalGateway, readGatewayConfig } from "./scripts/local-gateway.mjs";
//   const gateway = await startLocalGateway({ config });   // origin/port/close/db/status
//
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
import { constants as fsConstants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";

import { catalogFromOpenModels, readCatalogFile, readOpenModels, readRates, validateCatalogFile } from "./local-gateway/models.mjs";
import { MAILER_SOURCE } from "./local-gateway/mailer-worker.mjs";
import { parseSmtpURL, sendSmtpMessage } from "./local-gateway/smtp.mjs";
import { esbuild, miniflareRuntime, sqlSplitter } from "./product-fixture/runtime.mjs";
import { boundLogFile, prepareLogFile, trimLogFile } from "./local-gateway/log-bounding.mjs";
import {
  SERVICE_NODE_MAJOR, ServiceError, installService, nodeCandidates, serviceStatus, servicePaths, uninstallService,
} from "./local-gateway/service.mjs";
import { AccountLookupError, d1DatabaseFiles, findAccountByEmail } from "./local-gateway/operator-bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "cloudflare", "control-plane");
const MIGRATIONS_DIR = path.join(WORKER_DIR, "migrations");
const CONFIG_VERSION = 1;
const MIGRATIONS_TABLE = "d1_migrations";
/** The D1 binding's stable name; persistence is scoped to <data-dir>/state. */
const D1_NAME = "openmausbot-local-gateway";
const DEFAULT_DATA_DIR = path.join(ROOT, ".omb-scratch", "local-gateway");
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_FILES = Object.freeze({ auth: "better-auth-secret", upstream: "upstream-key", smtp: "smtp-url" });

export class UsageError extends Error {}
/** A refusal that is not a usage mistake (an unregistered address, a running
 * gateway): the message is the whole answer, with no usage dump after it. */
export class RefusalError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

const USAGE = `usage: node scripts/local-gateway.mjs <command> [options]

commands:
  init      write the 0600 config and copy any given secret into <data-dir>/secrets/
  start     run the gateway in the foreground
  status    print running state, origin, and readiness (never a secret)
  stop      ask this gateway to shut down cleanly
  migrate   apply pending D1 migrations while the gateway is stopped
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

/* ── private files ─────────────────────────────────────────────────────── */

/** Reads a private file: opened O_NOFOLLOW, must be a regular file with mode
 * 0600 (or stricter). A symlink or shared file is refused, never repaired. */
function readPrivateFile(file, label) {
  const absolute = path.resolve(file);
  let fd;
  try {
    fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be a symlink`);
    if (error?.code === "ENOENT") fail(`${label} does not exist`);
    fail(`${label} cannot be read`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) fail(`${label} must be a regular file`);
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail(`${label} must be mode 0600`);
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writePrivateFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Never write "through" an existing symlink: replace-or-refuse.
  try {
    if (lstatSync(file).isSymbolicLink()) fail(`${file} must not be a symlink`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function secretPath(dataDir, name) {
  return path.join(dataDir, "secrets", name);
}

function hasSecret(dataDir, name) {
  return existsSync(secretPath(dataDir, name));
}

/* ── origins and certificates ──────────────────────────────────────────── */

/** An exact HTTPS origin, or null for anything with a path, credential,
 * query, fragment, or non-HTTPS scheme. */
export function exactHTTPSOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

function originHost(host) {
  const value = String(host).toLowerCase();
  if (value === "0.0.0.0" || value === "::") return "127.0.0.1";
  return value === "::1" ? "[::1]" : value;
}

/** The origin clients pin: always HTTPS, always with the port. */
export function gatewayOrigin({ host, port, publicHost }) {
  const origin = exactHTTPSOrigin(`https://${publicHost ?? originHost(host)}:${port}`);
  if (!origin) fail(`cannot form an HTTPS origin from ${JSON.stringify(host)}:${port}`);
  return origin;
}

/** This deployment's certificate. A generated one covers the exact host the
 * origin names; a supplied pair is used as-is. */
function certificateFor(config) {
  if (config.certFile || config.keyFile) {
    if (!config.certFile || !config.keyFile) fail("--cert and --key must be given together");
    return { certPath: path.resolve(config.certFile), keyPath: path.resolve(config.keyFile), generated: false };
  }
  const directory = path.join(config.dataDir, "tls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, "gateway-key.pem");
  const certPath = path.join(directory, "gateway-cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const subject = originHost(config.publicHost ?? config.host).replace(/^\[|\]$/g, "");
    const san = /^\d+\.\d+\.\d+\.\d+$/.test(subject) || subject.includes(":") ? `IP:${subject}` : `DNS:${subject}`;
    const result = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
      "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${subject}`, "-addext", `subjectAltName=${san}`,
    ], { stdio: "ignore" });
    if (result.status !== 0) fail(`openssl could not create a certificate for ${subject}; pass --cert and --key instead`);
    chmodSync(keyPath, 0o600);
  }
  return { certPath, keyPath, generated: true };
}

/** Trusts this gateway's certificate for this process only, so clients verify
 * rather than disabling TLS checks. */
export function trustGatewayCertificate(certPath) {
  const pem = readFileSync(certPath, "utf8");
  const current = tls.getCACertificates("default");
  if (!current.includes(pem)) tls.setDefaultCACertificates([...current, pem]);
}

/* ── config ────────────────────────────────────────────────────────────── */

export function readGatewayConfig(file) {
  const configPath = path.resolve(file);
  // The config itself is a private file: same O_NOFOLLOW + mode 0600 rule.
  const text = readPrivateFile(configPath, configPath);
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    fail(`${configPath} is not valid JSON; the gateway never overwrites an unreadable config`);
  }
  if (config?.version !== CONFIG_VERSION) fail(`${configPath} has an unsupported version`);
  return { config, configPath };
}

function writeConfig(configPath, config) {
  writePrivateFile(configPath, JSON.stringify(config, null, 2));
}

function envValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Reads a secret for `init`: flag file first, then environment. */
function secretSource(label, fileOption, environment, envName) {
  if (fileOption) return readPrivateFile(fileOption, label).trim();
  return envValue(environment, envName) ?? null;
}

function readUpstreamBase(value, label) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    fail(`${label} must be an exact HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail(`${label} must be HTTPS without credentials, query, or fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** One provider block of a models.yml, with its models checked for shape. */
function seededModels(document, provider) {
  const providers = document?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) fail("models.yml has no providers block");
  const names = Object.keys(providers);
  const name = provider ?? (names.length === 1 ? names[0] : null);
  if (!name) fail(`models.yml has ${names.length} providers; pass --open-models-provider`);
  const entry = providers[name];
  if (!entry || typeof entry !== "object") fail(`models.yml has no provider ${JSON.stringify(name)}`);
  const models = Array.isArray(entry.models) ? entry.models : [];
  if (models.length === 0) fail(`models.yml provider ${JSON.stringify(name)} declares no models`);
  return {
    provider: name,
    providerEntry: entry,
    models: models.map((model) => {
      if (typeof model?.id !== "string" || !MODEL_ID.test(model.id)) fail("models.yml has a model without a usable id");
      return model;
    }),
  };
}

const EMAIL_VERIFICATION_MODES = new Set(["required", "off"]);

/**
 * Builds a config from flags/environment on top of an existing one. The config
 * stores secret *paths*, never secret values, and records which single model
 * the operator enabled.
 */
export function resolveGatewayConfig({ options = {}, environment = process.env, previous = null } = {}) {
  const pick = (flag, name) => options[flag] ?? envValue(environment, name);
  const dataDir = path.resolve(pick("dataDir", "OMB_LOCAL_DATA_DIR") ?? previous?.dataDir ?? DEFAULT_DATA_DIR);
  const host = pick("host", "OMB_LOCAL_HOST") ?? previous?.host ?? "127.0.0.1";
  const publicHost = pick("publicHost", "OMB_LOCAL_PUBLIC_HOST") ?? previous?.publicHost ?? null;
  if (!LOOPBACK_HOSTS.has(host) && host !== "0.0.0.0" && host !== "::" && !publicHost) {
    fail("--public-host is required when binding a non-loopback address");
  }
  const port = Number(pick("port", "OMB_LOCAL_PORT") ?? previous?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("--port must be a TCP port");

  const emailFrom = pick("emailFrom", "OMB_LOCAL_EMAIL_FROM") ?? previous?.emailFrom ?? null;
  if (emailFrom !== null && !EMAIL.test(emailFrom)) fail("--email-from must be a valid address");

  // Secrets are copied into the data directory once and referenced by path.
  mkdirSync(path.join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
  const smtpInput = secretSource("--smtp-file", options.smtpFile, environment, "OMB_LOCAL_SMTP_URL");
  if (smtpInput !== null) {
    parseSmtpURL(smtpInput); // validated without echoing the credential
    writePrivateFile(secretPath(dataDir, SECRET_FILES.smtp), smtpInput);
  }
  const smtpConfigured = smtpInput !== null || hasSecret(dataDir, SECRET_FILES.smtp) || Boolean(previous?.smtp);
  if (smtpConfigured && emailFrom === null) fail("an SMTP URL needs --email-from: sign-in codes must have a sender");

  // Mail is a deliberate choice, independent of whether SMTP is configured.
  const modeInput = (pick("emailVerification", "OMB_LOCAL_EMAIL_VERIFICATION") ?? previous?.emailVerification ?? "")
    .toLowerCase();
  if (modeInput !== "" && !EMAIL_VERIFICATION_MODES.has(modeInput)) {
    fail("--email-verification must be `required` or `off`");
  }
  const emailVerification = modeInput === "" ? (smtpConfigured ? "required" : "off") : modeInput;
  if (emailVerification === "required" && !smtpConfigured) {
    fail("--email-verification required needs a configured SMTP URL and --email-from");
  }

  const upstreamBaseInput = pick("upstreamBase", "OMB_LOCAL_UPSTREAM_BASE");
  const upstreamBase = upstreamBaseInput !== undefined
    ? readUpstreamBase(upstreamBaseInput, "--upstream-base")
    : previous?.upstreamBase ?? null;

  const upstreamKeyInput = secretSource("--upstream-key-file", options.upstreamKeyFile, environment, "OMB_LOCAL_UPSTREAM_KEY");
  if (upstreamKeyInput !== null) {
    if (upstreamKeyInput.length < 8 || /\s/.test(upstreamKeyInput)) fail("the upstream key must be one non-whitespace token");
    writePrivateFile(secretPath(dataDir, SECRET_FILES.upstream), upstreamKeyInput);
  }

  const modelFile = pick("models", "OMB_LOCAL_MODELS") ?? previous?.modelFile ?? null;
  const openModelsFile = pick("openModels", "OMB_LOCAL_OPEN_MODELS") ?? previous?.openModelsFile ?? null;
  const openModelsProvider = pick("openModelsProvider", "OMB_LOCAL_OPEN_MODELS_PROVIDER")
    ?? previous?.openModelsProvider ?? null;
  const ratesSource = pick("rates", "OMB_LOCAL_RATES") ?? previous?.rates ?? null;
  const rate = (() => {
    const raw = pick("rate", "OMB_LOCAL_RATE") ?? previous?.rate ?? null;
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) fail("--rate must be a positive integer of micro-points per million tokens");
    return value;
  })();
  const maxOutputTokens = (() => {
    const value = Number(pick("maxOutputTokens", "OMB_LOCAL_MAX_OUTPUT_TOKENS") ?? previous?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
    if (!Number.isSafeInteger(value) || value < 1) fail("--max-output-tokens must be a positive integer");
    return value;
  })();

  const requestedDefault = pick("defaultModel", "OMB_LOCAL_DEFAULT_MODEL") ?? null;
  let models = previous?.models ?? null;
  let upstreamBaseFromModels = null;

  if (modelFile !== null) {
    // A full catalog file is the operator's own verified decision: every entry
    // keeps the enabled flag it declares.
    models = readCatalogFile(modelFile);
    if (previous && previous.defaultModel && !models.some((model) => model.id === previous.defaultModel && model.enabled)) {
      fail(`--default-model ${JSON.stringify(previous.defaultModel)} is not an enabled model in --models`);
    }
  } else if (openModelsFile !== null) {
    const document = readOpenModels(openModelsFile);
    const seeded = seededModels(document, openModelsProvider);
    const chosen = requestedDefault
      ?? previous?.defaultModel
      ?? (seeded.models.some((model) => model.id === "gpt-6-astra") ? "gpt-6-astra" : seeded.models[0]?.id ?? null);
    if (chosen === null) fail("models.yml declares no model to enable");
    if (!seeded.models.some((model) => model.id === chosen)) fail(`--default-model ${JSON.stringify(chosen)} is not in models.yml`);

    const rates = ratesSource === null ? new Map() : readRates(ratesSource, "--rates");
    if (rate !== null) {
      // The uniform rate prices the chosen model only.
      rates.set(chosen, {
        inputMicroPointsPerMillion: rate,
        cachedInputMicroPointsPerMillion: rate,
        outputMicroPointsPerMillion: rate,
      });
    }
    const catalog = validateCatalogFile(catalogFromOpenModels({
      document,
      provider: seeded.provider,
      rates,
      maxOutputTokens,
      pricingVersion: previous?.pricingVersion ?? "local-v1",
    }).catalog);
    // Enabling a model is a per-model operator decision: the mirror publishes
    // the chosen model and nothing else, whatever prices exist for the rest.
    models = catalog.filter((model) => model.id === chosen).map((model) => ({ ...model }));
    if (!models.some((model) => model.id === chosen && model.enabled)) {
      fail(`model ${JSON.stringify(chosen)} needs explicit rates: pass --rate or --rates before enabling it`);
    }
    upstreamBaseFromModels = typeof seeded.providerEntry.baseUrl === "string"
      ? readUpstreamBase(seeded.providerEntry.baseUrl, "models.yml baseUrl")
      : null;
  }

  const resolvedBase = upstreamBase ?? upstreamBaseFromModels ?? previous?.upstreamBase ?? null;
  const enabled = (models ?? []).filter((model) => model.enabled);
  const resolvedDefault = requestedDefault ?? previous?.defaultModel ?? enabled[0]?.id ?? null;
  if (resolvedDefault !== null && !enabled.some((model) => model.id === resolvedDefault)) {
    fail(`--default-model ${JSON.stringify(resolvedDefault)} is not an enabled model`);
  }
  const keyAvailable = hasSecret(dataDir, SECRET_FILES.upstream)
    || Boolean(openModelsFile ?? previous?.openModelsFile)
    || previous?.upstreamKeySource === "openModels";
  if (enabled.length > 0 && (!resolvedBase || !keyAvailable)) {
    fail("an enabled model needs an upstream base and an upstream key");
  }

  const operatorIds = (() => {
    const raw = options.operatorId ?? envValue(environment, "OMB_LOCAL_OPERATOR_IDS");
    if (raw === undefined) return previous?.operatorIds ?? [];
    return [...new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean))];
  })();
  for (const id of operatorIds) if (id.length > 128 || /\s/.test(id)) fail("--operator-id takes one account id per entry");

  return {
    version: CONFIG_VERSION,
    dataDir,
    host,
    port,
    publicHost,
    certFile: pick("cert", "OMB_LOCAL_CERT") ?? previous?.certFile ?? null,
    keyFile: pick("key", "OMB_LOCAL_KEY") ?? previous?.keyFile ?? null,
    emailFrom,
    smtp: smtpConfigured,
    emailVerification,
    upstreamBase: resolvedBase,
    // "file": <data-dir>/secrets/upstream-key; "openModels": re-read from the
    // caller's models.yml so exactly one copy of that key exists.
    upstreamKeySource: hasSecret(dataDir, SECRET_FILES.upstream)
      ? "file"
      : (openModelsFile ?? previous?.openModelsFile) ? "openModels" : "none",
    modelFile,
    openModelsFile: openModelsFile ?? previous?.openModelsFile ?? null,
    openModelsProvider: openModelsProvider ?? previous?.openModelsProvider ?? null,
    rates: ratesSource,
    rate,
    maxOutputTokens,
    models,
    defaultModel: resolvedDefault,
    operatorIds,
    pricingVersion: previous?.pricingVersion ?? "local-v1",
  };
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
  };
  if (config.emailFrom) vars.EMAIL_FROM = config.emailFrom;
  if (config.upstreamBase && config.models?.some((model) => model.enabled) && config.defaultModel) {
    vars.AI_UPSTREAM_BASE_URL = config.upstreamBase;
    vars.AI_MODELS = JSON.stringify(config.models);
    vars.AI_DEFAULT_MODEL = config.defaultModel;
    vars.AI_OPERATOR_USER_IDS = JSON.stringify(config.operatorIds ?? []);
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

/** Headers the Worker sets on its own upstream call, and nothing else. A
 * Worker request carries platform metadata (`host`, `cf-worker`, …) that must
 * never be replayed onto the operator's upstream. */
const EGRESS_HEADERS = Object.freeze(["accept", "accept-encoding", "authorization", "content-type"]);

/**
 * The Worker's own egress: a genuine outbound request to the configured
 * upstream. Only the Worker's own upstream headers travel, a redirect is
 * returned to the Worker (which asked not to follow one), and a transport
 * failure becomes a 502 instead of an empty response.
 */
async function directEgress(request) {
  // Diagnostics name the target and size only: never a header, body, prompt,
  // or credential.
  const trace = process.env.OMB_LOCAL_GATEWAY_DEBUG_EGRESS === "1";
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const headers = new Headers();
    for (const name of EGRESS_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (trace) console.error(`[local-gateway] egress ${request.method} ${request.url} ${body?.byteLength ?? 0}B`);
    const response = await fetch(request.url, { method: request.method, headers, body, redirect: "manual" });
    if (trace) console.error(`[local-gateway] egress reply ${response.status}`);
    return response;
  } catch (error) {
    console.error(`[local-gateway] egress failed: ${error?.message ?? error}`);
    return new Response(JSON.stringify({ error: "egress_failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
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

function runtimeOptions({ runtime, config, port, script, mail, bindings }) {
  const certificate = certificateFor(config);
  const workers = [{
    name: "openmausbot-local-gateway",
    modules: true,
    script,
    compatibilityDate: "2026-08-25",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    // The persistent database the Worker's `DB` binding resolves to.
    d1Databases: { DB: D1_NAME },
    ...(mail ? { serviceBindings: { EMAIL: { name: "openmausbot-local-mailer", entrypoint: "EmailSender" } } } : {}),
    outboundService: directEgress,
  }];
  if (mail) {
    workers.push({
      name: "openmausbot-local-mailer",
      modules: true,
      script: MAILER_SOURCE,
      compatibilityDate: "2026-08-25",
      compatibilityFlags: ["nodejs_compat"],
      serviceBindings: { MAIL: mail.handler },
    });
  }
  return runtime.convertV4MiniflareOptions({
    host: config.host === "localhost" ? "127.0.0.1" : config.host.replace(/^\[|\]$/g, ""),
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

  const mf = new runtime.Miniflare(runtimeOptions({
    runtime, config: effective, port: effective.port, script, mail, bindings,
  }));
  let closed = false;
  try {
    await mf.ready;
    const liveDb = await mf.getD1Database("DB");
    if (migrations.pending.length > 0) fail("the live runtime still reports pending migrations; refusing to serve a partial schema");
    trustGatewayCertificate(certificateFor(effective).certPath);
    const health = await gatewayRequest(`${origin}/healthz`, certificateFor(effective).certPath);
    if (!health.ok) throw new UsageError(`the Worker answered /healthz with ${health.status}; check the gateway configuration`);
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
    const certificate = certificateFor(effective).certPath;
    writeRuntime(effective, {
      pid: process.pid,
      origin,
      port: effective.port,
      configPath: configPathOf(effective),
      startedAt: new Date().toISOString(),
      capabilities,
      certificate,
      migrations: { applied: migrations.applied.length + migrations.ran.length, pending: migrations.pending.length },
    });
    return {
      origin,
      port: effective.port,
      config: effective,
      configPath,
      certificate,
      migrations,
      capabilities,
      db: () => liveDb,
      mail: mail ? mail.stats : null,
      /** Runs the Worker's scheduled handler once (expiry sweeps, reservation
       * recovery). */
      async runScheduled() {
        const response = await gatewayRequest(`${origin}/cdn-cgi/local/scheduled`, certificateFor(effective).certPath);
        return { status: response.status };
      },
      async status() {
        const response = await gatewayRequest(`${origin}/healthz`, certificateFor(effective).certPath);
        return { healthy: response.ok, status: response.status };
      },
      async close() {
        if (closed) return;
        closed = true;
        const current = readRuntime(effective.dataDir);
        if (current?.pid === process.pid) {
          try {
            unlinkSync(runtimeFile(effective.dataDir));
          } catch { /* never written, or already gone */ }
        }
        await mf.dispose();
      },
    };
  } catch (error) {
    await mf.dispose().catch(() => {});
    throw error;
  }
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

/** The operator's own identity. The password is used for this run only (from
 * the environment) and is never persisted; without it, the existing admin CLI
 * prompts for an emailed code. */
async function printWhoami({ config, origin, email, environment = process.env }) {
  const { createControlPlaneClient } = await import("../electron/control-plane-client.mjs");
  trustGatewayCertificate(certificateFor(config).certPath);
  const password = envValue(environment, "OMB_LOCAL_OPERATOR_PASSWORD");
  if (password) {
    const client = createControlPlaneClient({ baseURL: origin });
    const { user } = await client.signInWithPassword(email, password);
    process.stdout.write(`${JSON.stringify({ userId: user.id, email: user.email })}\n`);
    return;
  }
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "account-ai-admin.mjs"), "whoami",
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
        + `Remove the login service instead:  node scripts/local-gateway.mjs service uninstall --config ${configPath}`,
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
        + `Stop it first:  node scripts/local-gateway.mjs stop --config ${configPath}\n`
        + `Then install the login service:  node scripts/local-gateway.mjs service install --config ${configPath}`,
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
      ? `Restart the gateway to apply this (${path.join(ROOT, "scripts", "local-gateway.mjs")} service install, or stop then start). AI access and points are separate: \`node scripts/account-ai-admin.mjs enable|grant --origin <origin> --operator-email ${account.email}\`.`
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
