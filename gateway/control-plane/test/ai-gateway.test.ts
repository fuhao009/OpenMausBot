import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISCONNECT_DRAIN_MS, routeAiGateway } from "../src/ai-gateway";
import { createAuth } from "../src/auth";
import { readAuthConfig } from "../src/config";
import { sha256 } from "../src/installations";
import { reviewRequest } from "../src/ai-wallet";
import worker from "../src/index";

const BASE_URL = "https://auth.hezuo.test";
const UPSTREAM = "https://ai.upstream.test/v1";
const UPSTREAM_KEY = "operator-upstream-key-0123456789";

const MODELS = [
  {
    chatMaxTokensField: "max_tokens",
    enabled: true,
    id: "m1",
    inputMicroPointsPerMillion: 2_000_000,
    cachedInputMicroPointsPerMillion: 500_000,
    label: "Model One",
    maxContextTokens: 1000,
    maxOutputTokens: 100,
    outputMicroPointsPerMillion: 4_000_000,
    pricingVersion: "v1",
    protocol: "chat",
    upstreamModel: "upstream-m1",
  },
  {
    enabled: true,
    id: "r1",
    inputMicroPointsPerMillion: 2_000_000,
    cachedInputMicroPointsPerMillion: 500_000,
    label: "Model R",
    maxContextTokens: 1000,
    maxOutputTokens: 100,
    outputMicroPointsPerMillion: 4_000_000,
    pricingVersion: "v1",
    protocol: "responses",
    upstreamModel: "upstream-r1",
  },
  {
    chatMaxTokensField: "max_tokens",
    enabled: true,
    id: "cachecost",
    inputMicroPointsPerMillion: 1_000_000,
    cachedInputMicroPointsPerMillion: 3_000_000,
    label: "Cache-priced Model",
    maxContextTokens: 1000,
    maxOutputTokens: 100,
    outputMicroPointsPerMillion: 4_000_000,
    pricingVersion: "v1",
    protocol: "chat",
    upstreamModel: "upstream-cachecost",
  },
  {
    chatMaxTokensField: "max_tokens",
    enabled: false,
    id: "off1",
    inputMicroPointsPerMillion: 2_000_000,
    cachedInputMicroPointsPerMillion: 500_000,
    label: "Disabled",
    maxContextTokens: 1000,
    maxOutputTokens: 100,
    outputMicroPointsPerMillion: 4_000_000,
    pricingVersion: "v1",
    protocol: "chat",
    upstreamModel: "upstream-off1",
  },
];

