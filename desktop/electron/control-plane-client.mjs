import { createPinnedHttpsFetch } from "./product-ca.mjs";

const INSTALLATION_CREDENTIAL =
  /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const PRODUCT_AI_CREDENTIAL =
  /^omb_product_ai_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const stringValue = (value) => (typeof value === "string" ? value : null);

const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const constructor = value.constructor;
    if (constructor === undefined || typeof constructor !== "function") return true;
    const prototype = constructor.prototype;
    return (
      typeof prototype === "object" &&
      prototype !== null &&
      Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")
    );
  } catch {
    return false;
  }
};

const plainObject = (value) => {
  if (!isPlainRecord(value)) return null;
  const record = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (typeof key !== "string") return null;
      if (key === "__proto__") continue;
      record[key] = value[key];
    }
  } catch {
    return null;
  }
  return record;
};

const validClientInstance = (value) => {
  const input = stringValue(value);
  return input !== null && CLIENT_INSTANCE.test(input);
};

const boundedSecret = (value, maximum = 8_192) =>
  typeof value === "string" &&
  value.length >= 20 &&
  value.length <= maximum &&
  /^\S+$/.test(value)
    ? value
    : null;

const reportableAppVersion = (value) => {
  const version = stringValue(value)?.trim() ?? "";
  if (version.length < 1 || version.length > 64) return null;
  for (const character of version) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) return null;
  }
  return version;
};

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export class ControlPlaneError extends Error {
  constructor(code, status = 0, requestId = "", retryAfterMs = 0) {
    super(code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
    this.requestId = REQUEST_ID.test(requestId) ? requestId : "";
    this.retryAfterMs =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
        : 0;
  }
}

/** Only the delay-seconds form is accepted; an HTTP date is ignored. */
function retryAfterMilliseconds(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!/^[0-9]{1,6}$/.test(input)) return 0;
  return Math.min(Number(input) * 1_000, MAX_RETRY_AFTER_MS);
}

const ENDPOINT_STATUSES = new Set([
  "pending",
  "provisioning",
  "ready",
  "deleting",
  "deleted",
  "error",
]);

function statusErrorCode(status) {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "control_plane_unavailable";
  return "request_failed";
}

