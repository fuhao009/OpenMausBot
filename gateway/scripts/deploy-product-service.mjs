#!/usr/bin/env node
// Deploy the hosted product's Worker from the operator's own Cloudflare account.
//
//   CLOUDFLARE_ACCOUNT_ID=… OMB_PRODUCT_SERVICE_URL=https://ai.<your-domain> \
//   OMB_PRODUCT_D1_ID=… EMAIL_FROM=noreply@<your-domain> \
//     node scripts/deploy-product-service.mjs --dry-run
//
//   CLOUDFLARE_ACCOUNT_ID=… OMB_PRODUCT_SERVICE_URL=https://ai.<your-domain> \
//   OMB_PRODUCT_D1_ID=… EMAIL_FROM=noreply@<your-domain> \
//   BETTER_AUTH_SECRET=… CLOUDFLARE_API_TOKEN=… \
//   AI_UPSTREAM_BASE_URL=… AI_UPSTREAM_API_KEY=… AI_DEFAULT_MODEL=… \
//   AI_MODELS='[…]' AI_OPERATOR_USER_IDS='[]' \
//     node scripts/deploy-product-service.mjs
//
// The script never deploys the checked-in wrangler.jsonc. It writes a separate
// temporary config under `.omb-scratch/product-service/` that reuses the Worker
// entry point and migrations but names the operator's own account, D1, route,
// and sender, turns tunnelling off, and carries only operator-supplied AI
// settings. The upstream project's account IDs, zones, routes, publishers, and
// model configuration are never copied into it.
//
// --dry-run compiles and validates the generated config; it never uploads,
// sets a secret, or applies a migration. Missing auth/D1/mail resources, or an
// origin the operator does not own, fail before any Wrangler call. A real
// deploy without AI upstream settings still deploys sign-in, with account AI
// `unavailable`.
//
// Secrets travel from the environment to Wrangler in a mode-0600 temporary
// file deleted afterwards; they never appear in argv, a persisted config, the
// log, or the summary.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAuthorDomain, operatorOrigin } from "../../scripts/product-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_DIR = path.join(root, "gateway", "control-plane");
const BASE_CONFIG = path.join(WORKER_DIR, "wrangler.jsonc");
// Wrangler resolves `main`, `migrations_dir`, and tsconfig relative to the
// config file, so the generated config lives beside the Worker sources. It
// contains no secret values and is gitignored.
const GENERATED_CONFIG = path.join(WORKER_DIR, "wrangler.product.generated.jsonc");
const SCRATCH = path.join(root, ".omb-scratch", "product-service");
const AUTH_SECRET = "BETTER_AUTH_SECRET";
const UPSTREAM_SECRET = "AI_UPSTREAM_API_KEY";
const MIN_AUTH_SECRET = 32;

const USAGE = `usage: node scripts/deploy-product-service.mjs [--dry-run [--synthetic]] [--help]

required environment (both modes):
  CLOUDFLARE_ACCOUNT_ID       the operator's 32-hex Cloudflare account id
  OMB_PRODUCT_SERVICE_URL     exact HTTPS origin the desktop pins (no path)
  OMB_PRODUCT_D1_ID           the operator's D1 database UUID
  EMAIL_FROM                  the verified sender address (required unless
                              AUTH_EMAIL_VERIFICATION='off')

required for a real deploy:
  BETTER_AUTH_SECRET          at least 32 random characters
  CLOUDFLARE_API_TOKEN        Wrangler credential (never a Worker secret)

optional account AI (absent: accounts sign in, AI reads unavailable):
  AI_UPSTREAM_BASE_URL, AI_UPSTREAM_API_KEY, AI_DEFAULT_MODEL,
  AI_MODELS, AI_OPERATOR_USER_IDS   (deployment-only upstream, prices, operators)

optional:
  AUTH_EMAIL_VERIFICATION     'required' (default with a sender) or 'off':
                              off deploys password accounts with no mail
  OMB_PRODUCT_D1_NAME         D1 database name (default: hezuo-product)
  OMB_PRODUCT_WORKER_NAME     Worker name (default: hezuo-product)
  BETTER_AUTH_URL             sign-in base URL (default: OMB_PRODUCT_SERVICE_URL)
  OMB_PRODUCT_CORS_ORIGINS    comma-separated extra allowed app origins
  OMB_PRODUCT_COMPAT_DATE     compatibility date (default: the checked-in one)

--synthetic is accepted only with --dry-run. It fills the operator resource
names with reserved, non-routable placeholders so the Worker bundle can be
compiled before those resources exist. It never uploads, never prints a
deployable origin, and refuses to combine with a real deploy.

A real deploy applies pending D1 migrations, then uploads the Worker with its
secrets. Account AI permission and balance stay operator actions
(scripts/account-ai-admin.mjs).`;

