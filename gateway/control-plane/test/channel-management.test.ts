import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { createWorker } from "../src/index";
import { loadChannelCatalog, loadRuntimeAiConfig } from "../src/channel-store";

const ORIGIN = "https://auth.hezuo.test";
const KEY_A = "disposable-channel-alpha-key";
const KEY_B = "disposable-channel-beta-key";
const MODEL = {
  id: "public-alpha", label: "Alpha", protocol: "chat" as const,
  pricingVersion: "alpha-v1", inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1000, maxOutputTokens: 100, upstreamModel: "private/alpha",
  chatMaxTokensField: "max_tokens" as const, enabled: true, channelId: "alpha",
};
const CHANNEL = { id: "alpha", name: "Alpha provider", baseURL: "https://alpha.example.test/v1", enabled: true, apiKey: KEY_A };
const worker = createWorker();
let requestIp = 0;

function deployment(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env, BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "test-only-channel-management-secret-at-least-32-chars",
    AUTH_EMAIL_VERIFICATION: "off", EMAIL_FROM: "", EMAIL: undefined,
    AI_OPERATOR_USER_IDS: "[]", AI_MODELS: "[]", AI_DEFAULT_MODEL: "",
    AI_UPSTREAM_BASE_URL: "", AI_UPSTREAM_API_KEY: "", ...overrides,
  } as unknown as Env;
}