function testEnv(overrides: Record<string, unknown> = {}): Env {
  return Object.assign({}, env, {
    AI_DEFAULT_MODEL: "m1",
    AI_MODELS: JSON.stringify(MODELS),
    AI_OPERATOR_USER_IDS: "[]",
    AI_UPSTREAM_API_KEY: UPSTREAM_KEY,
    AI_UPSTREAM_BASE_URL: UPSTREAM,
    ...overrides,
  }) as unknown as Env;
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signIn(email: string): Promise<{ bearer: string; sessionId: string; userId: string }> {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readAuthConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);

  const request = new Request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
    body: JSON.stringify({ email, name: email.split("@", 1)[0], otp }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const signInContext = createExecutionContext();
  const response = await worker.fetch(request, env, signInContext);
  await waitOnExecutionContext(signInContext);
  expect(response.status).toBe(200);
  const body = await response.json<{ user: { id: string } }>();
  const bearer = response.headers.get("set-auth-token");
  if (!bearer) throw new Error("no signed bearer");

  const session = await env.DB.prepare('SELECT id FROM "session" WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 1')
    .bind(body.user.id).first<{ id: string }>();
  if (!session) throw new Error("no session");
  return { bearer, sessionId: session.id, userId: body.user.id };
}

async function seedAccount(options: {
  availableMicroPoints: number;
  pending?: boolean;
  sessionId: string;
  suspended?: boolean;
  userId: string;
}) {
  const now = Date.now();
  const activated = options.pending ? null : now;
  await env.DB.prepare(
    `INSERT INTO account_ai_balances
      (owner_user_id, enabled, activated_at, available_micro_points, reserved_micro_points, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).bind(
    options.userId,
    options.suspended || options.pending ? 0 : 1,
    activated,
    options.availableMicroPoints,
    now,
  ).run();
  const lookup = base64URL(crypto.getRandomValues(new Uint8Array(16)));
  const secret = base64URL(crypto.getRandomValues(new Uint8Array(32)));
  const raw = `omb_product_ai_${lookup}.${secret}`;
  const tokenId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO account_ai_tokens
      (id, owner_user_id, session_id, device_id, lookup_id, secret_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    tokenId,
    options.userId,
    options.sessionId,
    crypto.randomUUID(),
    lookup,
    await sha256(raw),
    now,
    now + 15 * 60 * 1000,
  ).run();
  return raw;
}

interface UpstreamCall {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  init: RequestInit;
  url: string;
}

function recorder(respond: (call: UpstreamCall) => Response | Promise<Response>) {
  const calls: UpstreamCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headerMap = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    headerMap.forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call: UpstreamCall = { body, headers, init: init ?? {}, url: String(input) };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

function sseResponse(frames: string[], chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(frames.join(""));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function inferenceRequest(path: string, body: unknown, token: string, headers: Record<string, string> = {}) {
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    method: "POST",
  });
}

/** A request whose declared `content-length` and actual bytes can differ. */
function streamedRequest(path: string, body: string, token: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  return new Request(`${BASE_URL}${path}`, {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-length": String(bytes.byteLength),
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

afterEach(() => vi.restoreAllMocks());

const spyOnConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});

async function requests() {
  const result = await env.DB.prepare(
    `SELECT id, model, endpoint, state, reserved_micro_points, charged_micro_points,
            input_tokens, cached_input_tokens, output_tokens, settlement_reason,
            max_input_tokens, max_output_tokens, pricing_version
       FROM account_ai_requests ORDER BY created_at ASC`,
  ).all<{
    cached_input_tokens: number | null;
    charged_micro_points: number | null;
    endpoint: string;
    id: string;
    input_tokens: number | null;
    max_input_tokens: number;
    max_output_tokens: number;
    model: string;
    output_tokens: number | null;
    pricing_version: string;
    reserved_micro_points: number;
    settlement_reason: string | null;
    state: string;
  }>();
  return result.results;
}

async function balance(userId: string) {
  const row = await env.DB.prepare(
    "SELECT available_micro_points, reserved_micro_points FROM account_ai_balances WHERE owner_user_id = ?",
  ).bind(userId).first<{ available_micro_points: number; reserved_micro_points: number }>();
  if (!row) throw new Error("no balance row");
  return row;
}

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ content: "hello", role: "user" }],
  model: "m1",
  ...overrides,
});

const CHAT_USAGE = {
  completion_tokens: 100,
  prompt_tokens: 1000,
  prompt_tokens_details: { cached_tokens: 200 },
};

describe("ai gateway catalog", () => {
  it("publishes only enabled models to a live token and never charges", async () => {
    const { sessionId, userId } = await signIn("catalog@example.com");
    const token = await seedAccount({ availableMicroPoints: 0, sessionId, userId });
    const { calls, fetcher } = recorder(() => {
      throw new Error("catalog must not reach the upstream");
    });

    const response = await routeAiGateway(
      new Request(`${BASE_URL}/v1/ai/models`, { headers: { authorization: `Bearer ${token}` } }),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    const body = await response?.json<{ data: { id: string }[] }>();
    expect(body?.data.map((model) => model.id)).toEqual(["m1", "r1", "cachecost"]);
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
    expect(await balance(userId)).toEqual({ available_micro_points: 0, reserved_micro_points: 0 });
  });

  it("requires a model token for the catalog", async () => {
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const response = await routeAiGateway(
      new Request(`${BASE_URL}/v1/ai/models`),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_token_invalid" } });
    expect(calls).toHaveLength(0);
  });

  it("keeps the catalog free but refuses a suspended account", async () => {
    const { sessionId, userId } = await signIn("suspended-catalog@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, suspended: true, userId });

    const response = await routeAiGateway(
      new Request(`${BASE_URL}/v1/ai/models`, { headers: { authorization: `Bearer ${token}` } }),
      testEnv(),
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_suspended" } });
  });

  it("rejects an account token used as a model token", async () => {
    const { bearer } = await signIn("account-token@example.com");
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), bearer),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_token_invalid" } });
    expect(calls).toHaveLength(0);
  });

  it("reports ai_unavailable on an unconfigured deployment without touching the wallet", async () => {
    const { sessionId, userId } = await signIn("unconfigured@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv({ AI_MODELS: "[]" }),
      fetcher,
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_unavailable" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
    expect(await balance(userId)).toEqual({ available_micro_points: 10_000, reserved_micro_points: 0 });
  });

  it("refuses an account that was never enabled with ai_not_enabled", async () => {
    const { sessionId, userId } = await signIn("pending-inference@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, pending: true, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_not_enabled" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("refuses a live token whose account was suspended after issuance", async () => {
    const { sessionId, userId } = await signIn("suspended-inference@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, suspended: true, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_suspended" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("refuses a revoked model token", async () => {
    const { sessionId, userId } = await signIn("revoked-token@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    await env.DB.prepare("UPDATE account_ai_tokens SET revoked_at = ? WHERE owner_user_id = ?")
      .bind(Date.now(), userId).run();
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns null for paths it does not own", async () => {
    const response = await routeAiGateway(new Request(`${BASE_URL}/v1/me`), testEnv());
    expect(response).toBeNull();
  });
});

describe("ai gateway admission", () => {
  it("rejects an unknown model before reserving or forwarding", async () => {
    const { sessionId, userId } = await signIn("unknown-model@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ model: "nope" }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "model_not_allowed" } });
    expect(await requests()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("rejects a disabled model", async () => {
    const { sessionId, userId } = await signIn("disabled-model@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ model: "off1" }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects a model addressed over the wrong protocol", async () => {
    const { sessionId, userId } = await signIn("wrong-protocol@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ model: "r1" }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "model_not_allowed" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("rejects unknown top-level fields, conflicting caps, and n > 1", async () => {
    const { sessionId, userId } = await signIn("fields@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const bodies = [
      chatBody({ top_k: 5 }),
      chatBody({ max_tokens: 10, max_completion_tokens: 10 }),
      chatBody({ n: 2 }),
      chatBody({ stream_options: { include_usage: true, extra: true } }),
      chatBody({ tools: [{ type: "web_search" }] }),
    ];

    for (const body of bodies) {
      const response = await routeAiGateway(
        inferenceRequest("/v1/ai/chat/completions", body, token),
        testEnv(),
        fetcher,
      );
      expect(response?.status).toBe(400);
      expect(response?.headers.has("x-ai-request-id")).toBe(false);
      await expect(response?.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
    expect(await balance(userId)).toEqual({ available_micro_points: 10_000, reserved_micro_points: 0 });
  });

  it("rejects responses-only fields that would leave the request local-only contract", async () => {
    const { sessionId, userId } = await signIn("responses-fields@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const bodies = [
      { input: "hi", model: "r1", previous_response_id: "resp_1" },
      { input: "hi", model: "r1", background: true },
      { input: "hi", model: "r1", store: true },
      { include: ["file_search_call.results"], input: "hi", model: "r1" },
    ];

    for (const body of bodies) {
      const response = await routeAiGateway(
        inferenceRequest("/v1/ai/responses", body, token),
        testEnv(),
        fetcher,
      );
      expect(response?.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("refuses an over-limit fluid body without reserving", async () => {
    const { sessionId, userId } = await signIn("oversized@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    const prefix = new TextEncoder().encode('{"messages":[{"role":"user","content":"');
    let sent = 0;
    const request = new Request(`${BASE_URL}/v1/ai/chat/completions`, {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) {
            sent += 1;
            controller.enqueue(prefix);
            return;
          }
          if (sent <= 50) {
            sent += 1;
            controller.enqueue(chunk);
            return;
          }
          controller.close();
        },
      }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });

    const response = await routeAiGateway(request, testEnv(), fetcher);
    expect(response?.status).toBe(413);
    expect(response?.headers.has("x-ai-request-id")).toBe(false);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  }, 60_000);

  it("refuses a declared body length above the inference ceiling without reading it", async () => {
    const { sessionId, userId } = await signIn("declared-oversized@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      streamedRequest("/v1/ai/chat/completions", JSON.stringify(chatBody()), token, {
        "content-length": String(48 * 1024 * 1024 + 1),
      }),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(413);
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("refuses a request whose declared length disagrees with its body", async () => {
    const { sessionId, userId } = await signIn("bad-length@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({}));

    const response = await routeAiGateway(
      streamedRequest("/v1/ai/chat/completions", JSON.stringify(chatBody()), token, { "content-length": "1" }),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("reports insufficient balance and busy accounts without calling the upstream", async () => {
    const short = await signIn("short@example.com");
    const shortToken = await seedAccount({ availableMicroPoints: 2199, sessionId: short.sessionId, userId: short.userId });
    const first = recorder(() => jsonResponse({}));
    const shortResponse = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), shortToken),
      testEnv(),
      first.fetcher,
    );
    expect(shortResponse?.status).toBe(402);
    expect(shortResponse?.headers.has("x-ai-request-id")).toBe(false);
    await expect(shortResponse?.json()).resolves.toMatchObject({ error: { code: "insufficient_balance", type: "insufficient_quota" } });
    expect(first.calls).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
    expect(await balance(short.userId)).toEqual({ available_micro_points: 2199, reserved_micro_points: 0 });
  });
});

describe("ai gateway chat", () => {
  it.each([400, 401, 403, 404, 408, 409, 413, 422, 429])("releases end-user points after refusal %i without leaking upstream details or retrying", async (status) => {
    const { sessionId, userId } = await signIn(`refused-${status}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const secret = `private-upstream-detail-${status} ${UPSTREAM} ${UPSTREAM_KEY}`;
    const { calls, fetcher } = recorder(() => jsonResponse({ error: { message: secret } }, status));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(503);
    const text = await response!.text();
    expect(JSON.parse(text)).toEqual({ error: {
      code: status === 429 ? "ai_temporarily_busy" : "ai_temporarily_unavailable",
      type: "service_unavailable",
      message: status === 429
        ? "The AI service is busy. No points were charged."
        : "The AI service is temporarily unavailable. No points were charged.",
    } });
    for (const value of [secret, UPSTREAM, UPSTREAM_KEY, token]) expect(text).not.toContain(value);
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "settled", charged_micro_points: 0, settlement_reason: `upstream_refused_${status}` });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 10_000, reserved_micro_points: 0 });
    expect(calls).toHaveLength(1);
  });

  it.each([500, 502, 503, 302, 418])("keeps unknown status %i reserved for review without retrying", async (status) => {
    const { sessionId, userId } = await signIn(`review-${status}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({ error: { message: "private detail" } }, status));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "upstream_error" } });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null, settlement_reason: `upstream_status_${status}` });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(calls).toHaveLength(1);
  });

  it.each([false, true])("settles trustworthy 429 usage before refusal policy (stream request: %s)", async (stream) => {
    const { sessionId, userId } = await signIn(`busy-usage-${stream}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({ error: { message: "private detail" }, usage: CHAT_USAGE }, 429));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream }), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "upstream_error" } });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "settled", charged_micro_points: 2100, settlement_reason: null });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 7900, reserved_micro_points: 0 });
    expect(calls).toHaveLength(1);
  });

  it("does not claim a release when another writer already moved the request to review", async () => {
    const { sessionId, userId } = await signIn("release-race@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(async () => {
      await reviewRequest(testEnv(), (await requests())[0].id, "operator_review");
      return jsonResponse({ error: { message: "private detail" } }, 429);
    });
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(502);
    const text = await response!.text();
    expect(JSON.parse(text).error.code).toBe("upstream_error");
    expect(text).not.toContain("No points were charged");
    const rows = await requests();
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null, settlement_reason: "operator_review" });
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(calls).toHaveLength(1);
  });

  it.each(["transport", "local-egress"])("releases %s failures without retrying or review", async (kind) => {
    const { sessionId, userId } = await signIn(`transport-${kind}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => {
      if (kind === "transport") throw new Error("private network detail");
      return jsonResponse({ error: "egress_failed" }, 502, { "x-hezuo-egress-failed": "1" });
    });
    const response = await routeAiGateway(inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(kind === "local-egress" ? { LOCAL_GATEWAY_DISCONNECT: {} } : {}), fetcher);
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_temporarily_unavailable" } });
    expect((await requests())[0]).toMatchObject({ state: "settled", charged_micro_points: 0, settlement_reason: "upstream_transport_failed" });
    expect(await balance(userId)).toEqual({ available_micro_points: 10_000, reserved_micro_points: 0 });
    expect(calls).toHaveLength(1);
  });

  it.each(["encoded", "body-read"])("reviews %s failures even when a refusal release might otherwise apply", async (kind) => {
    const { sessionId, userId } = await signIn(`failure-${kind}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => {
      if (kind === "encoded") return jsonResponse({ usage: CHAT_USAGE }, 429, { "content-encoding": "gzip" });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body detail")); } }), { status: 429 });
    });
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(502);
    const text = await response!.text();
    expect(JSON.parse(text).error.code).toBe("upstream_error");
    expect(text).not.toContain("private");
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(calls).toHaveLength(1);
  });

  it("includes the ledger id when dispatch setup throws after reserve", async () => {
    const { sessionId, userId } = await signIn("dispatch-setup@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const request = inferenceRequest("/v1/ai/chat/completions", chatBody(), token);
    vi.spyOn(request, "signal", "get").mockImplementation(() => { throw new Error("private setup detail"); });
    const { calls, fetcher } = recorder(() => jsonResponse({}));
    const response = await routeAiGateway(request, testEnv(), fetcher);
    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "upstream_error" } });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])("releases an empty Responses refusal before streaming starts (stream request: %s)", async (stream) => {
    const { sessionId, userId } = await signIn(`responses-refusal-${stream}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => new Response(null, { status: 401 }));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/responses", { input: "hello", model: "r1", stream }, token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "ai_temporarily_unavailable" } });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "settled", charged_micro_points: 0, settlement_reason: "upstream_refused_401" });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 10_000, reserved_micro_points: 0 });
    expect(calls).toHaveLength(1);
  });

  it("keeps a failed 200 stream reserved even when its error code resembles a refusal", async () => {
    spyOnConsoleError();
    const { sessionId, userId } = await signIn("stream-refusal-code@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => sseResponse([
      'data: {"error":{"code":"rate_limit_exceeded","message":"busy"}}\n\n',
    ]));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).toContain("event: error");
    expect(text).toContain("rate_limit_exceeded");
    expect(text).not.toContain("No points were charged");
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(calls).toHaveLength(1);
  });

  it.each([
    { completion_tokens: 1, prompt_tokens: -1 },
    { completion_tokens: 1, prompt_tokens: "invalid" },
    { prompt_tokens: 100 },
  ])("reviews unusable usage on 429 instead of silently releasing it: %j", async (usage) => {
    const { sessionId, userId } = await signIn(`invalid-refusal-${crypto.randomUUID()}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({ usage }, 429));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token), testEnv(), fetcher,
    );
    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "upstream_error" } });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ state: "review", charged_micro_points: null });
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(calls).toHaveLength(1);
  });

  it("settles exact usage from a non-streaming completion and maps the model back", async () => {
    const { sessionId, userId } = await signIn("chat-json@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "hi", role: "assistant" } }],
      id: "chatcmpl-1",
      model: "upstream-m1",
      object: "chat.completion",
      usage: CHAT_USAGE,
    }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ max_tokens: 500 }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    const body = await response?.json<{ model: string }>();
    expect(body?.model).toBe("m1");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${UPSTREAM}/chat/completions`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].headers["accept-encoding"]).toBe("identity");
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].body.model).toBe("upstream-m1");
    expect(calls[0].body.max_tokens).toBe(100);
    expect(calls[0].body.stream).toBe(false);
    // The client's own bearer never reaches the upstream.
    expect(JSON.stringify(calls[0].headers)).not.toContain(token);

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({
      cached_input_tokens: 200,
      charged_micro_points: 2100,
      endpoint: "chat",
      input_tokens: 1000,
      max_input_tokens: 900,
      max_output_tokens: 100,
      model: "m1",
      output_tokens: 100,
      pricing_version: "v1",
      reserved_micro_points: 2200,
      state: "settled",
    });
    expect(await balance(userId)).toEqual({ available_micro_points: 7900, reserved_micro_points: 0 });
  });

  it("forwards tool results and images unchanged and only local function tools", async () => {
    const { sessionId, userId } = await signIn("chat-tools@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "ok", role: "assistant" } }],
      model: "upstream-m1",
      usage: { completion_tokens: 1, prompt_tokens: 1 },
    }));
    const messages = [
      { content: "look", role: "user" },
      {
        content: [{ text: "see", type: "text" }, { image_url: { url: "data:image/png;base64,AAAA" }, type: "image_url" }],
        role: "user",
      },
      {
        content: null,
        role: "assistant",
        tool_calls: [{ function: { arguments: "{\"command\":\"echo hi\"}", name: "Bash" }, id: "call_1", type: "function" }],
      },
      { content: "hi", role: "tool", tool_call_id: "call_1" },
    ];
    const tools = [{ function: { description: "Run a shell command", name: "Bash", parameters: { properties: {}, type: "object" } }, type: "function" }];

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ messages, tool_choice: "auto", tools }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(calls[0].body.messages).toEqual(messages);
    expect(calls[0].body.tools).toEqual(tools);
    expect(calls[0].body.tool_choice).toBe("auto");
  });

  it("streams chat deltas, waits for late usage, and holds the terminal frame until settlement", async () => {
    const { sessionId, userId } = await signIn("chat-stream@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [
      `data: {"choices":[{"delta":{"content":"Hel"},"index":0}],"model":"upstream-m1"}\r\n\r\n`,
      `data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop","index":0}],"model":"upstream-m1"}\r\n\r\n`,
      `data: {"choices":[],"model":"upstream-m1","usage":${JSON.stringify(CHAT_USAGE)}}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ];
    const { calls, fetcher } = recorder(() => sseResponse(frames, 5));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await response?.text();

    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(text).toContain("\"content\":\"Hel\"");
    expect(text).toContain("\"model\":\"m1\"");
    expect(text).not.toContain("upstream-m1");
    expect(text?.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({ charged_micro_points: 2100, state: "settled" });
    expect(await balance(userId)).toEqual({ available_micro_points: 7900, reserved_micro_points: 0 });
  });

  it("keeps a reservation for review and withholds the terminal frame when usage is missing", async () => {
    const { sessionId, userId } = await signIn("chat-no-usage@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [
      `data: {"choices":[{"delta":{"content":"part"},"index":0}],"model":"upstream-m1"}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { fetcher } = recorder(() => sseResponse(frames, 64));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    const text = await response?.text();
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("event: error");

    const rows = await requests();
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("usage_missing");
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
  });

  it("treats a stream that ends without terminal usage as review, never a free success", async () => {
    const { sessionId, userId } = await signIn("chat-truncated@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [`data: {"choices":[{"delta":{"content":"part"},"index":0}],"model":"upstream-m1"}\n\n`];
    const { fetcher } = recorder(() => sseResponse(frames, 64));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    const text = await response?.text();
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("event: error");

    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("stream_ended_without_terminal_usage");
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
  });

  it("sends a review signal instead of a silent truncation when settlement fails", async () => {
    const { sessionId, userId } = await signIn("chat-settle-fail@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    // Insolvent usage consumes available funds and preserves the unpaid outcome.
    const frames = [
      `data: {"choices":[{"delta":{"content":"x"},"index":0}],"model":"upstream-m1"}\n\n`,
      `data: {"choices":[],"model":"upstream-m1","usage":{"completion_tokens":100,"prompt_tokens":5000}}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { fetcher } = recorder(() => sseResponse(frames, 64));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    const text = await response?.text();
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("event: error");

    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: 10000, state: "review", settlement_reason: "usage_exceeds_reservation", input_tokens: 5000 });
    expect(await balance(userId)).toEqual({ available_micro_points: 0, reserved_micro_points: 0 });
  });

  it("settles usage an error response still reported and never leaks the upstream body", async () => {
    const { sessionId, userId } = await signIn("chat-error-usage@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      error: { message: "internal secret detail" },
      model: "upstream-m1",
      usage: { completion_tokens: 10, prompt_tokens: 100 },
    }, 500));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(502);
    const text = await response?.text();
    expect(text).toContain("upstream_error");
    expect(text).not.toContain("internal secret detail");

    const rows = await requests();
    expect(rows[0]).toMatchObject({ input_tokens: 100, output_tokens: 10 });
    expect(rows[0].state).toBe("settled");
    expect(rows[0].charged_micro_points).toBe(240);
    expect(await balance(userId)).toEqual({ available_micro_points: 9760, reserved_micro_points: 0 });
  });

  it("refuses a redirect and keeps the reservation for review", async () => {
    const { sessionId, userId } = await signIn("chat-redirect@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => new Response(null, {
      headers: { location: "https://elsewhere.test/v1/chat/completions" },
      status: 302,
    }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(502);
    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("upstream_status_302");
  });

  it("refuses a compressed upstream body it cannot bound", async () => {
    const { sessionId, userId } = await signIn("chat-encoded@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      choices: [],
      model: "upstream-m1",
      usage: CHAT_USAGE,
    }, 200, { "content-encoding": "gzip" }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(502);
    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("upstream_content_encoding");
  });

  it("bills unknown cache detail at the higher input rate without inventing a cached count", async () => {
    const { sessionId, userId } = await signIn("chat-unknown-cache@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "hi", role: "assistant" } }],
      model: "upstream-m1",
      // No prompt_tokens_details: the upstream did not report a cache split.
      usage: { completion_tokens: 10, prompt_tokens: 100 },
    }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);

    // 100 x max(2.0, 0.5) + 10 x 4.0 = 200 + 40 = 240 micro-points at the higher rate.
    const rows = await requests();
    expect(rows[0]).toMatchObject({ input_tokens: 100, output_tokens: 10, state: "settled" });
    expect(rows[0].cached_input_tokens).toBeNull();
    expect(rows[0].charged_micro_points).toBe(240);
  });

  it("bills an explicit zero cache hit at the input rate", async () => {
    const { sessionId, userId } = await signIn("chat-zero-cache@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "hi", role: "assistant" } }],
      model: "upstream-m1",
      usage: { completion_tokens: 10, prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
    }));

    await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    const rows = await requests();
    expect(rows[0].cached_input_tokens).toBe(0);
    // 100 x 2.0 + 10 x 4.0 = 240 micro-points.
    expect(rows[0].charged_micro_points).toBe(240);
  });

  it("parses CR-only and CRLF framing, split mid-frame and mid-multibyte", async () => {
    const { sessionId, userId } = await signIn("chat-framing@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [
      `data: {"choices":[{"delta":{"content":"héllo"},"index":0}],"model":"upstream-m1"}\r\r`,
      `data: {"choices":[],"model":"upstream-m1","usage":${JSON.stringify(CHAT_USAGE)}}\r\r`,
      "data: [DONE]\r\r",
    ];
    const { fetcher } = recorder(() => sseResponse(frames, 3));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    const text = await response?.text();
    expect(text).toContain("héllo");
    expect(text?.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: 2100, state: "settled" });
  });

  it("accumulates repeated cumulative usage without double billing", async () => {
    const { sessionId, userId } = await signIn("chat-cumulative@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [
      `data: {"choices":[],"model":"upstream-m1","usage":{"completion_tokens":10,"prompt_tokens":100}}\n\n`,
      `data: {"choices":[],"model":"upstream-m1","usage":{"completion_tokens":40,"prompt_tokens":400}}\n\n`,
      `data: {"choices":[],"model":"upstream-m1","usage":${JSON.stringify(CHAT_USAGE)}}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { fetcher } = recorder(() => sseResponse(frames, 64));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    await response?.text();
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ charged_micro_points: 2100, state: "settled" });
    expect(await balance(userId)).toEqual({ available_micro_points: 7900, reserved_micro_points: 0 });
  });

  it("rejects an SSE frame beyond the per-frame ceiling with a review", async () => {
    const { sessionId, userId } = await signIn("chat-frame-limit@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const huge = "x".repeat(17 * 1024 * 1024);
    const frames = [`data: {"choices":[{"delta":{"content":"${huge}"},"index":0}]}\n\n`, "data: [DONE]\n\n"];
    const { fetcher } = recorder(() => sseResponse(frames, 64 * 1024));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
    );
    const text = await response?.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("[DONE]");

    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("upstream_frame_too_large");
  }, 60_000);

  it("keeps a disconnected stream draining until its bounded timeout", async () => {
    const { sessionId, userId } = await signIn("chat-disconnect@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const firstFrame = Promise.withResolvers<void>();
    const frames = [
      `data: {"choices":[{"delta":{"content":"a"},"index":0}],"model":"upstream-m1"}\n\n`,
      `data: {"choices":[],"model":"upstream-m1","usage":${JSON.stringify(CHAT_USAGE)}}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { fetcher } = recorder(() => {
      const text = frames.join("");
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 10));
          firstFrame.resolve();
        },
        pull() {
          // Never produce the rest: the client cancels first.
          return new Promise<void>(() => {});
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });

    vi.useFakeTimers();
    const context = createExecutionContext();
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(),
      fetcher,
      promise => context.waitUntil(promise),
    );
    expect(response?.status).toBe(200);
    await firstFrame.promise;
    await response?.body?.cancel();
    await vi.advanceTimersByTimeAsync(DISCONNECT_DRAIN_MS);
    await waitOnExecutionContext(context);

    const rows = await requests();
    expect(rows[0]).toMatchObject({ charged_micro_points: null, state: "review" });
    expect(rows[0].settlement_reason).toBe("client_disconnected");
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
  });

  it("drains trusted usage after cancellation and settles exactly once", async () => {
    const { sessionId, userId } = await signIn("chat-disconnect-settled@example.com");
    const token = await seedAccount({ availableMicroPoints: 10000, sessionId, userId });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const context = createExecutionContext();
    const { fetcher } = recorder(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token),
      testEnv(), fetcher, promise => context.waitUntil(promise),
    );
    await response!.body!.cancel();
    source.enqueue(new TextEncoder().encode(`data: {"choices":[],"usage":${JSON.stringify(CHAT_USAGE)}}\n\ndata: [DONE]\n\n`));
    source.close();
    await waitOnExecutionContext(context);
    expect((await requests())[0]).toMatchObject({ state: "settled", charged_micro_points: 2100,
      settlement_reason: "client_disconnected_settled", input_tokens: 1000, output_tokens: 100 });
    expect(await balance(userId)).toEqual({ available_micro_points: 7900, reserved_micro_points: 0 });
  });

  it.each([false, true])("handles trusted local disconnect without cancelling the response transport (timeout=%s)", async (timeout) => {
    const { sessionId, userId } = await signIn(`local-disconnect-${timeout}@example.com`);
    const token = await seedAccount({ availableMicroPoints: 10000, sessionId, userId });
    const notification = Promise.withResolvers<Response>();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const context = createExecutionContext();
    const { fetcher } = recorder(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const request = inferenceRequest("/v1/ai/chat/completions", chatBody({ stream: true }), token);
    Object.defineProperty(request, "cf", { value: { localGatewayDisconnectId: "00000000-0000-4000-8000-000000000001" } });
    const localFetch = vi.fn(() => notification.promise);
    vi.useFakeTimers();
    const response = await routeAiGateway(request, testEnv({ LOCAL_GATEWAY_DISCONNECT: { fetch: localFetch } }), fetcher,
      promise => context.waitUntil(promise));
    const drained = response!.text();
    notification.resolve(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    if (timeout) {
      await vi.advanceTimersByTimeAsync(DISCONNECT_DRAIN_MS);
    } else {
      source.enqueue(new TextEncoder().encode(`data: {"choices":[],"usage":${JSON.stringify(CHAT_USAGE)}}\n\ndata: [DONE]\n\n`));
      source.close();
    }
    await drained;
    await waitOnExecutionContext(context);
    expect(localFetch).toHaveBeenCalledOnce();
    expect((await requests())[0]).toMatchObject(timeout
      ? { state: "review", settlement_reason: "client_disconnected", charged_micro_points: null }
      : { state: "settled", settlement_reason: "client_disconnected_settled", charged_micro_points: 2100 });
    expect(await balance(userId)).toEqual(timeout
      ? { available_micro_points: 7800, reserved_micro_points: 2200 }
      : { available_micro_points: 7900, reserved_micro_points: 0 });
  });

  it("bills unknown cache detail at the higher rate when cached input costs more", async () => {
    const { sessionId, userId } = await signIn("chat-unknown-cache-high@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "hi", role: "assistant" } }],
      model: "upstream-cachecost",
      usage: { completion_tokens: 10, prompt_tokens: 100 },
    }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ model: "cachecost" }), token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);

    // 100 x max(1.0, 3.0) + 10 x 4.0 = 300 + 40 = 340 micro-points, not 140.
    const rows = await requests();
    expect(rows[0]).toMatchObject({ input_tokens: 100, output_tokens: 10, state: "settled" });
    expect(rows[0].cached_input_tokens).toBeNull();
    expect(rows[0].charged_micro_points).toBe(340);
    // Remaining input context is 900; output cap is 100.
    expect(rows[0].reserved_micro_points).toBe(3100);
  });

  it("bills a reported cache hit at the cached rate when that is higher", async () => {
    const { sessionId, userId } = await signIn("chat-cache-high@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => jsonResponse({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "hi", role: "assistant" } }],
      model: "upstream-cachecost",
      usage: { completion_tokens: 0, prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 100 } },
    }));

    await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody({ model: "cachecost" }), token),
      testEnv(),
      fetcher,
    );
    const rows = await requests();
    // 100 x 3.0 = 300 micro-points.
    expect(rows[0]).toMatchObject({ cached_input_tokens: 100, charged_micro_points: 300, state: "settled" });
  });

  it("admits two in-flight calls per account and refuses a third", async () => {
    const { sessionId, userId } = await signIn("chat-busy@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let startedCalls = 0;
    const { fetcher } = recorder(async () => {
      startedCalls += 1;
      if (startedCalls === 2) started.resolve();
      await gate.promise;
      return jsonResponse({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "done", role: "assistant" } }],
        model: "upstream-m1",
        usage: { completion_tokens: 1, prompt_tokens: 1 },
      });
    });

    const first = routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    const secondInFlight = routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    // Both upstream calls start only after their reservations committed.
    await started.promise;
    expect((await requests()).length).toBe(2);

    const third = await routeAiGateway(
      inferenceRequest("/v1/ai/chat/completions", chatBody(), token),
      testEnv(),
      fetcher,
    );
    expect(third?.status).toBe(429);
    expect(third?.headers.has("x-ai-request-id")).toBe(false);
    expect(third?.headers.get("retry-after")).toBe("2");
    await expect(third?.json()).resolves.toMatchObject({ error: { code: "ai_busy" } });

    gate.resolve();
    const [firstResponse, secondResponse] = await Promise.all([first, secondInFlight]);
    expect(firstResponse?.status).toBe(200);
    expect(secondResponse?.status).toBe(200);
    const rows = await requests();
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { state: string }) => row.state)).toEqual(["settled", "settled"]);
    expect(await balance(userId)).toEqual({ available_micro_points: 9988, reserved_micro_points: 0 });
  });
});

describe("ai gateway responses", () => {
  it("settles the terminal event's usage, not an earlier candidate", async () => {
    const { sessionId, userId } = await signIn("responses-stream@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const frames = [
      `event: response.created\ndata: {"response":{"id":"resp_1","model":"upstream-r1","usage":null},"type":"response.created"}\n\n`,
      `event: response.in_progress\ndata: {"response":{"id":"resp_1","model":"upstream-r1","usage":{"input_tokens":999,"output_tokens":999}},"type":"response.in_progress"}\n\n`,
      `event: response.output_text.delta\ndata: {"delta":"Hi","type":"response.output_text.delta"}\n\n`,
      `event: response.completed\ndata: {"response":{"id":"resp_1","model":"upstream-r1","usage":{"input_tokens":800,"input_tokens_details":{"cached_tokens":0},"output_tokens":50}},"type":"response.completed"}\n\n`,
    ];
    const { calls, fetcher } = recorder(() => sseResponse(frames, 11));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/responses", { input: "hello", model: "r1", stream: true, store: false }, token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    const text = await response?.text();
    expect(text).toContain("\"model\":\"r1\"");
    expect(text).not.toContain("upstream-r1");
    expect(text?.trimEnd().endsWith("\"type\":\"response.completed\"}")).toBe(true);

    expect(calls[0].url).toBe(`${UPSTREAM}/responses`);
    expect(calls[0].body).toMatchObject({ model: "upstream-r1", store: false });

    const rows = await requests();
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({ charged_micro_points: 1800, endpoint: "responses", state: "settled" });
    expect(rows[0].input_tokens).toBe(800);
    expect(rows[0].output_tokens).toBe(50);
    expect(await balance(userId)).toEqual({ available_micro_points: 8200, reserved_micro_points: 0 });
  });

  async function streamedResponses(email: string, frames: string[]) {
    const { sessionId, userId } = await signIn(email);
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { fetcher } = recorder(() => sseResponse(frames, 11));
    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/responses", { input: "hello", model: "r1", stream: true, store: false }, token),
      testEnv(),
      fetcher,
    );
    expect(response?.headers.get("x-ai-request-id")).toBe((await requests())[0].id);
    return { text: (await response?.text()) ?? "", userId };
  }
  const errorData = (text: string) => JSON.parse(/event: error\ndata: (.*)\n/.exec(text)![1]!).error as { code: string; message: string; type: string };

  it("passes on the upstream's own code and message when its stream carries an error frame", async () => {
    const error = spyOnConsoleError();
    const { text } = await streamedResponses("responses-error-frame@example.com", [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"upstream-r1"}}\n\n`,
      `data: {"error":{"code":"server_error","message":"The model is overloaded. ${"x".repeat(400)}","private":"never shown"}}\n\n`,
    ]);
    expect(errorData(text)).toMatchObject({ code: "server_error", type: "upstream_error" });
    expect(errorData(text).message).toHaveLength(300);
    expect(text).not.toContain("never shown");
    expect((await requests())[0]).toMatchObject({ state: "review", settlement_reason: "upstream_stream_error" });
    expect(error.mock.calls.map(([line]) => String(line))).toEqual([expect.stringMatching(/^\[ai-gateway\] stream failed request=\S+ reason=upstream_stream_error code=server_error event=error-frame$/)]);
  });

  it("keeps the fixed text and code when the error frame says nothing usable", async () => {
    spyOnConsoleError();
    const { text } = await streamedResponses("responses-error-bare@example.com", [`data: {"error":{"code":"bad code!","message":"  "}}\n\n`]);
    expect(errorData(text)).toMatchObject({ code: "upstream_error", message: "The upstream request failed." });
  });

  it("passes on why the upstream failed a response, and still reviews the missing usage", async () => {
    const error = spyOnConsoleError();
    const { text, userId } = await streamedResponses("responses-failed@example.com", [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"upstream-r1"}}\n\n`,
      `data: {"type":"response.failed","response":{"id":"resp_1","model":"upstream-r1","status":"failed","error":{"code":"server_error","message":"The server had an error while processing your request."}}}\n\n`,
    ]);
    expect(errorData(text)).toEqual({ code: "server_error", message: "The server had an error while processing your request.", type: "upstream_error" });
    expect((await requests())[0]).toMatchObject({ charged_micro_points: null, state: "review", settlement_reason: "usage_missing" });
    expect(await balance(userId)).toEqual({ available_micro_points: 7800, reserved_micro_points: 2200 });
    expect(error.mock.calls.map(([line]) => String(line))).toEqual(["[ai-gateway] stream failed request=" + (await requests())[0].id + " reason=usage_missing code=server_error event=response.failed"]);
  });

  it("still says only that a completed response without usage could not be settled", async () => {
    const { text } = await streamedResponses("responses-no-usage@example.com", [
      `data: {"type":"response.completed","response":{"id":"resp_1","model":"upstream-r1","error":{"code":"leaky","message":"must not pass"}}}\n\n`,
    ]);
    expect(errorData(text)).toMatchObject({ code: "upstream_error", message: "The response could not be settled." });
    expect(text).not.toContain("must not pass");
    expect((await requests())[0].settlement_reason).toBe("usage_missing");
  });

  it("settles a non-streaming responses body and forces store off", async () => {
    const { sessionId, userId } = await signIn("responses-json@example.com");
    const token = await seedAccount({ availableMicroPoints: 10_000, sessionId, userId });
    const { calls, fetcher } = recorder(() => jsonResponse({
      id: "resp_2",
      model: "upstream-r1",
      object: "response",
      output: [],
      usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 100 }, output_tokens: 25 },
    }));

    const response = await routeAiGateway(
      inferenceRequest("/v1/ai/responses", { input: "hello", model: "r1" }, token),
      testEnv(),
      fetcher,
    );
    expect(response?.status).toBe(200);
    const body = await response?.json<{ model: string }>();
    expect(body?.model).toBe("r1");
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.max_output_tokens).toBe(100);

    // (400-100)*2 + 100*0.5 + 25*4 = 600 + 50 + 100 = 750 micro-points.
    const rows = await requests();
    expect(response?.headers.get("x-ai-request-id")).toBe(rows[0].id);
    expect(rows[0]).toMatchObject({ charged_micro_points: 750, state: "settled" });
  });
});
