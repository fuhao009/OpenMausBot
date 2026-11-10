import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { authenticateModelToken } from "../src/account-ai";
import { reserveRequest, reviewRequest } from "../src/ai-wallet";
import { aiConfigFrom, readAiConfig } from "../src/ai-config";
import { createAuth } from "../src/auth";
import { readAuthConfig } from "../src/config";
import worker from "../src/index";

const BASE_URL = "https://auth.hezuo.test";
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const UPSTREAM_KEY = "test-only-upstream-key-0123456789";

/** The plan's worked example: R = ceil((1000×2_000_000 + 100×4_000_000)/1e6)
 * = 2400 micro-points. */
const MODEL = {
  id: "m1",
  label: "Test model one",
  protocol: "chat",
  pricingVersion: "2026-11-01",
  inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000,
  outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  upstreamModel: "vendor/model-one",
  chatMaxTokensField: "max_tokens",
  enabled: true,
};

function aiEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1",
    AI_UPSTREAM_API_KEY: UPSTREAM_KEY,
    AI_DEFAULT_MODEL: MODEL.id,
    AI_MODELS: JSON.stringify([MODEL]),
    AI_OPERATOR_USER_IDS: "[]",
    ...overrides,
  } as unknown as Env;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  env?: Env;
}

let requestIp = 0;

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers();
  // Better Auth's per-IP sign-in limit is 10 per minute; each call gets its own
  // address so a suite with many test accounts never trips it.
  requestIp += 1;
  headers.set("cf-connecting-ip", `198.51.100.${requestIp % 250}`);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const request = new Request(`${BASE_URL}${path}`, { method: options.method ?? "GET", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, options.env ?? aiEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readAuthConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp, name: email.split("@", 1)[0] },
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  const payload = await response.json<{ user: { id: string; email: string } }>();
  if (!token) throw new Error("Better Auth did not return a signed bearer token");
  return { token, userId: payload.user.id, email };
}

/** Sign in the operator and let the following calls in this test treat that
 * account as the only operator. */
async function operatorSession(email = "operator@example.com") {
  const operator = await signIn(email);
  const env = aiEnv({ AI_OPERATOR_USER_IDS: JSON.stringify([operator.userId]) });
  return { ...operator, env };
}

async function enableAndGrant(userId: string, microPoints = 3_000) {
  const operator = await operatorSession();
  const enabled = await call("/v1/operator/ai/account", {
    method: "POST",
    token: operator.token,
    env: operator.env,
    body: { operationId: crypto.randomUUID(), userId, enabled: true, reason: "first approval" },
  });
  expect(enabled.status).toBe(200);
  const granted = await call("/v1/operator/ai/balance", {
    method: "POST",
    token: operator.token,
    env: operator.env,
    body: { operationId: crypto.randomUUID(), userId, amountMicroPoints: microPoints, reason: "welcome credit" },
  });
  expect(granted.status).toBe(200);
  return operator;
}