class UsageError extends Error {}

const RESOURCE_ID = /^[0-9a-f]{32}$/i;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const COMPATIBILITY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message) {
  throw new UsageError(message);
}

function parseArgs(argv) {
  // `pnpm run <script> -- args` forwards the separator itself in pnpm 10.
  const options = { dryRun: false, synthetic: false, help: false };
  for (const arg of argv.slice(argv[0] === "--" ? 1 : 0)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--synthetic") options.synthetic = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (options.synthetic && !options.dryRun) {
    fail("--synthetic is only valid with --dry-run: it exists to compile the bundle before the operator's resources exist");
  }
  return options;
}

/** Reserved, non-routable placeholders for a compile-only dry run. `.invalid`
 * never resolves (RFC 2606) and the zeroed IDs cannot name a real resource,
 * so a config generated this way can never be mistaken for a deployment. */
const SYNTHETIC = {
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  OMB_PRODUCT_SERVICE_URL: "https://product.invalid",
  OMB_PRODUCT_D1_ID: "00000000-0000-4000-8000-000000000000",
  EMAIL_FROM: "noreply@product.invalid",
  BETTER_AUTH_SECRET: "synthetic-compile-only-secret-not-a-credential",
};

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value.trim();
}

function optional(environment, name) {
  const value = environment[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The exact origin of the deployment, refused when it is not the operator's.
 * `allowReserved` is for the compile-only synthetic dry run. */
export function deploymentOrigin(environment = process.env, { allowReserved = false } = {}) {
  const raw = required(environment, "OMB_PRODUCT_SERVICE_URL");
  try {
    return operatorOrigin(raw, { allowReserved });
  } catch (error) {
    if (error?.message === "product_origin_author_domain") {
      fail("OMB_PRODUCT_SERVICE_URL must be a domain the operator owns; the upstream project's domains are refused");
    }
    if (error?.message === "product_origin_reserved_host") {
      fail("OMB_PRODUCT_SERVICE_URL must be a routable host the operator owns; documentation and fixture names are only accepted by --dry-run --synthetic");
    }
    if (error?.message === "product_origin_public_host") fail("OMB_PRODUCT_SERVICE_URL must name a public DNS host, not an IP address");
    if (error?.message === "product_origin_port") fail("OMB_PRODUCT_SERVICE_URL must use the default HTTPS port");
    fail("OMB_PRODUCT_SERVICE_URL must be one exact HTTPS origin (no path, credentials, query, or fragment)");
  }
}

function allowedOrigins(environment, origin, { allowReserved = false } = {}) {
  const raw = environment.OMB_PRODUCT_CORS_ORIGINS;
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length > 19) fail("OMB_PRODUCT_CORS_ORIGINS may list at most 19 extra origins");
  const origins = [];
  for (const entry of entries) {
    let parsed;
    try {
      parsed = operatorOrigin(entry, { allowReserved });
    } catch (error) {
      if (error?.message === "product_origin_author_domain") {
        fail(`OMB_PRODUCT_CORS_ORIGINS must not include the upstream project's domain: ${entry}`);
      }
      fail(`OMB_PRODUCT_CORS_ORIGINS entry is not an exact HTTPS origin: ${entry}`);
    }
    if (parsed !== origin) origins.push(parsed);
  }
  return [...new Set(origins)];
}

/** The catalog the Worker validates again; malformed entries fail here too. */
export function readModels(raw) {
  if (raw === null) return null;
  let models;
  try {
    models = JSON.parse(raw);
  } catch {
    fail("AI_MODELS must be a JSON array");
  }
  if (!Array.isArray(models) || models.length === 0) fail("AI_MODELS must be a nonempty JSON array");
  const seen = new Set();
  for (const [index, model] of models.entries()) {
    const label = `AI_MODELS[${index}]`;
    if (!model || typeof model !== "object" || Array.isArray(model)) fail(`${label} must be an object`);
    if (typeof model.id !== "string" || !MODEL_ID.test(model.id)) fail(`${label}.id must be a model id`);
    if (seen.has(model.id)) fail(`${label}.id is duplicated`);
    seen.add(model.id);
    if (typeof model.upstreamModel !== "string" || model.upstreamModel.trim() === "") fail(`${label}.upstreamModel is required`);
    if (model.protocol !== "chat" && model.protocol !== "responses") fail(`${label}.protocol must be chat or responses`);
    if (model.protocol === "chat" && model.chatMaxTokensField !== "max_tokens" && model.chatMaxTokensField !== "max_completion_tokens") {
      fail(`${label}.chatMaxTokensField must be max_tokens or max_completion_tokens for a chat model`);
    }
    for (const field of ["inputMicroPointsPerMillion", "outputMicroPointsPerMillion", "maxContextTokens", "maxOutputTokens"]) {
      // A disabled entry may ship unpriced; an enabled one must have rates, so
      // a missing price can only ever mean "not offered", never "free".
      const minimum = model.enabled || field.startsWith("max") ? 1 : 0;
      if (!Number.isSafeInteger(model[field]) || model[field] < minimum) {
        fail(`${label}.${field} must be a ${minimum === 1 ? "positive" : "nonnegative"} safe integer`);
      }
    }
    if (model.cachedInputMicroPointsPerMillion !== undefined &&
        (!Number.isSafeInteger(model.cachedInputMicroPointsPerMillion) || model.cachedInputMicroPointsPerMillion < 0)) {
      fail(`${label}.cachedInputMicroPointsPerMillion must be a nonnegative safe integer`);
    }
    if (model.maxOutputTokens > model.maxContextTokens) fail(`${label}.maxOutputTokens must not exceed its context`);
    if (typeof model.pricingVersion !== "string" || model.pricingVersion.trim() === "") fail(`${label}.pricingVersion is required`);
    if (typeof model.label !== "string" || model.label.trim() === "") fail(`${label}.label is required`);
    if (typeof model.enabled !== "boolean") fail(`${label}.enabled must be a boolean`);
  }
  return models;
}

function readOperatorIds(raw) {
  if (raw === null) return null;
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    fail("AI_OPERATOR_USER_IDS must be a JSON array of account user IDs");
  }
  if (!Array.isArray(ids)) fail("AI_OPERATOR_USER_IDS must be a JSON array of account user IDs");
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() !== id || id === "" || id.length > 128) {
      fail("AI_OPERATOR_USER_IDS must contain account user IDs only");
    }
  }
  return ids;
}

