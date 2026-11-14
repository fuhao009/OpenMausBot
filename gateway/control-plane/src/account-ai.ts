import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { ProductAiStatus, ProductModel } from "../../../packages/shared/product-account";
import { aiConfigFrom, findModel, publicModels, type AiConfig } from "./ai-config";
import { loadChannelCatalog, loadRuntimeAiConfig, probeChannel, saveChannelCatalog } from "./channel-store";
import { applyBillingCatalog, getBillingMetrics, loadBillingPolicy, saveBillingPolicy } from "./task-billing";
import {
  applyAdjustment,
  getBalance,
  getRequest,
  listLedger,
  listRequests,
  listReviewRequests,
  type Balance,
} from "./ai-wallet";
import { accountSession, type AuthPolicy, type ControlPlaneAuth } from "./auth";
import { HTTPError, JSON_HEADERS, readBoundedJSON } from "./http";
import { sha256 } from "./installations";

/**
 * Hosted-product account AI: permission, short-lived model credentials, and
 * the operator routes that grant permission and balance. Money and usage live
 * in `ai-wallet.ts`; upstream routing lives in `ai-config.ts`.
 */

export const PRODUCT_AI_TOKEN_PREFIX = "omb_product_ai_";
const PRODUCT_AI_TOKEN = /^omb_product_ai_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const MODEL_TOKEN_TTL_MS = 15 * 60 * 1_000;
/** One previous credential per device survives a renewal so the hand-off has
 * no gap; the database trigger enforces the same ceiling atomically. */
const TOKENS_PER_DEVICE = 2;
const ACCOUNT_ROUTE = /^\/v1\/account\/ai\/tokens\/([^/]+)$/;
const SETTLE_ROUTE = /^\/v1\/operator\/ai\/requests\/([^/]+)\/settle$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationIdSchema = z.string().regex(UUID);
const userIdSchema = z.string().min(1).max(128);
const reasonSchema = z.string().trim().min(1).max(500).refine((value) => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || point < 32 || point === 127) return false;
  }
  return true;
});
const microPointsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const createTokenSchema = z.strictObject({ deviceId: z.string().regex(UUID) });
const setAccountSchema = z.strictObject({
  operationId: operationIdSchema,
  userId: userIdSchema,
  enabled: z.boolean(),
  reason: reasonSchema,
});
const grantSchema = z.strictObject({
  operationId: operationIdSchema,
  userId: userIdSchema,
  amountMicroPoints: microPointsSchema.refine((value) => value > 0),
  reason: reasonSchema,
});
const settleSchema = z.strictObject({
  operationId: operationIdSchema,
  chargedMicroPoints: microPointsSchema,
  reason: reasonSchema,
});

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Product wire types are interfaces, which zod's JSON type cannot index, so
 * responses are serialized directly under the Worker's JSON headers. */