describe("hosted AI configuration", () => {
  it("treats an unconfigured deployment as unavailable instead of throwing", () => {
    const empty = readAiConfig({});
    expect(empty.ready).toBe(false);
    expect(empty.models).toEqual([]);
    expect(empty.upstreamBaseURL).toBeNull();
    expect(empty.issues).toContain("default_model_missing");

    const partial = readAiConfig({
      AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1",
      AI_DEFAULT_MODEL: MODEL.id,
      AI_MODELS: "{not json",
    });
    expect(partial.ready).toBe(false);
    expect(partial.issues).toContain("models_json");
    expect(partial.issues).toContain("upstream_key");
  });

  it("rejects an upstream base with credentials, query, or plain HTTP", () => {
    for (const value of [
      "http://upstream.example.test/v1",
      "https://user:pass@upstream.example.test/v1",
      "https://upstream.example.test/v1?key=secret",
      "https://upstream.example.test/v1#fragment",
      "not a url",
    ]) {
      const config = readAiConfig({ AI_UPSTREAM_BASE_URL: value });
      expect(config.upstreamBaseURL).toBeNull();
      expect(config.issues).toContain("upstream_url");
    }
    expect(readAiConfig({ AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1/" }).upstreamBaseURL)
      .toBe("https://upstream.example.test/v1");
  });

  it("keeps only usable catalog entries and defaults a missing cached price to input", () => {
    const config = readAiConfig({
      AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1",
      AI_UPSTREAM_API_KEY: UPSTREAM_KEY,
      AI_DEFAULT_MODEL: "m1",
      AI_MODELS: JSON.stringify([
        MODEL,
        { ...MODEL, id: "no-cached", cachedInputMicroPointsPerMillion: undefined },
        { ...MODEL, id: "chat-without-field", chatMaxTokensField: undefined },
        { ...MODEL, id: "duplicate-id" },
        { ...MODEL, id: "m1" },
        { ...MODEL, id: "over-context", maxOutputTokens: 2000 },
        { ...MODEL, id: "disabled", enabled: false },
        { id: "shape" },
      ]),
      AI_OPERATOR_USER_IDS: JSON.stringify(["op-1"]),
    });
    expect(config.ready).toBe(true);
    expect(config.models.map((model) => model.id)).toEqual(["m1", "no-cached", "duplicate-id", "disabled"]);
    expect(config.models[1].cachedInputMicroPointsPerMillion).toBe(MODEL.inputMicroPointsPerMillion);
    expect(config.models[2].cachedInputMicroPointsPerMillion).toBe(MODEL.cachedInputMicroPointsPerMillion);
    expect(config.issues).toEqual(expect.arrayContaining([
      "model_3_token_field",
      "model_5_duplicate",
      "model_6_context",
      "model_8_shape",
    ]));
    expect(config.operatorUserIds.has("op-1")).toBe(true);
  });

  it("fails closed on a malformed operator list instead of admitting a subset", () => {
    const config = readAiConfig({
      ...aiEnv(),
      AI_OPERATOR_USER_IDS: JSON.stringify(["op-1", 7]),
    });
    // One bad element invalidates the list: no survivor inherits permission.
    expect(config.operatorUserIds.size).toBe(0);
    expect(config.issues).toContain("operator_ids");
    expect(readAiConfig({ ...aiEnv(), AI_OPERATOR_USER_IDS: "op-1" }).operatorUserIds.size).toBe(0);
    expect(readAiConfig({ ...aiEnv(), AI_OPERATOR_USER_IDS: "" }).issues).not.toContain("operator_ids");
  });

  it("publishes no catalog entry the operator disabled or never priced", () => {
    const config = readAiConfig({
      AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1",
      AI_UPSTREAM_API_KEY: UPSTREAM_KEY,
      AI_DEFAULT_MODEL: "disabled",
      AI_MODELS: JSON.stringify([MODEL, { ...MODEL, id: "disabled", enabled: false }]),
    });
    // The declared default names a disabled model: nothing is ready, and no
    // silent fallback to another model replaces the operator's choice.
    expect(config.ready).toBe(false);
    expect(config.defaultModel).toBeNull();
    expect(readAiConfig({ ...aiEnv(), AI_DEFAULT_MODEL: "missing" }).defaultModel).toBeNull();
  });
});

describe("account AI status and credentials", () => {
  it("registers a public account as pending with no balance and no credential", async () => {
    const account = await signIn("newcomer@example.com");
    const status = await call("/v1/account/ai", { token: account.token });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      state: "pending",
      unit: "points",
      availableMicroPoints: 0,
      reservedMicroPoints: 0,
      defaultModel: null,
      models: [],
    });

    // Pending accounts cannot mint a credential, even with a valid deployment.
    const issue = await call("/v1/account/ai/tokens", {
      method: "POST",
      token: account.token,
      body: { deviceId: DEVICE_A },
    });
    expect(issue.status).toBe(403);
    await expect(issue.json()).resolves.toEqual({ error: "ai_not_enabled" });

    const ledger = await call("/v1/account/ai/ledger", { token: account.token });
    expect(ledger.status).toBe(200);
    await expect(ledger.json()).resolves.toEqual({ items: [], nextCursor: null });

    expect((await call("/v1/account/ai")).status).toBe(401);
  });

  it("reports an enabled account below one reservation as insufficient balance", async () => {
    const account = await signIn("short@example.com");
    const operator = await enableAndGrant(account.userId, 2_399);
    const status = await call("/v1/account/ai", { token: account.token, env: operator.env });
    const body = await status.json<{ state: string; unit: string; availableMicroPoints: number; defaultModel: string | null }>();
    expect(body.state).toBe("insufficient_balance");
    // Published amounts are the product's own points, never a currency.
    expect(body.unit).toBe("points");
    expect(body).not.toHaveProperty("currency");
    expect(body.availableMicroPoints).toBe(2_399);
    // The catalog stays visible: the account can see what it would buy.
    expect(body.defaultModel).toBe("m1");

    const issue = await call("/v1/account/ai/tokens", {
      method: "POST",
      token: account.token,
      env: operator.env,
      body: { deviceId: DEVICE_A },
    });
    expect(issue.status).toBe(402);
    await expect(issue.json()).resolves.toEqual({ error: "insufficient_balance" });
  });

  it("moves to ready once the balance covers one reservation and issues a device credential", async () => {
    const account = await signIn("ready@example.com");
    const operator = await enableAndGrant(account.userId, 2_400);

    const status = await call("/v1/account/ai", { token: account.token, env: operator.env });
    const body = await status.json<{
      state: string;
      defaultModel: string;
      models: Array<{ id: string; maxContextTokens: number }>;
    }>();
    expect(body.state).toBe("ready");
    expect(body.defaultModel).toBe("m1");
    expect(body.models).toEqual([expect.objectContaining({ id: "m1", maxContextTokens: 1000 })]);

    const issued = await call("/v1/account/ai/tokens", {
      method: "POST",
      token: account.token,
      env: operator.env,
      body: { deviceId: DEVICE_A },
    });
    expect(issued.status).toBe(201);
    const credential = await issued.json<{ id: string; token: string; expiresAt: number }>();
    expect(credential.token).toMatch(/^omb_product_ai_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    // The account bearer endpoint never echoes the credential.
    expect(await (await call("/v1/account/ai", { token: account.token, env: operator.env })).text())
      .not.toContain(credential.token);

    const request = new Request(`${BASE_URL}/v1/ai/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}` },
    });
    await expect(authenticateModelToken(operator.env, request, aiConfigFrom(operator.env)))
      .resolves.toEqual(expect.objectContaining({ ownerUserId: account.userId, tokenId: credential.id }));
  });

  it("keeps the previous credential across a renewal and refuses foreign ids", async () => {
    const account = await signIn("renew@example.com");
    const other = await signIn("other@example.com");
    const operator = await enableAndGrant(account.userId, 10_000);

    const issue = async (token: string, deviceId: string) => {
      const response = await call("/v1/account/ai/tokens", {
        method: "POST", token, env: operator.env, body: { deviceId },
      });
      expect(response.status).toBe(201);
      return response.json<{ id: string; token: string }>();
    };
    const first = await issue(account.token, DEVICE_A);
    const second = await issue(account.token, DEVICE_A);
    const admissionFor = async (token: string) => {
      const request = new Request(`${BASE_URL}/v1/ai/models`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return authenticateModelToken(operator.env, request, aiConfigFrom(operator.env));
    };
    // Both survive the hand-off, so a renewal never interrupts a running turn.
    await expect(admissionFor(first.token)).resolves.toBeTruthy();
    await expect(admissionFor(second.token)).resolves.toBeTruthy();

    const third = await issue(account.token, DEVICE_A);
    await expect(admissionFor(first.token)).rejects.toMatchObject({ code: "ai_token_invalid" });
    await expect(admissionFor(second.token)).resolves.toBeTruthy();

    // Another account cannot revoke what it does not own.
    expect((await call(`/v1/account/ai/tokens/${third.id}`, {
      method: "DELETE", token: other.token, env: operator.env,
    })).status).toBe(404);
    expect((await call(`/v1/account/ai/tokens/${third.id}`, {
      method: "DELETE", token: account.token, env: operator.env,
    })).status).toBe(204);
    expect((await call(`/v1/account/ai/tokens/${third.id}`, {
      method: "DELETE", token: account.token, env: operator.env,
    })).status).toBe(204);
    await expect(admissionFor(third.token)).rejects.toMatchObject({ code: "ai_token_invalid" });
  });

  it("stops admission when the account is disabled or its session is signed out", async () => {
    const account = await signIn("revoked@example.com");
    const operator = await enableAndGrant(account.userId, 10_000);
    const issued = await call("/v1/account/ai/tokens", {
      method: "POST", token: account.token, env: operator.env, body: { deviceId: DEVICE_B },
    });
    const credential = await issued.json<{ token: string }>();
    const admission = () => authenticateModelToken(
      operator.env,
      new Request(`${BASE_URL}/v1/ai/models`, { headers: { authorization: `Bearer ${credential.token}` } }),
      aiConfigFrom(operator.env),
    );
    await expect(admission()).resolves.toBeTruthy();

    // Signing out deletes the session row; the model credential dies with it.
    expect((await call("/api/auth/sign-out", {
      method: "POST", token: account.token, env: operator.env,
    })).status).toBe(200);
    await expect(admission()).rejects.toMatchObject({ status: 401, code: "ai_token_invalid" });

    const again = await signIn("revoked@example.com");
    expect(again.userId).toBe(account.userId);
    const replacement = await call("/v1/account/ai/tokens", {
      method: "POST", token: again.token, env: operator.env, body: { deviceId: DEVICE_B },
    });
    const replacementToken = (await replacement.json<{ token: string }>()).token;

    const disabled = await call("/v1/operator/ai/account", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: account.userId, enabled: false, reason: "payment review" },
    });
    expect(disabled.status).toBe(200);
    await expect(authenticateModelToken(
      operator.env,
      new Request(`${BASE_URL}/v1/ai/models`, { headers: { authorization: `Bearer ${replacementToken}` } }),
      aiConfigFrom(operator.env),
    )).rejects.toMatchObject({ status: 403, code: "ai_suspended" });

    // Disabling neither mints a new credential nor erases the old one's
    // admission reason; suspension surfaces before balance.
    const state = await call("/v1/account/ai", { token: again.token, env: operator.env });
    await expect(state.json()).resolves.toEqual(expect.objectContaining({ state: "suspended" }));
    const issue = await call("/v1/account/ai/tokens", {
      method: "POST", token: again.token, env: operator.env, body: { deviceId: DEVICE_A },
    });
    expect(issue.status).toBe(403);
    await expect(issue.json()).resolves.toEqual({ error: "ai_suspended" });
  });

  it("treats an unconfigured deployment as unavailable for an enabled account", async () => {
    const account = await signIn("noupstream@example.com");
    const operator = await enableAndGrant(account.userId, 10_000);
    const broken = aiEnv({
      AI_OPERATOR_USER_IDS: JSON.stringify([operator.userId]),
      AI_UPSTREAM_API_KEY: "",
    });
    const status = await call("/v1/account/ai", { token: account.token, env: broken });
    const body = await status.json<{ state: string; models: unknown[] }>();
    expect(body.state).toBe("unavailable");
    expect(body.models).toEqual([]);

    const issue = await call("/v1/account/ai/tokens", {
      method: "POST", token: account.token, env: broken, body: { deviceId: DEVICE_A },
    });
    expect(issue.status).toBe(503);
    await expect(issue.json()).resolves.toEqual({ error: "ai_unavailable" });
  });

  it("rejects a malformed ledger cursor", async () => {
    const account = await signIn("cursor@example.com");
    const response = await call("/v1/account/ai/ledger?cursor=not-a-cursor", { token: account.token });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_cursor" });
  });
});