function readUpstreamBase(raw) {
  if (raw === null) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("AI_UPSTREAM_BASE_URL must be a valid HTTPS API base");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail("AI_UPSTREAM_BASE_URL must be an HTTPS base without credentials, query, or fragment");
  }
  if (isAuthorDomain(url.hostname)) fail("AI_UPSTREAM_BASE_URL must be the operator's model upstream");
  return raw.replace(/\/+$/, "");
}

function readUpstreamKey(raw) {
  if (raw === null) return null;
  if (raw.length < 8 || raw.length > 512 || /\s/.test(raw)) fail("AI_UPSTREAM_API_KEY must be one non-whitespace token");
  return raw;
}

/**
 * Everything a deploy needs, validated without touching Wrangler. Missing AI
 * settings leave the deployment auth-only (`ai: "unavailable"`); missing auth,
 * D1, or mail resources fail in both modes. Partial AI settings fail: a
 * half-configured upstream must never look configured.
 */
export function readProductDeployment(environment = process.env, { realDeploy = false, allowReserved = false } = {}) {
  const origin = deploymentOrigin(environment, { allowReserved });
  const accountId = required(environment, "CLOUDFLARE_ACCOUNT_ID");
  if (!RESOURCE_ID.test(accountId)) fail("CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID");
  const databaseId = required(environment, "OMB_PRODUCT_D1_ID");
  if (!DATABASE_ID.test(databaseId)) fail("OMB_PRODUCT_D1_ID must be a D1 database UUID");
  const workerName = optional(environment, "OMB_PRODUCT_WORKER_NAME") ?? "hezuo-product";
  if (!WORKER_NAME.test(workerName)) fail("OMB_PRODUCT_WORKER_NAME must be a lowercase Worker name");
  const databaseName = optional(environment, "OMB_PRODUCT_D1_NAME") ?? "hezuo-product";
  if (!WORKER_NAME.test(databaseName)) fail("OMB_PRODUCT_D1_NAME must be a lowercase D1 database name");
  // Emailed verification is the default where a sender exists. A deployment may
  // deliberately run without mail (`AUTH_EMAIL_VERIFICATION=off`): then a
  // password account needs no mail to sign up, and no sender is required.
  const verification = (optional(environment, "AUTH_EMAIL_VERIFICATION") ?? "").toLowerCase();
  if (verification !== "" && verification !== "required" && verification !== "off") {
    fail("AUTH_EMAIL_VERIFICATION must be `required` or `off`");
  }
  const emailVerification = verification === "off" ? "off" : "required";
  const rawFrom = optional(environment, "EMAIL_FROM");
  if (emailVerification === "required" && rawFrom === null) {
    fail("EMAIL_FROM is required unless AUTH_EMAIL_VERIFICATION=off");
  }
  if (rawFrom !== null && (!EMAIL.test(rawFrom) || rawFrom.length > 254)) fail("EMAIL_FROM must be a valid email address");
  const emailFrom = rawFrom;

  let authBaseURL;
  const rawAuthBase = optional(environment, "BETTER_AUTH_URL") ?? origin;
  try {
    authBaseURL = operatorOrigin(rawAuthBase, { allowReserved });
  } catch (error) {
    if (error?.message === "product_origin_author_domain") fail("BETTER_AUTH_URL must be a domain the operator owns");
    fail("BETTER_AUTH_URL must be one exact HTTPS origin");
  }
  const compatibilityDate = optional(environment, "OMB_PRODUCT_COMPAT_DATE");
  if (compatibilityDate && !COMPATIBILITY_DATE.test(compatibilityDate)) fail("OMB_PRODUCT_COMPAT_DATE must be YYYY-MM-DD");

  const models = readModels(optional(environment, "AI_MODELS"));
  const operatorIds = readOperatorIds(optional(environment, "AI_OPERATOR_USER_IDS"));
  const upstreamBaseURL = readUpstreamBase(optional(environment, "AI_UPSTREAM_BASE_URL"));
  const upstreamKey = readUpstreamKey(optional(environment, "AI_UPSTREAM_API_KEY"));
  const declaredDefault = optional(environment, "AI_DEFAULT_MODEL");
  // The documented bootstrap deploys with `AI_OPERATOR_USER_IDS=[]` and no
  // upstream yet: an empty list alone is not a partial AI configuration.
  const hasOperatorIds = Boolean(operatorIds && operatorIds.length > 0);
  const anyAiSetting = Boolean(upstreamBaseURL || upstreamKey || models || declaredDefault || hasOperatorIds);
  let defaultModel = null;
  if (anyAiSetting) {
    if (!upstreamBaseURL) fail("AI_UPSTREAM_BASE_URL is required together with the other AI settings");
    if (!models) fail("AI_MODELS is required together with the other AI settings");
    if (!declaredDefault) fail("AI_DEFAULT_MODEL is required together with the other AI settings");
    if (!operatorIds) fail("AI_OPERATOR_USER_IDS is required together with the other AI settings (use [])");
    if (!upstreamKey) fail("AI_UPSTREAM_API_KEY is required together with the other AI settings");
    if (!models.some((model) => model.id === declaredDefault && model.enabled)) {
      fail("AI_DEFAULT_MODEL must name an enabled model in AI_MODELS");
    }
    defaultModel = declaredDefault;
  }

  const authSecret = optional(environment, AUTH_SECRET);
  if (realDeploy) {
    if (!authSecret) fail(`${AUTH_SECRET} is required for a real deployment`);
    if (authSecret.length < MIN_AUTH_SECRET) fail(`${AUTH_SECRET} must contain at least ${MIN_AUTH_SECRET} characters`);
  }

  const origins = [origin, ...allowedOrigins(environment, origin, { allowReserved })];
  if (authBaseURL !== origin && !origins.includes(authBaseURL)) origins.push(authBaseURL);
  const aiConfigured = Boolean(upstreamBaseURL && models && defaultModel);
  const requiredSecrets = [AUTH_SECRET, ...(aiConfigured ? [UPSTREAM_SECRET] : [])];
  return {
    origin,
    accountId: accountId.toLowerCase(),
    databaseId,
    databaseName,
    workerName,
    emailFrom,
    emailVerification,
    authBaseURL,
    compatibilityDate,
    allowedOrigins: origins,
    models: models ?? [],
    defaultModel,
    upstreamBaseURL,
    upstreamKey,
    operatorIds: operatorIds ?? [],
    authSecret,
    ai: aiConfigured ? "configured" : "unavailable",
    requiredSecrets,
    vars: {
      BETTER_AUTH_URL: authBaseURL,
      ...(emailFrom === null ? {} : { EMAIL_FROM: emailFrom }),
      AUTH_EMAIL_VERIFICATION: emailVerification,
      ALLOWED_ORIGINS: [...new Set(origins.filter((value) => value !== origin))].join(","),
      ...(upstreamBaseURL ? {
        AI_UPSTREAM_BASE_URL: upstreamBaseURL,
        AI_DEFAULT_MODEL: defaultModel,
        AI_MODELS: JSON.stringify(models),
        AI_OPERATOR_USER_IDS: JSON.stringify(operatorIds ?? []),
      } : {}),
    },
  };
}