function wireJSON(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface ModelTokenAdmission {
  ownerUserId: string;
  tokenId: string;
  sessionId: string;
  deviceId: string;
}

interface TokenRow {
  id: string;
  owner_user_id: string;
  session_id: string;
  device_id: string;
  secret_hash: string;
  session_expires_at: string;
}

function aiStatus(balance: Balance | null, config: AiConfig): ProductAiStatus {
  const status = (state: ProductAiStatus["state"], models: ProductModel[] = [], defaultModel: string | null = null) => ({
    state,
    unit: "points" as const,
    availableMicroPoints: balance?.availableMicroPoints ?? 0,
    reservedMicroPoints: balance?.reservedMicroPoints ?? 0,
    defaultModel,
    models,
  });

  if (!balance || (!balance.enabled && balance.activatedAt === null)) return status("pending");
  if (!balance.enabled) return status("suspended");
  if (!config.ready) return status("unavailable");

  const model = config.defaultModel === null ? null : findModel(config, config.defaultModel);
  if (!model) return status("unavailable");
  const catalog = publicModels(config);
  const free = catalog.some((entry) => entry.inputMicroPointsPerMillion === 0
    && entry.cachedInputMicroPointsPerMillion === 0 && entry.outputMicroPointsPerMillion === 0);
  if (balance.availableMicroPoints === 0 && !free) {
    return status("insufficient_balance", catalog, config.defaultModel);
  }
  return status("ready", catalog, config.defaultModel);
}

async function signedInAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

/**
 * Admission for both inference routes and the free model catalog: the caller
 * presents a live model credential, its Better Auth session must still exist
 * and be unexpired, and the account must be enabled. Authorization is never
 * cached into a long-lived grant, so every call re-reads D1.
 */
export async function authenticateModelToken(
  env: Env,
  request: Request,
  config: AiConfig,
): Promise<ModelTokenAdmission> {
  const raw = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
  const parsed = raw?.match(PRODUCT_AI_TOKEN);
  if (!raw || !parsed) throw new HTTPError(401, "ai_token_invalid");

  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT t.id, t.owner_user_id, t.session_id, t.device_id, t.secret_hash,
            s."expiresAt" AS session_expires_at
       FROM account_ai_tokens t
       JOIN "session" s ON s.id = t.session_id AND s."userId" = t.owner_user_id
      WHERE t.lookup_id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.user_id = t.owner_user_id
          AND (l.disabled = 1 OR l.deleted = 1 OR l.password_change_required = 1))`,
  ).bind(parsed[1], now).first<TokenRow>();
  // Better Auth stores session dates as ISO-8601 text.
  const sessionExpiry = row === null ? Number.NaN : Date.parse(row.session_expires_at);
  if (!row || !Number.isFinite(sessionExpiry) || sessionExpiry <= now) {
    throw new HTTPError(401, "ai_token_invalid");
  }

  const expected = fromHex(row.secret_hash);
  if (!expected) throw new HTTPError(401, "ai_token_invalid");
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  if (!timingSafeEqual(actual, expected)) throw new HTTPError(401, "ai_token_invalid");

  const balance = await getBalance(env, row.owner_user_id);
  if (!balance || !balance.enabled) {
    throw new HTTPError(403, balance?.activatedAt == null ? "ai_not_enabled" : "ai_suspended");
  }
  if (!config.ready) throw new HTTPError(503, "ai_unavailable");

  return {
    ownerUserId: row.owner_user_id,
    tokenId: row.id,
    sessionId: row.session_id,
    deviceId: row.device_id,
  };
}

// ---------------------------------------------------------------------------
// Account routes
// ---------------------------------------------------------------------------

/** `GET /v1/account/ai` — the signed-in account's own status. */
async function accountAiStatus(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
): Promise<Response> {
  const session = await signedInAccount(request, auth);
  return wireJSON(aiStatus(await getBalance(env, session.user.id), config));
}

async function requireUsableAccount(
  env: Env,
  request: Request,
  auth: ControlPlaneAuth,
  config: AiConfig,
) {
  const session = await signedInAccount(request, auth);
  const status = aiStatus(await getBalance(env, session.user.id), config);
  if (status.state === "pending") throw new HTTPError(403, "ai_not_enabled");
  if (status.state === "suspended") throw new HTTPError(403, "ai_suspended");
  if (status.state === "unavailable") throw new HTTPError(503, "ai_unavailable");
  if (status.state === "insufficient_balance") throw new HTTPError(402, "insufficient_balance");
  return session;
}

/**
 * `POST /v1/account/ai/tokens` — issue one short-lived model credential for a
 * device. The raw token is returned once; only its hash is stored. A new
 * credential is issued only where it could actually be used.
 */
async function createModelToken(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
): Promise<Response> {
  const session = await requireUsableAccount(env, request, auth, config);
  const parsed = createTokenSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const now = Date.now();
  const expiresAt = now + MODEL_TOKEN_TTL_MS;
  const lookupId = base64URL(crypto.getRandomValues(new Uint8Array(16)));
  const raw = `${PRODUCT_AI_TOKEN_PREFIX}${lookupId}.${base64URL(crypto.getRandomValues(new Uint8Array(32)))}`;
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      // Retire this device's expired credentials before counting the ceiling.
      env.DB.prepare(
        `UPDATE account_ai_tokens SET revoked_at = ?
          WHERE owner_user_id = ? AND device_id = ? AND revoked_at IS NULL AND expires_at <= ?`,
      ).bind(now, session.user.id, parsed.data.deviceId, now),
      // Keep the newest for the renewal hand-off; revoked rows stay because
      // settled requests refer to them.
      env.DB.prepare(
        `UPDATE account_ai_tokens SET revoked_at = ?
          WHERE owner_user_id = ? AND device_id = ? AND revoked_at IS NULL
            AND id NOT IN (
              SELECT id FROM account_ai_tokens
               WHERE owner_user_id = ? AND device_id = ? AND revoked_at IS NULL
               ORDER BY created_at DESC, id DESC
               LIMIT ?
            )`,
      ).bind(
        now,
        session.user.id,
        parsed.data.deviceId,
        session.user.id,
        parsed.data.deviceId,
        TOKENS_PER_DEVICE - 1,
      ),
      env.DB.prepare(
        `INSERT INTO account_ai_tokens
          (id, owner_user_id, session_id, device_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        session.user.id,
        session.session.id,
        parsed.data.deviceId,
        lookupId,
        await sha256(raw),
        now,
        expiresAt,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /ai_token_(?:device|account)_limit/i.test(error.message)) {
      throw new HTTPError(409, "token_limit_reached");
    }
    throw error;
  }
  return wireJSON({ id, token: raw, expiresAt }, 201);
}

