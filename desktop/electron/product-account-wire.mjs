// The account-AI wire boundary between main, the renderer bridge and the private
// runtime message. The account bearer, model tokens, upstream addresses and
// data directories never leave main; every value is copied field by field.

import { normalizeProductCa, productCaBindsOrigin } from "./product-ca.mjs";

export const PRODUCT_ACCOUNT_CHANNELS = Object.freeze({
  state: "product-account:state",
  requestCode: "product-account:request-code",
  verifyCode: "product-account:verify-code",
  refresh: "product-account:refresh",
  ledger: "product-account:ledger",
  operatorStatus: "product-account:operator-status",
  grantMaximum: "product-account:grant-maximum",
  signOut: "product-account:sign-out",
  close: "product-account:close",
  methods: "product-account:methods",
  signInWithPassword: "product-account:sign-in-password",
  signUp: "product-account:sign-up",
  confirmEmail: "product-account:confirm-email",
  requestPasswordReset: "product-account:request-password-reset",
  resetPassword: "product-account:reset-password",
  stateChanged: "product-account:state-changed",
});

const AI_STATES = new Set(["pending", "ready", "insufficient_balance", "suspended", "unavailable"]);
const AUTH_STATES = new Set(["signed_out", "signing_in", "signed_in", "unavailable"]);
const RUNTIME_STATES = new Set(["stopped", "starting", "ready", "error"]);
const PROTOCOLS = new Set(["chat", "responses"]);
const LEDGER_KINDS = new Set(["request", "enable", "disable", "grant", "settle"]);
const LEDGER_STATES = new Set(["reserved", "streaming", "review", "settled"]);
/** The gateway's model credential shape. */
const PRODUCT_AI_TOKEN = /^omb_product_ai_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_MODELS = 256;

const invalid = what => Object.assign(new Error(`invalid_${what}`), { code: `invalid_${what}` });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** https, or http for an isolated loopback fixture. */
function normalizeProductAiOrigin(value) {
  if (typeof value !== "string" || !value) throw invalid("origin");
  let url;
  try { url = new URL(value); } catch { throw invalid("origin"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw invalid("origin");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  throw invalid("origin");
}

function sanitizeModel(value) {
  if (!record(value)) return null;
  const { id, label, protocol, pricingVersion, inputMicroPointsPerMillion, cachedInputMicroPointsPerMillion, outputMicroPointsPerMillion, maxContextTokens, maxOutputTokens } = value;
  if (!text(id, 128) || !text(label, 200) || !PROTOCOLS.has(protocol) || !text(pricingVersion, 64) ||
      !count(inputMicroPointsPerMillion) || !count(cachedInputMicroPointsPerMillion) || !count(outputMicroPointsPerMillion) ||
      !count(maxContextTokens) || !count(maxOutputTokens) || maxContextTokens < 1 || maxOutputTokens < 1) return null;
  return { id, label, protocol, pricingVersion, inputMicroPointsPerMillion, cachedInputMicroPointsPerMillion, outputMicroPointsPerMillion, maxContextTokens, maxOutputTokens };
}

function sanitizeModels(value) {
  if (!Array.isArray(value) || value.length > MAX_MODELS) throw invalid("models");
  const models = value.map(sanitizeModel);
  if (models.some(model => model === null)) throw invalid("models");
  return models;
}

/** The sign-in ways the service published; nothing here is a credential. */
function sanitizeAuthMethods(value) {
  if (!record(value)) return null;
  const { password, emailCode, emailVerification } = value;
  if (!record(password) || password.enabled !== true
    || !count(password.minLength) || !count(password.maxLength)
    || password.minLength < 8 || password.maxLength > 256 || password.minLength > password.maxLength
    || !record(emailCode) || typeof emailCode.enabled !== "boolean"
    || (emailVerification !== "required" && emailVerification !== "off")) return null;
  return {
    password: { enabled: true, minLength: password.minLength, maxLength: password.maxLength },
    emailCode: { enabled: emailCode.enabled },
    emailVerification,
  };
}

function sanitizeProductAiStatus(value) {
  if (!record(value) || !AI_STATES.has(value.state) || value.unit !== "points" ||
      !count(value.availableMicroPoints) || !count(value.reservedMicroPoints) ||
      !(value.defaultModel === null || text(value.defaultModel, 128))) throw invalid("ai_status");
  return {
    state: value.state,
    unit: "points",
    availableMicroPoints: value.availableMicroPoints,
    reservedMicroPoints: value.reservedMicroPoints,
    defaultModel: value.defaultModel,
    models: sanitizeModels(value.models),
  };
}

/** The account state a renderer receives. */
export function sanitizeProductAccountState(value) {
  if (!record(value) || !AUTH_STATES.has(value.auth) || !RUNTIME_STATES.has(value.runtime)) throw invalid("account_state");
  const state = { auth: value.auth, runtime: value.runtime };
  if (value.user !== undefined) {
    if (!record(value.user) || !text(value.user.id, 128) || !text(value.user.email, 320)) throw invalid("account_state");
    state.user = { id: value.user.id, email: value.user.email };
  }
  if (value.ai !== undefined) state.ai = sanitizeProductAiStatus(value.ai);
  if (value.errorCode !== undefined) {
    if (!text(value.errorCode, 128)) throw invalid("account_state");
    state.errorCode = value.errorCode;
  }
  if (value.authMethods !== undefined) {
    const methods = sanitizeAuthMethods(value.authMethods);
    if (!methods) throw invalid("account_state");
    state.authMethods = methods;
  }
  if (value.pendingEmail !== undefined) {
    if (!text(value.pendingEmail, 320)) throw invalid("account_state");
    state.pendingEmail = value.pendingEmail;
  }
  return state;
}

export function sanitizeProductOperatorStatus(value) {
  if (!record(value) || typeof value.eligible !== "boolean") throw invalid("operator_status");
  if (!value.eligible) return { eligible: false };
  const { availableMicroPoints, reservedMicroPoints, maxGrantMicroPoints } = value;
  if (![availableMicroPoints, reservedMicroPoints, maxGrantMicroPoints].every(count)
    || BigInt(availableMicroPoints) + BigInt(reservedMicroPoints) + BigInt(maxGrantMicroPoints) !== BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("operator_status");
  return { eligible: true, availableMicroPoints, reservedMicroPoints, maxGrantMicroPoints };
}

export function sanitizeProductMaximumGrantResult(value) {
  if (!record(value) || !["granted", "already_max", "failed"].includes(value.outcome)
    || !count(value.amountMicroPoints)) throw invalid("grant_result");
  const result = { outcome: value.outcome, amountMicroPoints: value.amountMicroPoints, state: sanitizeProductAccountState(value.state) };
  if (value.operationId !== undefined) {
    if (typeof value.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId)) throw invalid("grant_result");
    result.operationId = value.operationId;
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== "string" || !/^[a-z0-9_]{1,128}$/.test(value.errorCode)) throw invalid("grant_result");
    result.errorCode = value.errorCode;
  }
  return result;
}

function sanitizeLedgerEntry(value) {
  if (!record(value) || !text(value.id, 128) || !LEDGER_KINDS.has(value.kind) || !count(value.createdAt) ||
      !optionalText(value.model, 128) || (value.state !== undefined && !LEDGER_STATES.has(value.state)) ||
      !optionalText(value.reason, 1000)) throw invalid("ledger_entry");
  const entry = { id: value.id, kind: value.kind, createdAt: value.createdAt };
  if (value.model !== undefined) entry.model = value.model;
  if (value.state !== undefined) entry.state = value.state;
  for (const field of ["amountMicroPoints", "reservedMicroPoints", "chargedMicroPoints", "inputTokens", "cachedInputTokens", "outputTokens"]) {
    if (value[field] === undefined) continue;
    if (!count(value[field])) throw invalid("ledger_entry");
    entry[field] = value[field];
  }
  if (value.reason !== undefined) entry.reason = value.reason;
  return entry;
}

export function sanitizeProductLedgerPage(value) {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50 ||
      !(value.nextCursor === null || text(value.nextCursor, 256))) throw invalid("ledger_page");
  return { items: value.items.map(sanitizeLedgerEntry), nextCursor: value.nextCursor };
}