/** The generated Wrangler config: operator resources only, tunnelling off. */
export function productWorkerConfig(deployment, base = {}) {
  const compatibilityDate = deployment.compatibilityDate ?? base.compatibility_date;
  if (typeof compatibilityDate !== "string" || !COMPATIBILITY_DATE.test(compatibilityDate)) {
    throw new Error("cannot determine a compatibility date; pass OMB_PRODUCT_COMPAT_DATE");
  }
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: deployment.workerName,
    main: "src/index.ts",
    account_id: deployment.accountId,
    compatibility_date: compatibilityDate,
    compatibility_flags: Array.isArray(base.compatibility_flags) ? base.compatibility_flags : ["nodejs_compat"],
    workers_dev: false,
    routes: [{ pattern: new URL(deployment.origin).hostname, custom_domain: true }],
    vars: deployment.vars,
    secrets: { required: deployment.requiredSecrets },
    d1_databases: [{
      binding: "DB",
      database_name: deployment.databaseName,
      database_id: deployment.databaseId,
      migrations_dir: "migrations",
    }],
    ...(deployment.emailFrom === null
      ? {}
      : { send_email: [{ name: "EMAIL", allowed_sender_addresses: [deployment.emailFrom] }] }),
    triggers: { crons: ["*/5 * * * *"] },
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1 },
      traces: { enabled: true, head_sampling_rate: 0.05 },
    },
  };
}

