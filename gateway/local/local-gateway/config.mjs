import { spawnSync } from "node:child_process";
import { constants as fsConstants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";

import { catalogFromOpenModels, readCatalogFile, readOpenModels, readRates, validateCatalogFile } from "./models.mjs";
import { parseSmtpURL } from "./smtp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_VERSION = 1;
export const DEFAULT_DATA_DIR = path.join(ROOT, ".omb-scratch", "local-gateway");
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const SECRET_FILES = Object.freeze({ auth: "better-auth-secret", upstream: "upstream-key", smtp: "smtp-url" });
export class UsageError extends Error {}
/** A refusal that is not a usage mistake (an unregistered address, a running
 * gateway): the message is the whole answer, with no usage dump after it. */
export class RefusalError extends Error {}

export function fail(message) {
  throw new UsageError(message);
}

/* ── private files ─────────────────────────────────────────────────────── */

/** Reads a private file: opened O_NOFOLLOW, must be a regular file with mode
 * 0600 (or stricter). A symlink or shared file is refused, never repaired. */
export function readPrivateFile(file, label) {
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

export function writePrivateFile(file, value) {
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

export function secretPath(dataDir, name) {
  return path.join(dataDir, "secrets", name);
}

export function hasSecret(dataDir, name) {
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
export function certificateFor(config) {
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

export function writeConfig(configPath, config) {
  writePrivateFile(configPath, JSON.stringify(config, null, 2));
}

export function envValue(environment, name) {
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
export function seededModels(document, provider) {
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