async function call(target: Env, path: string, options: {
  token?: string; body?: unknown; method?: string; origin?: string; instance?: typeof worker;
} = {}) {
  const ctx = createExecutionContext();
  const response = await (options.instance ?? worker).fetch(new Request(`${ORIGIN}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "cf-connecting-ip": `198.51.100.${++requestIp % 250}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json", origin: options.origin ?? ORIGIN }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signUp(target: Env, name: string) {
  const response = await call(target, "/api/auth/sign-up/email", {
    body: { email: `${name}@example.test`, name, password: "test-only-channel-password" },
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("Sign-up did not issue a bearer");
  const { user } = await response.json<{ user: { id: string } }>();
  return { token, userId: user.id };
}

async function operator(overrides: Record<string, unknown> = {}) {
  const target = deployment(overrides);
  const session = await signUp(target, "channel-operator");
  return { ...session, target: { ...target, AI_OPERATOR_USER_IDS: JSON.stringify([session.userId]) } as Env };
}

function publication(revision = 0) {
  return { revision, reason: "Publish disposable channel catalog", channels: [CHANNEL], models: [MODEL], defaultModel: MODEL.id };
}

async function save(op: { target: Env; token: string }, body: unknown, status = 200) {
  const response = await call(op.target, "/v1/operator/channels", { token: op.token, body });
  expect(response.status).toBe(status);
  return response;
}

function expectNoSecrets(value: unknown, secrets = [KEY_A, KEY_B]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/apiKey|ciphertext|encryptedKey/);
}

// The catalog has deliberately durable semantics; reset only this file's rows.
afterEach(async () => {
  await env.DB.prepare("DELETE FROM ai_channel_catalog").run();
  await env.DB.prepare("DELETE FROM ai_channel_audit").run();
});

describe("operator channel management", () => {
  it("requires a bearer and env operator allowlist even when no AI configuration exists", async () => {
    const target = deployment();
    const ordinary = await signUp(target, "ordinary-channel-user");
    for (const path of ["/v1/operator/channels", "/v1/operator/channels/alpha/probe"]) {
      const body = path.endsWith("probe") ? {} : undefined;
      expect((await call(target, path, { body })).status).toBe(401);
      expect((await call(target, path, { body, token: ordinary.token })).status).toBe(403);
    }
    expect((await call(target, "/v1/operator/channels", { body: publication() })).status).toBe(401);
    expect((await call(target, "/v1/operator/channels", { body: publication(), token: ordinary.token })).status).toBe(403);
    const op = await operator();
    const response = await call(op.target, "/v1/operator/channels", { token: op.token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ revision: 0, channels: [], models: [], defaultModel: null });
    expect((await call(op.target, "/v1/operator/channels", {
      token: op.token, body: publication(), origin: "https://attacker.example.test",
    })).status).toBe(403);
  });

  it("persists encrypted keys, retains omitted keys, rotates atomically and rejects stale revisions", async () => {
    const op = await operator();
    const first = await (await save(op, publication())).json<{ revision: number; channels: unknown[] }>();
    expect(first.revision).toBe(1);
    expect(first.channels).toEqual([{ id: CHANNEL.id, name: CHANNEL.name, baseURL: CHANNEL.baseURL, enabled: true, hasKey: true }]);
    expectNoSecrets(first);
    const loaded = await loadChannelCatalog({ ...op.target });
    expect(loaded).toEqual(first);
    expect((await loadRuntimeAiConfig({ ...op.target })).routes?.get(MODEL.id)).toEqual({ baseURL: CHANNEL.baseURL, apiKey: KEY_A });
    const persisted = await env.DB.prepare("SELECT snapshot_json, actor_id, reason FROM ai_channel_catalog WHERE id = 1").first<{ snapshot_json: string; actor_id: string; reason: string }>();
    expect(persisted?.actor_id).toBe(op.userId);
    expect(persisted?.reason).toBe(publication().reason);
    expect(persisted?.snapshot_json).not.toContain(KEY_A);
    expect(persisted?.snapshot_json).toContain("encryptedKey");
    const withoutKey = { id: CHANNEL.id, name: "Renamed", baseURL: CHANNEL.baseURL, enabled: true };
    await save(op, { ...publication(1), channels: [withoutKey] });
    expect((await loadRuntimeAiConfig(op.target)).routes?.get(MODEL.id)?.apiKey).toBe(KEY_A);
    await save(op, { ...publication(2), channels: [{ ...withoutKey, apiKey: KEY_B }] });
    expect((await loadRuntimeAiConfig(op.target)).routes?.get(MODEL.id)?.apiKey).toBe(KEY_B);
    await save(op, publication(1), 409);
    expect((await loadChannelCatalog(op.target)).revision).toBe(3);
    const rotated = await env.DB.prepare("SELECT snapshot_json FROM ai_channel_catalog WHERE id = 1").first<{ snapshot_json: string }>();
    expect(rotated?.snapshot_json).not.toContain(KEY_A);
    expect(rotated?.snapshot_json).not.toContain(KEY_B);
    expect(rotated?.snapshot_json).not.toBe(persisted?.snapshot_json);
    const audit = await env.DB.prepare("SELECT revision, actor_id, reason FROM ai_channel_audit ORDER BY revision").all();
    expect(audit.results).toEqual([1, 2, 3].map(revision => ({ revision, actor_id: op.userId, reason: publication().reason })));
    const reloaded = await (await call(op.target, "/v1/operator/channels", { token: op.token })).json();
    expectNoSecrets(reloaded);
  });

  it("commits exactly one concurrent revision and audits only the winner", async () => {
    const op = await operator();
    const responses = await Promise.all(["First publication", "Second publication"].map(reason =>
      call(op.target, "/v1/operator/channels", { token: op.token, body: { ...publication(), reason } })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const catalog = await loadChannelCatalog(op.target);
    expect(catalog.revision).toBe(1);
    const audit = await env.DB.prepare("SELECT revision, actor_id, reason FROM ai_channel_audit").all<{ revision: number; actor_id: string; reason: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({ revision: 1, actor_id: op.userId });
    expect(audit.results[0].reason).toBe(responses[0].status === 200 ? "First publication" : "Second publication");
  });

  it("never transfers an omitted key to another URL or channel identity and preserves rejected snapshots", async () => {
    const op = await operator();
    await save(op, publication());
    for (const channel of [
      { id: "alpha", name: "Moved", baseURL: "https://moved.example.test/v1", enabled: true },
      { id: "beta", name: "New identity", baseURL: CHANNEL.baseURL, enabled: true },
    ]) {
      await save(op, { ...publication(1), channels: [channel], models: [{ ...MODEL, channelId: channel.id }] }, 400);
      expect((await loadChannelCatalog(op.target)).revision).toBe(1);
    }
    await save(op, { ...publication(1), channels: [] }, 400);
    await save(op, { ...publication(1), channels: [{ ...CHANNEL, baseURL: "http://upstream.example.test/v1" }] }, 400);
    await save(op, { ...publication(1), channels: [{ ...CHANNEL, baseURL: "https://user:password@example.test/v1?key=private" }] }, 400);
    await save(op, { ...publication(1), models: [MODEL, MODEL] }, 400);
    await save(op, { ...publication(1), defaultModel: "missing" }, 400);
    await save(op, { ...publication(1), reason: "" }, 400);
    await save(op, { ...publication(1), reason: "x".repeat(501) }, 400);
    await save(op, { ...publication(1), reason: `Do not echo ${KEY_A}` }, 400);
    await save(op, { ...publication(1), channels: [{ ...CHANNEL, name: KEY_A }] }, 400);
    await save(op, { ...publication(1), channels: [{ ...CHANNEL, apiKey: "short" }] }, 400);
    await save(op, { ...publication(1), models: [{ ...MODEL, cachedInputMicroPointsPerMillion: -1 }] }, 400);
    await save(op, { ...publication(1), channels: Array.from({ length: 51 }, (_, index) => ({ ...CHANNEL, id: `provider-${index}` })) }, 400);
    await save(op, { ...publication(1), models: Array.from({ length: 201 }, (_, index) => ({ ...MODEL, id: `model-${index}` })) }, 400);
    const oversized = await call(op.target, "/v1/operator/channels", { token: op.token, body: { ...publication(1), padding: "x".repeat(256 * 1024) } });
    expect(oversized.status).toBe(413);
    await save(op, { ...publication(1), models: [{ ...MODEL, inputMicroPointsPerMillion: undefined }] }, 400);
    expect((await loadChannelCatalog(op.target)).revision).toBe(1);
  });

  it("disables runtime availability and allows operators to recover without legacy fallback", async () => {
    const { channelId: _legacyChannelId, ...legacyModel } = MODEL;
    const op = await operator({ AI_UPSTREAM_BASE_URL: CHANNEL.baseURL, AI_UPSTREAM_API_KEY: KEY_A,
      AI_MODELS: JSON.stringify([legacyModel]), AI_DEFAULT_MODEL: MODEL.id });
    const legacy = await loadChannelCatalog(op.target);
    expect(legacy.revision).toBe(0);
    expect(legacy.channels).toMatchObject([{ id: "legacy", hasKey: true }]);
    expect((await loadRuntimeAiConfig(op.target)).ready).toBe(true);
    await save(op, { revision: 0, reason: "Explicitly remove legacy configuration", channels: [], models: [], defaultModel: null });
    expect(await loadChannelCatalog({ ...op.target })).toEqual({ revision: 1, channels: [], models: [], defaultModel: null });
    expect((await loadRuntimeAiConfig(op.target)).ready).toBe(false);
    const changedLegacy = { ...op.target, AI_UPSTREAM_BASE_URL: "https://changed-legacy.example.test/v1", AI_UPSTREAM_API_KEY: "changed-legacy-secret" };
    expect((await loadRuntimeAiConfig(changedLegacy)).ready).toBe(false);
    await save(op, publication(1));
    await save(op, { ...publication(2), channels: [{ ...CHANNEL, enabled: false }], defaultModel: null });
    const disabled = await loadRuntimeAiConfig(op.target);
    expect(disabled.ready).toBe(false);
    expect(disabled.models.filter(model => model.enabled)).toEqual([]);
    expect((await call(op.target, "/v1/operator/me", { token: op.token })).status).toBe(200);
    await save(op, publication(3));
    expect((await loadRuntimeAiConfig(op.target)).ready).toBe(true);
    expect((await loadRuntimeAiConfig(changedLegacy)).routes?.get(MODEL.id)).toEqual({ baseURL: CHANNEL.baseURL, apiKey: KEY_A });
  });

  it("probes only the saved endpoint with its saved key and returns sanitized bounded results", async () => {
    const op = await operator();
    await save(op, publication());
    const calls: { url: string; init?: RequestInit }[] = [];
    let response = new Response(JSON.stringify({ data: [{ id: "private/alpha" }, { id: "discovered-only" }] }));
    const aiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response;
    }) as typeof fetch;
    const instance = createWorker(undefined, undefined, undefined, aiFetch);
    const probe = () => call(op.target, "/v1/operator/channels/alpha/probe", { token: op.token, body: {}, instance });
    const result = await probe();
    expect(result.status).toBe(200);
    const payload = await result.json<{ models: string[]; latencyMs: number }>();
    expect(payload.models).toEqual(["discovered-only", "private/alpha"]);
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].url).toBe(`${CHANNEL.baseURL}/models`);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(`Bearer ${KEY_A}`);
    expect(calls[0].init?.redirect).toBe("manual");
    expect((await loadChannelCatalog(op.target)).models.map(model => model.id)).toEqual([MODEL.id]);
    for (const upstream of [
      new Response(`upstream leaked ${KEY_A}`, { status: 401 }),
      new Response("redirect", { status: 302, headers: { location: "https://other.example.test" } }),
      new Response(`not JSON ${KEY_A}`),
      new Response("x".repeat(1024 * 1024 + 1)),
      Response.json({ data: Array.from({ length: 1001 }, (_, index) => ({ id: `model-${index}` })) }),
      Response.json({ data: [{ id: `leaked-${KEY_A}` }] }),
    ]) {
      response = upstream;
      const failed = await probe();
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expectNoSecrets(await failed.json());
    }
    const missing = await call(op.target, "/v1/operator/channels/missing/probe", { token: op.token, body: {}, instance });
    expect(missing.status).toBe(404);
    expect(calls).toHaveLength(7);
  });

  it("routes two published models through createWorker with isolated URL/key/model/pricing and no retry", async () => {
    const op = await operator();
    const { chatMaxTokensField: _chatField, ...responseBase } = MODEL;
    const second = { ...responseBase, protocol: "responses" as const, id: "public-beta", channelId: "beta", upstreamModel: "private/beta", pricingVersion: "beta-v2",
      inputMicroPointsPerMillion: 3_000_000, cachedInputMicroPointsPerMillion: 1_000_000, outputMicroPointsPerMillion: 5_000_000 };
    await save(op, { ...publication(), channels: [CHANNEL, { ...CHANNEL, id: "beta", name: "Beta", baseURL: "https://beta.example.test/api", apiKey: KEY_B }], models: [MODEL, second] });
    const user = await signUp(op.target, "channel-inference-user");
    for (const [path, payload] of [
      ["/v1/operator/ai/account", { enabled: true }],
      ["/v1/operator/ai/balance", { amountMicroPoints: 1_000_000 }],
    ] as const) {
      expect((await call(op.target, path, { token: op.token, body: { userId: user.userId, operationId: crypto.randomUUID(), reason: "Channel routing test", ...payload } })).status).toBe(200);
    }
    const issued = await call(op.target, "/v1/account/ai/tokens", { token: user.token, body: { deviceId: crypto.randomUUID() } });
    expect(issued.status).toBe(201);
    const { token } = await issued.json<{ token: string }>();
    const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
    let fail = false;
    const aiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), key: new Headers(init?.headers).get("authorization"), body });
      if (!fail && String(input).endsWith("/responses")) return Response.json({
        id: "fixture-response", object: "response", model: body.model, status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Responses channel routed" }] }],
        usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
      });
      return fail ? new Response(`upstream secret ${KEY_B}`, { status: 503 }) : Response.json({
        id: "fixture-reply", model: body.model, choices: [{ message: { role: "assistant", content: "Channel routed" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
      });
    }) as typeof fetch;
    const instance = createWorker(undefined, undefined, undefined, aiFetch);
    for (const model of [MODEL, second]) {
      const response = await call(op.target, model.protocol === "chat" ? "/v1/ai/chat/completions" : "/v1/ai/responses", { token, instance,
        body: model.protocol === "chat"
          ? { model: model.id, messages: [{ role: "user", content: "Route this request" }], max_tokens: 10 }
          : { model: model.id, input: "Route this Responses request", max_output_tokens: 10 } });
      expect(response.status).toBe(200);
      expectNoSecrets(await response.json());
    }
    expect(calls.map(call => ({ url: call.url, key: call.key, model: call.body.model }))).toEqual([
      { url: `${CHANNEL.baseURL}/chat/completions`, key: `Bearer ${KEY_A}`, model: MODEL.upstreamModel },
      { url: "https://beta.example.test/api/responses", key: `Bearer ${KEY_B}`, model: second.upstreamModel },
    ]);
    const rows = await env.DB.prepare("SELECT model, pricing_version, input_rate, cached_rate, output_rate, charged_micro_points, state FROM account_ai_requests WHERE owner_user_id = ? ORDER BY model").bind(user.userId).all();
    expect(rows.results).toEqual([
      { model: MODEL.id, pricing_version: "alpha-v1", input_rate: 2_000_000, cached_rate: 500_000, output_rate: 4_000_000, charged_micro_points: 33, state: "settled" },
      { model: second.id, pricing_version: "beta-v2", input_rate: 3_000_000, cached_rate: 1_000_000, output_rate: 5_000_000, charged_micro_points: 47, state: "settled" },
    ]);
    fail = true;
    const failed = await call(op.target, "/v1/ai/responses", { token, instance,
      body: { model: second.id, input: "No retry", max_output_tokens: 10 } });
    expect(failed.status).toBe(502);
    expectNoSecrets(await failed.json());
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe("https://beta.example.test/api/responses");
    await save(op, { ...publication(1), channels: [CHANNEL,
      { id: "beta", name: "Beta", baseURL: "https://beta.example.test/api", enabled: false }], models: [MODEL, second] });
    const disabled = await call(op.target, "/v1/ai/responses", { token, instance,
      body: { model: second.id, input: "Disabled channel must not dispatch", max_output_tokens: 10 } });
    expect(disabled.status).toBe(403);
    expect(calls).toHaveLength(3);
  });
});