/** wrangler.jsonc is JSON with comments and trailing commas. */
export function parseJsonc(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return JSON.parse(withoutTrailingCommas(output));
}

function withoutTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}

function wranglerBinary() {
  const name = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  // The Worker pins its own Wrangler (`gateway/control-plane` devDependency);
  // the root workspace may resolve an older copy. Prefer the pinned one.
  const pinned = path.join(WORKER_DIR, "node_modules", ".bin", name);
  return existsSync(pinned) ? pinned : path.join(root, "node_modules", ".bin", name);
}

function runWrangler(args, { configPath, env }) {
  // Worker secret values never belong in a child process environment: they are
  // handed over inside the 0600 --secrets-file instead. Strip them (and the
  // upstream key) so a Wrangler debug dump cannot echo them.
  const childEnv = { ...env };
  for (const name of [AUTH_SECRET, UPSTREAM_SECRET]) delete childEnv[name];
  const result = spawnSync(wranglerBinary(), [...args, "--config", configPath], {
    cwd: WORKER_DIR,
    env: childEnv,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw new Error(`wrangler could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed with exit code ${result.status ?? "unknown"}`);
}

async function pathExists(file) {
  return stat(file).then(() => true, () => false);
}

export async function deployProductService(options = { dryRun: false, synthetic: false }, environment = process.env) {
  if (options.synthetic && !options.dryRun) {
    fail("--synthetic is only valid with --dry-run: it exists to compile the bundle before the operator's resources exist");
  }
  // A synthetic dry run fills only missing operator resource names; values
  // already present win, so validating a real config stays unaffected.
  const source = options.synthetic
    ? {
      ...environment,
      ...Object.fromEntries(Object.entries(SYNTHETIC).filter(([name]) => {
        const value = environment[name];
        return typeof value !== "string" || value.trim() === "";
      })),
    }
    : environment;
  const deployment = readProductDeployment(source, { realDeploy: !options.dryRun, allowReserved: options.synthetic });
  const cloudflareToken = optional(source, "CLOUDFLARE_API_TOKEN") ?? optional(source, "CF_API_TOKEN");
  if (!options.dryRun && !cloudflareToken) fail("CLOUDFLARE_API_TOKEN is required for a real deployment");
  if (!(await pathExists(wranglerBinary()))) fail("wrangler is not installed; run pnpm install at the repository root");

  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true, mode: 0o700 });
  const base = parseJsonc(await readFile(BASE_CONFIG, "utf8"));
  const config = productWorkerConfig(deployment, base);
  // The generated config names the operator's account, D1, and origin but no
  // secret value; it is gitignored, rewritten on every run, and is the exact
  // file Wrangler deploys, so it can be inspected and diffed afterwards.
  const configPath = GENERATED_CONFIG;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const env = { ...environment };
  const summary = {
    dryRun: options.dryRun,
    synthetic: options.synthetic,
    origin: deployment.origin,
    authBaseURL: deployment.authBaseURL,
    workerName: deployment.workerName,
    databaseName: deployment.databaseName,
    emailFrom: deployment.emailFrom,
    emailVerification: deployment.emailVerification,
    ai: deployment.ai,
    models: deployment.models.map((model) => ({ id: model.id, protocol: model.protocol, enabled: model.enabled })),
    defaultModel: deployment.defaultModel,
    operatorCount: deployment.operatorIds.length,
    allowedOrigins: deployment.allowedOrigins,
    requiredSecrets: deployment.requiredSecrets,
    tunnelling: "disabled",
    configPath: path.relative(root, configPath),
  };

  if (options.dryRun) {
    // Compiles and validates the config; uploads nothing. Required secrets
    // become inherited bindings without a remote check in this mode.
    runWrangler(["deploy", "--dry-run", "--outdir", path.join(SCRATCH, "dist")], { configPath, env });
    summary.bundleDir = path.relative(root, path.join(SCRATCH, "dist"));
    summary.next = deployment.ai === "configured"
      ? "A real deploy applies migrations, uploads the Worker, and sets its secrets."
      : "Without AI settings a real deploy would still ship sign-in; account AI stays unavailable.";
    return summary;
  }

  // Apply migrations before the Worker that expects them, then upload with
  // its secrets in the same call (a new Worker cannot take secrets earlier).
  runWrangler(["d1", "migrations", "apply", "DB", "--remote"], { configPath, env });
  // JSON rather than dotenv: a random secret may contain "=" or newlines, and
  // the file exists only for this one call.
  const secretsPath = path.join(SCRATCH, "secrets.tmp.json");
  const secrets = { [AUTH_SECRET]: deployment.authSecret };
  if (deployment.requiredSecrets.includes(UPSTREAM_SECRET)) secrets[UPSTREAM_SECRET] = deployment.upstreamKey;
  await writeFile(secretsPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
  await chmod(secretsPath, 0o600);
  try {
    runWrangler(["deploy", "--secrets-file", secretsPath], { configPath, env });
  } finally {
    await rm(secretsPath, { force: true });
  }
  summary.next = [
    `Verify https://${new URL(deployment.origin).hostname}/healthz returns {"ok":true}.`,
    "Bootstrap: sign in with scripts/account-ai-admin.mjs whoami, add that user ID to AI_OPERATOR_USER_IDS, redeploy.",
    "Then enable and fund accounts with scripts/account-ai-admin.mjs.",
    "Bundle this origin into desktop builds with OMB_PRODUCT_SERVICE_URL=… node scripts/package-product.mjs.",
  ];
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const summary = await deployProductService(options);
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `[deploy-product-service] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