function sanitizeConnection(value) {
  if (!record(value) || !text(value.userId, 128) || !text(value.tokenId, 128) || !PRODUCT_AI_TOKEN.test(value.token) ||
      !count(value.expiresAt) || value.expiresAt < 1 || !(value.defaultModel === null || text(value.defaultModel, 128)) ||
      !Array.isArray(value.models) || value.models.length === 0) throw invalid("product_ai_connection");
  const models = sanitizeModels(value.models);
  const defaultModel = value.defaultModel;
  if (defaultModel !== null && !models.some(model => model.id === defaultModel)) throw invalid("product_ai_connection");
  const origin = normalizeProductAiOrigin(value.origin);
  // The pinned certificate travels with the capability, so the runtime verifies
  // the same exact origin main does. It must cover that host; nothing else rides.
  const ca = value.ca === undefined ? null : normalizeProductCa(value.ca);
  if (value.ca !== undefined && (ca === null || !productCaBindsOrigin(ca, origin))) throw invalid("product_ai_connection");
  return {
    origin,
    userId: value.userId,
    tokenId: value.tokenId,
    token: value.token,
    expiresAt: value.expiresAt,
    defaultModel,
    models,
    ...(ca ? { ca } : {}),
  };
}

/**
 * The private `hezuo:product-ai` payload. A ready state always carries a
 * connection; a balance-empty account may keep one so accepted work finishes.
 */
export function parseProductAiUpdate(value) {
  if (!record(value) || !AI_STATES.has(value.state)) throw invalid("product_ai");
  let connection;
  try {
    connection = value.connection === undefined || value.connection === null ? null : sanitizeConnection(value.connection);
  } catch {
    throw invalid("product_ai");
  }
  // Only a usable account holds a live credential; anything else must release it.
  const holdsCredential = value.state === "ready" || value.state === "insufficient_balance";
  if (holdsCredential && connection !== null && connection.defaultModel === null) throw invalid("product_ai_connection");
  if (!holdsCredential && connection !== null) throw invalid("product_ai_connection");
  if (value.state === "ready" && connection === null) throw invalid("product_ai_connection");
  return { state: value.state, connection };
}

export function unavailableProductAccountState(errorCode = "state_unavailable") {
  return text(errorCode, 128) ? { auth: "unavailable", runtime: "stopped", errorCode } : { auth: "unavailable", runtime: "stopped" };
}