describe("operator administration", () => {
  it("refuses operator routes to a regular account", async () => {
    const account = await signIn("regular@example.com");
    const target = await signIn("target@example.com");
    const enable = await call("/v1/operator/ai/account", {
      method: "POST",
      token: account.token,
      body: { operationId: crypto.randomUUID(), userId: target.userId, enabled: true, reason: "self service" },
    });
    expect(enable.status).toBe(403);
    await expect(enable.json()).resolves.toEqual({ error: "forbidden" });
    expect((await call(`/v1/operator/ai/account?email=${encodeURIComponent(target.email)}`, {
      token: account.token,
    })).status).toBe(403);
    expect((await call(`/v1/operator/ai/requests?userId=${target.userId}`, {
      token: account.token,
    })).status).toBe(403);
    expect((await call("/v1/operator/ai/balance", {
      method: "POST",
      token: account.token,
      body: { operationId: crypto.randomUUID(), userId: account.userId, amountMicroPoints: 1_000_000, reason: "self grant" },
    })).status).toBe(403);
  });

  it("looks up a verified account by exact email and enables it once", async () => {
    const operator = await operatorSession();
    const target = await signIn("person@example.com");

    const missing = await call("/v1/operator/ai/account?email=nobody%40example.com", {
      token: operator.token, env: operator.env,
    });
    expect(missing.status).toBe(404);
    expect((await call("/v1/operator/ai/account?email=not-an-email", {
      token: operator.token, env: operator.env,
    })).status).toBe(400);

    const lookup = await call(`/v1/operator/ai/account?email=${encodeURIComponent(target.email)}`, {
      token: operator.token, env: operator.env,
    });
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toEqual({
      account: {
        userId: target.userId,
        email: target.email,
        // Reported, never a gate here: this deployment confirms addresses by
        // email code, so this account signed in only after confirmation.
        emailVerified: true,
        enabled: false,
        activatedAt: null,
        availableMicroPoints: 0,
        reservedMicroPoints: 0,
        state: "pending",
      },
    });

    const operationId = crypto.randomUUID();
    const enable = () => call("/v1/operator/ai/account", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId, userId: target.userId, enabled: true, reason: "approved" },
    });
    const first = await enable();
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ account: { state: string }; replayed: boolean }>();
    expect(firstBody).toMatchObject({ replayed: false, account: { state: "insufficient_balance" } });

    const replay = await enable();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true });

    const conflict = await call("/v1/operator/ai/account", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId, userId: target.userId, enabled: false, reason: "approved" },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "operation_conflict" });
  });

  it("grants balance idempotently and never creates an account", async () => {
    const operator = await operatorSession();
    const target = await signIn("funded@example.com");
    await call("/v1/operator/ai/account", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: target.userId, enabled: true, reason: "approved" },
    });

    const operationId = crypto.randomUUID();
    const grant = () => call("/v1/operator/ai/balance", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId, userId: target.userId, amountMicroPoints: 1_000_000, reason: "welcome" },
    });
    await expect((await grant()).json()).resolves.toMatchObject({ grantedMicroPoints: 1_000_000, replayed: false });
    await expect((await grant()).json()).resolves.toMatchObject({ account: { availableMicroPoints: 1_000_000 }, replayed: true });
    const replayState = await call("/v1/account/ai", { token: target.token, env: operator.env });
    await expect(replayState.json()).resolves.toMatchObject({ availableMicroPoints: 1_000_000, state: "ready" });

    const otherBody = await call("/v1/operator/ai/balance", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId, userId: target.userId, amountMicroPoints: 2_000_000, reason: "welcome" },
    });
    expect(otherBody.status).toBe(409);

    expect((await call("/v1/operator/ai/balance", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: target.userId, amountMicroPoints: 0, reason: "zero" },
    })).status).toBe(400);

    const ghost = await call("/v1/operator/ai/balance", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: "no-such-user", amountMicroPoints: 1_000, reason: "typo" },
    });
    expect(ghost.status).toBe(404);
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind("no-such-user").first()).toBeNull();
  });

  it("requires an operation id and a reason for every mutation", async () => {
    const operator = await operatorSession();
    const target = await signIn("validation@example.com");
    for (const body of [
      { userId: target.userId, enabled: true, reason: "no id" },
      { operationId: "not-a-uuid", userId: target.userId, enabled: true, reason: "bad id" },
      { operationId: crypto.randomUUID(), userId: target.userId, enabled: true },
      { operationId: crypto.randomUUID(), userId: target.userId, enabled: true, reason: "  " },
      { operationId: crypto.randomUUID(), userId: target.userId, enabled: true, reason: "line\nbreak" },
      { operationId: crypto.randomUUID(), userId: target.userId, enabled: "yes", reason: "wrong type" },
    ]) {
      const response = await call("/v1/operator/ai/account", {
        method: "POST", token: operator.token, env: operator.env, body,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS total FROM account_ai_adjustments").first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });

  it("lists a user's requests and settles one only within its reservation", async () => {
    const operator = await operatorSession();
    const target = await signIn("reviewed@example.com");
    await call("/v1/operator/ai/account", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: target.userId, enabled: true, reason: "approved" },
    });
    await call("/v1/operator/ai/balance", {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: target.userId, amountMicroPoints: 10_000, reason: "credit" },
    });

    // A real reservation that ended without trustworthy usage, exactly as the
    // gateway leaves one for review.
    const credential = await call("/v1/account/ai/tokens", {
      method: "POST",
      token: target.token,
      env: operator.env,
      body: { deviceId: DEVICE_A },
    });
    const tokenId = (await credential.json<{ id: string }>()).id;
    const reserved = await reserveRequest(operator.env, {
      endpoint: "chat",
      model: MODEL.id,
      ownerUserId: target.userId,
      pricing: {
        cachedRate: MODEL.cachedInputMicroPointsPerMillion,
        inputRate: MODEL.inputMicroPointsPerMillion,
        maxInputTokens: MODEL.maxContextTokens,
        maxOutputTokens: MODEL.maxOutputTokens,
        outputRate: MODEL.outputMicroPointsPerMillion,
        pricingVersion: MODEL.pricingVersion,
      },
      tokenId,
    });
    if (!reserved.ok) throw new Error(`reservation failed: ${reserved.reason}`);
    const requestId = reserved.id;
    await reviewRequest(operator.env, requestId, "no_terminal_usage");

    const list = await call(`/v1/operator/ai/requests?userId=${target.userId}`, {
      token: operator.token, env: operator.env,
    });
    expect(list.status).toBe(200);
    const page = await list.json<{ requests: Array<{ id: string; state: string; reservedMicroPoints: number }>; nextCursor: string | null }>();
    expect(page.requests).toEqual([expect.objectContaining({ id: requestId, state: "review", reservedMicroPoints: 2400 })]);
    expect(page.nextCursor).toBeNull();

    const settle = (chargedMicroPoints: number) => call(`/v1/operator/ai/requests/${requestId}/settle`, {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), chargedMicroPoints, reason: "checked upstream" },
    });
    const over = await settle(2_401);
    expect(over.status).toBe(400);

    const settled = await settle(0);
    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toMatchObject({
      request: { id: requestId, state: "settled", chargedMicroPoints: 0 },
    });
    const balance = await call("/v1/account/ai", { token: target.token, env: operator.env });
    await expect(balance.json()).resolves.toMatchObject({ availableMicroPoints: 10_000, reservedMicroPoints: 0 });

    // A second settlement of the same request cannot refund again.
    expect((await settle(0)).status).toBe(409);
    expect((await call(`/v1/operator/ai/requests/${crypto.randomUUID()}/settle`, {
      method: "POST",
      token: operator.token,
      env: operator.env,
      body: { operationId: crypto.randomUUID(), chargedMicroPoints: 0, reason: "ghost" },
    })).status).toBe(404);
  });
});