/** HTTPS only, or loopback HTTP for a configured dev Worker; no path, credentials or query, so every request stays under the audited API. */
export function normalizeControlPlaneURL(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export function normalizeAccountEmail(value) {
  const input = stringValue(value);
  const email = input !== null && input.length <= 254 ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function validatedUser(value) {
  const user = plainObject(value);
  const email = normalizeAccountEmail(user?.email);
  const idInput = stringValue(user?.id);
  const id = idInput !== null && idInput.length >= 1 && idInput.length <= 256
    ? idInput
    : null;
  if (!email || !id) return null;
  return { id, email };
}

function validatedInstallation(value) {
  const installation = plainObject(value);
  const id = stringValue(installation?.id);
  const clientInstanceId = stringValue(installation?.clientInstanceId);
  if (
    id === null ||
    !INSTALLATION_ID.test(id) ||
    clientInstanceId === null ||
    !validClientInstance(clientInstanceId)
  ) {
    return null;
  }
  return {
    id,
    clientInstanceId,
    name: stringValue(installation.name) ?? "This computer",
    platform: installation.platform,
    appVersion: stringValue(installation.appVersion),
  };
}

function validatedEndpoint(value) {
  const endpoint = plainObject(value);
  const endpointURL = stringValue(endpoint?.url);
  if (endpointURL === null) return null;
  let url;
  try {
    url = new URL(endpointURL);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { url: url.origin };
}

const AI_STATES = new Set([
  "pending",
  "ready",
  "insufficient_balance",
  "suspended",
  "unavailable",
]);
const MODEL_PROTOCOLS = new Set(["chat", "responses"]);
const LEDGER_KINDS = new Set(["request", "enable", "disable", "grant", "settle"]);
const LEDGER_STATES = new Set(["reserved", "streaming", "review", "settled"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const microPoints = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const boundedText = (value, maximum) =>
  typeof value === "string" && value.length >= 1 && value.length <= maximum;

/** Prices, context ceilings and totals are all safe integers on the wire; a
 * malformed one rejects the whole status rather than displaying a wrong price. */
function validatedProductModel(value) {
  const model = plainObject(value);
  if (
    !model ||
    !boundedText(model.id, 128) ||
    !boundedText(model.label, 200) ||
    !MODEL_PROTOCOLS.has(model.protocol) ||
    !boundedText(model.pricingVersion, 64) ||
    !microPoints(model.inputMicroPointsPerMillion) ||
    !microPoints(model.cachedInputMicroPointsPerMillion) ||
    !microPoints(model.outputMicroPointsPerMillion) ||
    !positiveInteger(model.maxContextTokens) ||
    !positiveInteger(model.maxOutputTokens)
  ) {
    return null;
  }
  return {
    id: model.id,
    label: model.label,
    protocol: model.protocol,
    pricingVersion: model.pricingVersion,
    inputMicroPointsPerMillion: model.inputMicroPointsPerMillion,
    cachedInputMicroPointsPerMillion: model.cachedInputMicroPointsPerMillion,
    outputMicroPointsPerMillion: model.outputMicroPointsPerMillion,
    maxContextTokens: model.maxContextTokens,
    maxOutputTokens: model.maxOutputTokens,
  };
}

function validatedAiStatus(value) {
  const status = plainObject(value);
  if (
    !status ||
    !AI_STATES.has(status.state) ||
    status.unit !== "points" ||
    !microPoints(status.availableMicroPoints) ||
    !microPoints(status.reservedMicroPoints) ||
    !(status.defaultModel === null || boundedText(status.defaultModel, 128)) ||
    !Array.isArray(status.models) ||
    status.models.length > 200
  ) {
    return null;
  }
  const models = status.models.map(validatedProductModel);
  if (models.some((model) => model === null)) return null;
  return {
    state: status.state,
    unit: "points",
    availableMicroPoints: status.availableMicroPoints,
    reservedMicroPoints: status.reservedMicroPoints,
    defaultModel: status.defaultModel,
    models,
  };
}

/** Unknown new fields are ignored for forward compatibility; a malformed known
 * field rejects the page so a charge is never displayed from partial data. */
function validatedLedgerEntry(value) {
  const entry = plainObject(value);
  if (
    !entry ||
    !boundedText(entry.id, 128) ||
    !LEDGER_KINDS.has(entry.kind) ||
    !microPoints(entry.createdAt)
  ) {
    return null;
  }
  const optionalText = (key, maximum) =>
    entry[key] === undefined ? null : boundedText(entry[key], maximum) ? entry[key] : undefined;
  const optionalAmount = (key) =>
    entry[key] === undefined ? null : microPoints(entry[key]) ? entry[key] : undefined;
  const model = optionalText("model", 128);
  const state = entry.state === undefined ? null : LEDGER_STATES.has(entry.state) ? entry.state : undefined;
  const reason = optionalText("reason", 500);
  const fields = {
    amountMicroPoints: optionalAmount("amountMicroPoints"),
    reservedMicroPoints: optionalAmount("reservedMicroPoints"),
    chargedMicroPoints: optionalAmount("chargedMicroPoints"),
    inputTokens: optionalAmount("inputTokens"),
    cachedInputTokens: optionalAmount("cachedInputTokens"),
    outputTokens: optionalAmount("outputTokens"),
  };
  if (model === undefined || state === undefined || reason === undefined) return null;
  if (Object.values(fields).some((field) => field === undefined)) return null;
  const result = { id: entry.id, kind: entry.kind, createdAt: entry.createdAt };
  if (model !== null) result.model = model;
  if (state !== null) result.state = state;
  for (const [key, field] of Object.entries(fields)) if (field !== null) result[key] = field;
  if (reason !== null) result.reason = reason;
  return result;
}

function validatedLedgerPage(value) {
  const page = plainObject(value);
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 50 ||
    !(page.nextCursor === null || boundedText(page.nextCursor, 256))
  ) {
    return null;
  }
  const items = page.items.map(validatedLedgerEntry);
  if (items.some((item) => item === null)) return null;
  return { items, nextCursor: page.nextCursor };
}

/** An 8-digit emailed code, or "" when the input is not one. */
function normalizeOTP(value) {
  const input = stringValue(value);
  if (input === null || input.length > 32) return "";
  const otp = input.replaceAll(/\s|-/g, "");
  return /^\d{8}$/.test(otp) ? otp : "";
}

/**
 * A Better Auth sign-up/sign-in answer. The JSON `token` is its raw database
 * token and never leaves this module; only the signed bearer from
 * `set-auth-token` may cross the API boundary. A null token means the server
 * created no session (verification pending), which is a valid sign-up answer.
 */
function credentialResult(response, payload, email) {
  const user = validatedUser(plainObject(payload)?.user);
  if (!user || user.email !== email) throw new ControlPlaneError("invalid_response", response.status);
  const raw = response.headers.get("set-auth-token");
  if (raw === null) return { accountToken: null, user };
  const accountToken = boundedSecret(raw);
  if (!accountToken) throw new ControlPlaneError("invalid_response", response.status);
  return { accountToken, user };
}

export function createControlPlaneClient({
  baseURL,
  ca = null,
  fetchImpl,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = 15_000,
  healthTimeoutMs = 3_000,
}) {
  const origin = normalizeControlPlaneURL(baseURL);
  if (!origin) throw new ControlPlaneError("control_plane_unavailable");
  // A pinned deployment trusts its own public certificate for this origin
  // only: hostname and chain checks stay on, redirects stay refused, and no
  // other origin or process-wide TLS setting is touched.
  let transport = fetchImpl ?? globalThis.fetch;
  if (!fetchImpl && ca !== null) {
    try {
      transport = createPinnedHttpsFetch({ origin, ca });
    } catch {
      throw new ControlPlaneError("control_plane_unavailable");
    }
  }

  const request = async (
    path,
    { method = "GET", token, body, allowEmpty = false, deadlineMs = timeoutMs } = {},
  ) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    // Node's fetch sends `Sec-Fetch-Mode: cors`, which Better Auth 1.7 treats as a browser request needing a trusted Origin.
    // Send the validated origin to Better Auth routes only, rather than weakening the server's CSRF checks.
    if (path.startsWith("/api/auth/")) headers.set("origin", origin);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response;
    try {
      const init = {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(deadlineMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await transport(`${origin}${path}`, init);
    } catch {
      throw new ControlPlaneError("network_unavailable");
    }

    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const rawCode = stringValue(plainObject(payload)?.error);
      const code = rawCode !== null && /^[a-z0-9_]{1,64}$/.test(rawCode)
        ? rawCode
        : null;
      throw new ControlPlaneError(
        code ?? statusErrorCode(response.status),
        response.status,
        response.headers.get("x-request-id") ?? "",
        retryAfterMilliseconds(response.headers.get("retry-after")),
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new ControlPlaneError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountInstallations = async (accountToken) => {
    if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
    const { payload } = await request("/v1/installations", { token: accountToken });
    if (!Array.isArray(payload.installations)) {
      throw new ControlPlaneError("invalid_response");
    }
    const installations = payload.installations.map(validatedInstallation);
    if (installations.some((installation) => !installation)) {
      throw new ControlPlaneError("invalid_response");
    }
    return installations;
  };

  const operatorAccount = value => {
    const account = plainObject(value);
    if (!account || typeof account.userId !== "string" || !account.userId || account.userId.length > 128
      || !normalizeAccountEmail(account.email)
      || !Number.isSafeInteger(account.availableMicroPoints) || account.availableMicroPoints < 0
      || !Number.isSafeInteger(account.reservedMicroPoints) || account.reservedMicroPoints < 0) {
      throw new ControlPlaneError("invalid_response");
    }
    return { userId: account.userId, email: account.email,
      availableMicroPoints: account.availableMicroPoints, reservedMicroPoints: account.reservedMicroPoints };
  };

  return {
    origin,

    async operatorAiAccount(accountToken, rawEmail) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      const { payload } = await request(`/v1/operator/ai/account?email=${encodeURIComponent(email)}`, { token: accountToken });
      return operatorAccount(payload.account);
    },

    async operatorGrantAiBalance(accountToken, { operationId, userId, amountMicroPoints, reason }) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      if (!REQUEST_ID.test(operationId) || typeof userId !== "string" || !userId || userId.length > 128
        || !Number.isSafeInteger(amountMicroPoints) || amountMicroPoints <= 0
        || typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new ControlPlaneError("invalid_request");
      const { payload } = await request("/v1/operator/ai/balance", {
        token: accountToken, method: "POST", body: { operationId, userId, amountMicroPoints, reason },
      });
      if (payload.grantedMicroPoints !== amountMicroPoints || typeof payload.replayed !== "boolean") throw new ControlPlaneError("invalid_response");
      return { account: operatorAccount(payload.account), grantedMicroPoints: payload.grantedMicroPoints, replayed: payload.replayed };
    },

    async health() {
      const { payload } = await request("/healthz", {
        deadlineMs: Math.min(timeoutMs, healthTimeoutMs),
      });
      if (
        payload.ok !== true ||
        payload.service !== "openmausbot-control-plane"
      ) {
        throw new ControlPlaneError("control_plane_unavailable");
      }
      return true;
    },

    async requestOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      await request("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: { email, type: "sign-in" },
      });
      // The server answers known and unknown addresses alike; keep that enumeration-safe contract.
      return { email };
    },

    async verifyOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otpInput = stringValue(rawOTP);
      const otp = otpInput !== null && otpInput.length <= 32
        ? otpInput.replaceAll(/\s|-/g, "")
        : "";
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!/^\d{8}$/.test(otp)) throw new ControlPlaneError("invalid_otp");
      const { response, payload } = await request("/api/auth/sign-in/email-otp", {
        method: "POST",
        body: { email, otp, name: email.split("@", 1)[0] },
      });
      // Better Auth's JSON carries its raw database token; only the signed bearer from this header may cross our API boundary.
      const accountToken = boundedSecret(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    /** Which ways in this deployment offers (password always; emailed codes
     * only with a mail transport). Public and account-free. */
    async authMethods() {
      const { payload } = await request("/v1/auth/methods");
      const methods = plainObject(payload);
      const password = plainObject(methods?.password);
      const emailCode = plainObject(methods?.emailCode);
      if (
        !methods ||
        password?.enabled !== true ||
        !Number.isSafeInteger(password.minLength) ||
        !Number.isSafeInteger(password.maxLength) ||
        password.minLength < 8 ||
        password.maxLength > 256 ||
        typeof emailCode?.enabled !== "boolean" ||
        (methods.emailVerification !== "required" && methods.emailVerification !== "off")
      ) {
        throw new ControlPlaneError("invalid_response");
      }
      return {
        password: { enabled: true, minLength: password.minLength, maxLength: password.maxLength },
        emailCode: { enabled: emailCode.enabled },
        emailVerification: methods.emailVerification,
      };
    },

    /** Creates an email/password account. A deployment that requires an emailed
     * confirmation answers without a session (`accountToken: null`); the caller
     * then asks for the code. The password is sent once and never stored. */
    async signUpWithPassword(rawEmail, rawPassword) {
      const email = normalizeAccountEmail(rawEmail);
      const password = stringValue(rawPassword);
      if (!email) throw new ControlPlaneError("invalid_email");
      if (password === null || password.length < 10 || password.length > 128) {
        throw new ControlPlaneError("invalid_password");
      }
      const { response, payload } = await request("/api/auth/sign-up/email", {
        method: "POST",
        body: { email, password, name: email.split("@", 1)[0] },
      });
      return credentialResult(response, payload, email);
    },

    /** Signs in with an existing password. Unverified accounts are refused by
     * the server with `email_not_verified`, never silently admitted. */
    async signInWithPassword(rawEmail, rawPassword) {
      const email = normalizeAccountEmail(rawEmail);
      const password = stringValue(rawPassword);
      if (!email) throw new ControlPlaneError("invalid_email");
      if (password === null || password.length < 10 || password.length > 128) {
        throw new ControlPlaneError("invalid_password");
      }
      const { response, payload } = await request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email, password },
      });
      const result = credentialResult(response, payload, email);
      if (!result.accountToken) throw new ControlPlaneError("invalid_response", response.status);
      return result;
    },

    /** Confirms an address with the emailed code. No session is created; the
     * person signs in with the password afterwards. */
    async verifyEmailOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otp = normalizeOTP(rawOTP);
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!otp) throw new ControlPlaneError("invalid_otp");
      await request("/api/auth/email-otp/verify-email", { method: "POST", body: { email, otp } });
      return { email };
    },

    async requestPasswordResetOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      await request("/api/auth/email-otp/request-password-reset", { method: "POST", body: { email } });
      return { email };
    },

    async resetPasswordWithOTP(rawEmail, rawOTP, rawPassword) {
      const email = normalizeAccountEmail(rawEmail);
      const otp = normalizeOTP(rawOTP);
      const password = stringValue(rawPassword);
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!otp) throw new ControlPlaneError("invalid_otp");
      if (password === null || password.length < 10 || password.length > 128) {
        throw new ControlPlaneError("invalid_password");
      }
      await request("/api/auth/email-otp/reset-password", { method: "POST", body: { email, otp, password } });
      return { email };
    },

    async me(accountToken) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/me", { token: accountToken });
      const user = validatedUser(payload.user);
      if (!user) throw new ControlPlaneError("invalid_response");
      return user;
    },

    /** The account's own published AI state. `pending`/`suspended` carry no
     * catalog, so callers must never substitute a local fallback model. */
    async aiStatus(accountToken) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/account/ai", { token: accountToken });
      const status = validatedAiStatus(payload);
      if (!status) throw new ControlPlaneError("invalid_response");
      return status;
    },

    /** One short-lived model credential for this device. The raw token is only
     * returned here; it must never be written next to the login record. */
    async createAiToken(accountToken, deviceId) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      if (typeof deviceId !== "string" || !UUID.test(deviceId)) {
        throw new ControlPlaneError("invalid_request");
      }
      const { response, payload } = await request("/v1/account/ai/tokens", {
        method: "POST",
        token: accountToken,
        body: { deviceId },
      });
      const id = stringValue(payload.id);
      const token = stringValue(payload.token);
      if (
        response.status !== 201 ||
        id === null ||
        !UUID.test(id) ||
        token === null ||
        !PRODUCT_AI_CREDENTIAL.test(token) ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt <= 0
      ) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { id, token, expiresAt: payload.expiresAt };
    },

    /** Repeating a revocation is a no-op; an unknown or another account's id is
     * 404 and must not be retried as a transient failure. */
    async revokeAiToken(accountToken, tokenId) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      if (typeof tokenId !== "string" || !UUID.test(tokenId)) {
        throw new ControlPlaneError("invalid_request");
      }
      await request(`/v1/account/ai/tokens/${encodeURIComponent(tokenId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    /** The account's own charges and adjustments, newest first. */
    async aiLedger(accountToken, cursor) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      if (cursor !== undefined && (typeof cursor !== "string" || !boundedText(cursor, 256))) {
        throw new ControlPlaneError("invalid_request");
      }
      const query = typeof cursor === "string" && cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const { payload } = await request(`/v1/account/ai/ledger${query}`, { token: accountToken });
      const page = validatedLedgerPage(payload);
      if (!page) throw new ControlPlaneError("invalid_response");
      return page;
    },

    async listInstallations(accountToken) {
      return accountInstallations(accountToken);
    },

    async ensureInstallation({ accountToken, currentCredential, clientInstanceId, name, platform, appVersion }) {
      if (
        !validClientInstance(clientInstanceId)
      ) {
        throw new ControlPlaneError("invalid_client_identity");
      }

      if (
        typeof currentCredential === "string" &&
        INSTALLATION_CREDENTIAL.test(currentCredential)
      ) {
        try {
          const { payload } = await request("/v1/installations/self", { token: currentCredential });
          const installation = validatedInstallation(payload.installation);
          if (installation?.clientInstanceId === clientInstanceId) {
            return {
              installation,
              credential: currentCredential,
              credentialExpiresAt:
                Number.isSafeInteger(payload.credentialExpiresAt) ? payload.credentialExpiresAt : null,
            };
          }
        } catch (error) {
          // A transient outage must not rotate a usable identity; only a definitive 401 falls through to recovery.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }

      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const installations = await accountInstallations(accountToken);
      let existing = installations.find((item) => item.clientInstanceId === clientInstanceId);
      let result;
      if (existing) {
        result = await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
          method: "POST", token: accountToken,
        });
      } else {
        try {
          result = await request("/v1/installations", {
            method: "POST", token: accountToken, body: { clientInstanceId, name, platform, appVersion },
          });
        } catch (error) {
          if (!(error instanceof ControlPlaneError) || error.status !== 409 || error.code !== "installation_exists") throw error;
          existing = (await accountInstallations(accountToken)).find(item => item.clientInstanceId === clientInstanceId);
          if (!existing) throw error;
          result = await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST", token: accountToken,
          });
        }
      }
      const installation = existing ?? validatedInstallation(result.payload.installation);
      const credential = stringValue(result.payload.credential);
      if (!installation || credential === null || !INSTALLATION_CREDENTIAL.test(credential)) {
        throw new ControlPlaneError("invalid_response");
      }
      return {
        installation,
        credential,
        credentialExpiresAt:
          Number.isSafeInteger(result.payload.credentialExpiresAt)
            ? result.payload.credentialExpiresAt
            : null,
      };
    },

    async ensureEndpoint(installationCredential, { appVersion } = {}) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const version = reportableAppVersion(appVersion);
      const { payload } = await request("/v1/installations/self/endpoint", {
        method: "POST",
        token: installationCredential,
        ...(version === null ? {} : { body: { appVersion: version } }),
      });
      const endpoint = validatedEndpoint(payload.endpoint);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new ControlPlaneError("invalid_response");
      return { endpoint, connectorToken };
    },

    /** Never returns or requests a connector token. */
    async getEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const { payload } = await request("/v1/installations/self/endpoint", {
        token: installationCredential,
      });
      if (payload.endpoint === null) return null;
      const endpoint = validatedEndpoint(payload.endpoint);
      if (!endpoint) throw new ControlPlaneError("invalid_response");
      const status = stringValue(plainObject(payload.endpoint)?.status);
      return {
        url: endpoint.url,
        status: status !== null && ENDPOINT_STATUSES.has(status) ? status : "unknown",
      };
    },

    async deleteEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request("/v1/installations/self/endpoint", {
        method: "DELETE",
        token: installationCredential,
        allowEmpty: true,
      });
    },

    async revokeInstallation(accountToken, installationId) {
      if (
        !boundedSecret(accountToken) ||
        typeof installationId !== "string" ||
        !INSTALLATION_ID.test(installationId)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request(`/v1/installations/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedSecret(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        token: accountToken,
      });
    },
  };
}