/**
 * `DELETE /v1/account/ai/tokens/:id` — revoke one of the account's own
 * credentials. Repeating it is a no-op; another account's id and an unknown
 * id are indistinguishable from absent.
 */
async function revokeModelToken(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  tokenId: string,
): Promise<Response> {
  const session = await signedInAccount(request, auth);
  if (!UUID.test(tokenId)) throw new HTTPError(404, "not_found");
  const owned = await env.DB.prepare(
    "SELECT id FROM account_ai_tokens WHERE id = ? AND owner_user_id = ?",
  ).bind(tokenId, session.user.id).first<{ id: string }>();
  if (!owned) throw new HTTPError(404, "not_found");
  await env.DB.prepare(
    "UPDATE account_ai_tokens SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL",
  ).bind(Date.now(), tokenId, session.user.id).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** `GET /v1/account/ai/ledger` — the account's own charges and adjustments. */
async function accountAiLedger(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await signedInAccount(request, auth);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  return wireJSON(await listLedger(env, session.user.id, cursor));
}

// ---------------------------------------------------------------------------
// Operator routes
// ---------------------------------------------------------------------------

async function requireOperator(
  request: Request,
  auth: ControlPlaneAuth,
  config: AiConfig,
) {
  const session = await signedInAccount(request, auth);
  if (!config.operatorUserIds.has(session.user.id)) throw new HTTPError(403, "forbidden");
  return session;
}

async function operatorAccountView(
  env: Env,
  userId: string,
  config: AiConfig,
) {
  const user = await env.DB.prepare('SELECT id, email, "emailVerified" AS emailVerified FROM "user" WHERE id = ? AND NOT EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.user_id = "user".id AND l.deleted = 1)')
    .bind(userId).first<{ id: string; email: string; emailVerified: number | string | boolean }>();
  if (!user) throw new HTTPError(404, "not_found");
  const balance = await getBalance(env, userId);
  return {
    userId: user.id,
    email: user.email,
    // Provenance, not a gate: whether this deployment ever confirmed the
    // address. It stays false where verification is off, and is never faked.
    emailVerified: user.emailVerified === true || user.emailVerified === 1 || user.emailVerified === "1",
    enabled: balance?.enabled ?? false,
    activatedAt: balance?.activatedAt ?? null,
    availableMicroPoints: balance?.availableMicroPoints ?? 0,
    reservedMicroPoints: balance?.reservedMicroPoints ?? 0,
    state: aiStatus(balance, config).state,
  };
}

/**
 * `GET /v1/operator/ai/account?email=…` — one exact address.
 *
 * Verified-only lookup would hide exactly the accounts this deployment creates
 * with `AUTH_EMAIL_VERIFICATION=off`, so the gate follows the deployment's own
 * policy: where confirmation is required an unconfirmed address stays hidden
 * (it could be someone typing another person's address), and where it is off
 * the address is the identity the person signed up with. The answer always
 * reports `emailVerified`, and nothing here writes it.
 */
async function operatorLookup(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
  policy: AuthPolicy,
): Promise<Response> {
  await requireOperator(request, auth, config);
  const email = z.email().max(254).safeParse(
    (new URL(request.url).searchParams.get("email") ?? "").trim().toLowerCase(),
  );
  if (!email.success) throw new HTTPError(400, "invalid_request");
  const user = await env.DB.prepare(
    'SELECT id, "emailVerified" AS emailVerified FROM "user" WHERE email = ?',
  ).bind(email.data).first<{ id: string; emailVerified: number | string | boolean }>();
  if (!user) throw new HTTPError(404, "not_found");
  const verified = user.emailVerified === true || user.emailVerified === 1 || user.emailVerified === "1";
  if (!verified && policy.emailVerification === "required") throw new HTTPError(404, "not_found");
  return wireJSON({ account: await operatorAccountView(env, user.id, config) });
}

/**
 * `POST /v1/operator/ai/account` — enable or disable AI for an existing
 * account. Idempotent per operation id; enabling preserves `activated_at`, so
 * a later disable reads as suspended rather than as a new registration.
 */
async function operatorSetAccount(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
): Promise<Response> {
  const operator = await requireOperator(request, auth, config);
  const parsed = setAccountSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const { operationId, userId, enabled, reason } = parsed.data;
  const kind = enabled ? "enable" : "disable";

  const applied = await applyAdjustment(env, {
    operationId,
    operatorUserId: operator.user.id,
    ownerUserId: userId,
    kind,
    enabled,
    reason,
  });
  return wireJSON({
    account: await operatorAccountView(env, userId, config),
    replayed: applied.status === "replayed",
  });
}

/** `POST /v1/operator/ai/balance` — positive credit only; never an overwrite. */
async function operatorGrantBalance(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
): Promise<Response> {
  const operator = await requireOperator(request, auth, config);
  const parsed = grantSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const { operationId, userId, amountMicroPoints, reason } = parsed.data;

  const applied = await applyAdjustment(env, {
    operationId,
    operatorUserId: operator.user.id,
    ownerUserId: userId,
    kind: "grant",
    amountMicroPoints,
    reason,
  });
  return wireJSON({
    account: await operatorAccountView(env, userId, config),
    grantedMicroPoints: amountMicroPoints,
    replayed: applied.status === "replayed",
  });
}

/** `GET /v1/operator/ai/requests?userId=…&cursor=…` — includes reviews. */
async function operatorListAccountRequests(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
): Promise<Response> {
  await requireOperator(request, auth, config);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const rawUserId = url.searchParams.get("userId");
  if (rawUserId === null && state === "review") {
    const page = await listReviewRequests(env, url.searchParams.get("cursor") ?? undefined);
    return wireJSON({ requests: page.items, nextCursor: page.nextCursor });
  }
  const userId = userIdSchema.safeParse(rawUserId ?? "");
  if (!userId.success || state !== null) throw new HTTPError(400, "invalid_request");
  const page = await listRequests(env, userId.data, url.searchParams.get("cursor") ?? undefined);
  return wireJSON({ requests: page.items, nextCursor: page.nextCursor });
}

/**
 * `POST /v1/operator/ai/requests/:id/settle` — settle a reviewed request
 * within its reservation, or release it with 0. The wallet refuses a second
 * settlement, so a refund can never run twice.
 */
async function operatorSettleRequest(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: AiConfig,
  requestId: string,
): Promise<Response> {
  const operator = await requireOperator(request, auth, config);
  const parsed = settleSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  if (!UUID.test(requestId)) throw new HTTPError(404, "not_found");
  const existing = await getRequest(env, requestId);
  if (!existing) throw new HTTPError(404, "not_found");
  const { operationId, chargedMicroPoints, reason } = parsed.data;

  const applied = await applyAdjustment(env, {
    operationId,
    operatorUserId: operator.user.id,
    ownerUserId: existing.userId,
    kind: "settle",
    requestId,
    amountMicroPoints: chargedMicroPoints,
    reason,
  });
  const updated = await getRequest(env, requestId);
  if (!updated) throw new HTTPError(500, "internal_error");
  return wireJSON({ request: updated, replayed: applied.status === "replayed" });
}

/**
 * Every account and operator route this module owns. Returns null for any
 * other request so the Worker can keep its existing routing order; each
 * handler reads its own (small) JSON body once.
 */
export async function routeAccountAi(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  policy: AuthPolicy,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  const tokenRoute = pathname.match(ACCOUNT_ROUTE);
  const settleRoute = pathname.match(SETTLE_ROUTE);
  if (pathname === "/v1/operator/billing" || pathname === "/v1/operator/billing/metrics") {
    const operator = await requireOperator(request, auth, aiConfigFrom(env));
    if (pathname.endsWith("/metrics") && method === "GET") return wireJSON(await getBillingMetrics(env));
    if (pathname === "/v1/operator/billing" && method === "GET") return wireJSON(await loadBillingPolicy(env));
    if (pathname === "/v1/operator/billing" && method === "POST") {
      return wireJSON(await saveBillingPolicy(env, operator.user.id, await readBoundedJSON(request, 64 * 1024)));
    }
    throw new HTTPError(405, "method_not_allowed");
  }
  const channelProbe = pathname.match(/^\/v1\/operator\/channels\/([A-Za-z0-9_-]+)\/probe$/);
  if (pathname === "/v1/operator/channels" || channelProbe) {
    const operator = await requireOperator(request, auth, aiConfigFrom(env));
    if (channelProbe && method === "POST") return wireJSON(await probeChannel(env, channelProbe[1], fetcher));
    if (!channelProbe && method === "GET") return wireJSON(await loadChannelCatalog(env));
    if (!channelProbe && method === "POST") {
      return wireJSON(await saveChannelCatalog(env, operator.user.id, await readBoundedJSON(request, 256 * 1024)));
    }
    throw new HTTPError(405, "method_not_allowed");
  }
  const matched = (pathname === "/v1/account/ai" && method === "GET")
    || (pathname === "/v1/account/ai/tokens" && method === "POST")
    || (pathname === "/v1/account/ai/ledger" && method === "GET")
    || (tokenRoute !== null && method === "DELETE")
    || (pathname === "/v1/operator/me" && method === "GET")
    || (pathname === "/v1/operator/ai/account" && (method === "GET" || method === "POST"))
    || (pathname === "/v1/operator/ai/balance" && method === "POST")
    || (pathname === "/v1/operator/ai/requests" && method === "GET")
    || (settleRoute !== null && method === "POST");
  if (!matched) return null;
  const config = await applyBillingCatalog(env, await loadRuntimeAiConfig(env));
  if (pathname === "/v1/operator/me") {
    const session = await requireOperator(request, auth, config);
    return wireJSON({
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
      capabilities: {
        ai: config.ready,
        password: true,
        emailCode: policy.mailConfigured,
        emailVerification: policy.emailVerification,
      },
      models: publicModels(config),
    });
  }

  if (pathname === "/v1/account/ai") return accountAiStatus(request, env, auth, config);
  if (pathname === "/v1/account/ai/tokens") return createModelToken(request, env, auth, config);
  if (pathname === "/v1/account/ai/ledger") return accountAiLedger(request, env, auth);
  if (tokenRoute) return revokeModelToken(request, env, auth, tokenRoute[1]);
  if (pathname === "/v1/operator/ai/account") {
    return method === "GET"
      ? operatorLookup(request, env, auth, config, policy)
      : operatorSetAccount(request, env, auth, config);
  }
  if (pathname === "/v1/operator/ai/balance") return operatorGrantBalance(request, env, auth, config);
  if (pathname === "/v1/operator/ai/requests") return operatorListAccountRequests(request, env, auth, config);
  if (settleRoute) return operatorSettleRequest(request, env, auth, config, settleRoute[1]);
  return null;
}