/**
 * 0012 is applied history and must never be rewritten; 0013 renames its amount
 * columns in place. This drives the real upgrade path: a database that stopped
 * at 0012, holding a funded account, a settled charge, a review reservation,
 * and an operator audit row, is migrated to the latest schema and the numbers
 * must be the same numbers under the points names.
 */
describe("0013 renames 0012's amounts without losing or reinterpreting a value", () => {
  it("carries an applied-0012 account, charge, review, and audit into micro-points", async () => {
    const db = env.MIGRATION_DB;
    // MIGRATION_DB is shared by the suite, so start from the pre-0012 shape this
    // test is about instead of inheriting whatever another file applied.
    await db.batch(["account_ai_adjustments", "account_ai_requests", "account_ai_tokens", "account_ai_balances"]
      .map((table) => db.prepare(`DROP TABLE IF EXISTS ${table}`)));
    // `applyD1Migrations` creates and reads `d1_migrations`, so record the reset
    // the same way: forget 0012 onward, then apply from the slice below.
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    ).run();
    await db.prepare("DELETE FROM d1_migrations WHERE name >= '0012_'").run();
    const through0012 = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith("0013_"));
    expect(through0012).toBeGreaterThan(0);
    expect(env.TEST_MIGRATIONS[through0012 - 1]!.name.startsWith("0012_")).toBe(true);
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, through0012));

    // A pre-rename database: the old column names are the only ones that exist.
    const columns = await db.prepare("SELECT name FROM pragma_table_info('account_ai_balances')")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "available_micro_usd",
      "reserved_micro_usd",
    ]));

    const now = 1_800_000_000_000;
    const userId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const reviewedId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES (?, 'Before 0013', 'before-0013@example.com', 1, ?, ?)`,
      ).bind(userId, now, now),
      db.prepare(
        `INSERT INTO account_ai_balances
           (owner_user_id, enabled, activated_at, available_micro_usd, reserved_micro_usd, updated_at)
         VALUES (?, 1, ?, 900, 2400, ?)`,
      ).bind(userId, now, now),
      db.prepare(
        `INSERT INTO account_ai_requests
           (id, owner_user_id, token_id, model, endpoint, pricing_version,
            input_rate, cached_rate, output_rate, max_input_tokens, max_output_tokens,
            reserved_micro_usd, state, charged_micro_usd, input_tokens, cached_input_tokens,
            output_tokens, created_at, updated_at, settled_at)
         VALUES (?, ?, 'token-before', 'm1', 'chat', 'v1', 2000000, 500000, 4000000,
                 1000, 100, 2400, 'settled', 2100, 1000, 200, 100, ?, ?, ?)`,
      ).bind(requestId, userId, now, now, now),
      db.prepare(
        `INSERT INTO account_ai_requests
           (id, owner_user_id, token_id, model, endpoint, pricing_version,
            input_rate, cached_rate, output_rate, max_input_tokens, max_output_tokens,
            reserved_micro_usd, state, settlement_reason, created_at, updated_at)
         VALUES (?, ?, 'token-before', 'm1', 'chat', 'v1', 2000000, 500000, 4000000,
                 1000, 100, 2400, 'review', 'usage_invalid', ?, ?)`,
      ).bind(reviewedId, userId, now, now),
      db.prepare(
        `INSERT INTO account_ai_adjustments
           (operation_id, operator_user_id, owner_user_id, kind, body_hash, amount_micro_usd,
            reason, created_at, result_json)
         VALUES (?, 'operator-before', ?, 'grant', ?, 3300, 'opening credit', ?, '{}')`,
      ).bind(operationId, userId, "a".repeat(64), now),
    ]);

    // The upgrade itself: every remaining migration, including 0013.
    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const balance = await db.prepare(
      "SELECT enabled, activated_at, available_micro_points, reserved_micro_points FROM account_ai_balances WHERE owner_user_id = ?",
    ).bind(userId).first<{ activated_at: number; available_micro_points: number; enabled: number; reserved_micro_points: number }>();
    // The grant trigger already added its 3300 to available (900 + 3300); the
    // review request's 2400 is still held, and no value was rescaled.
    expect(balance).toEqual({ activated_at: now, available_micro_points: 4200, enabled: 1, reserved_micro_points: 2400 });

    const settled = await db.prepare(
      "SELECT state, charged_micro_points, reserved_micro_points, input_tokens, cached_input_tokens, output_tokens FROM account_ai_requests WHERE id = ?",
    ).bind(requestId).first();
    expect(settled).toEqual({
      cached_input_tokens: 200,
      charged_micro_points: 2100,
      input_tokens: 1000,
      output_tokens: 100,
      reserved_micro_points: 2400,
      state: "settled",
    });

    const review = await db.prepare(
      "SELECT state, charged_micro_points, reserved_micro_points, settlement_reason FROM account_ai_requests WHERE id = ?",
    ).bind(reviewedId).first();
    expect(review).toEqual({
      charged_micro_points: null,
      reserved_micro_points: 2400,
      settlement_reason: "usage_invalid",
      state: "review",
    });

    const audit = await db.prepare(
      "SELECT kind, amount_micro_points, reason FROM account_ai_adjustments WHERE operation_id = ?",
    ).bind(operationId).first();
    expect(audit).toEqual({ amount_micro_points: 3300, kind: "grant", reason: "opening credit" });

    // No 0012 column survives, and the old names are gone rather than duplicated.
    const renamed = await db.prepare("SELECT name FROM pragma_table_info('account_ai_requests')")
      .all<{ name: string }>();
    const names = renamed.results.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(["reserved_micro_points", "charged_micro_points"]));
    expect(names).not.toContain("reserved_micro_usd");
    expect(names).not.toContain("charged_micro_usd");

    // The triggers were rewritten with the columns: a settlement still releases
    // the reservation exactly once and never charges beyond it.
    await db.prepare(
      `INSERT INTO account_ai_adjustments
         (operation_id, operator_user_id, owner_user_id, kind, request_id, body_hash,
          amount_micro_points, reason, created_at, result_json)
       VALUES (?, 'operator-before', ?, 'settle', ?, ?, 0, 'checked upstream', ?, '{}')`,
    ).bind(crypto.randomUUID(), userId, reviewedId, "b".repeat(64), now + 1).run();
    const afterSettle = await db.prepare(
      "SELECT available_micro_points, reserved_micro_points FROM account_ai_balances WHERE owner_user_id = ?",
    ).bind(userId).first();
    // Settling the review at 0 returns its whole 2400 reservation exactly once.
    expect(afterSettle).toEqual({ available_micro_points: 6600, reserved_micro_points: 0 });

    // Over-reserving is still refused by the rewritten reserve trigger.
    await expect(db.prepare(
      `INSERT INTO account_ai_requests
         (id, owner_user_id, token_id, model, endpoint, pricing_version,
          input_rate, cached_rate, output_rate, max_input_tokens, max_output_tokens,
          reserved_micro_points, state, created_at, updated_at)
       VALUES (?, ?, 'token-before', 'm1', 'chat', 'v1', 2000000, 500000, 4000000,
               1000, 100, 999999, 'reserved', ?, ?)`,
    ).bind(crypto.randomUUID(), userId, now + 2, now + 2).run()).rejects.toThrow(/ai_reserve_conflict/);
  });
});
