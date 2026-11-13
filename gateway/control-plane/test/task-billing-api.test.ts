import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { DEFAULT_BILLING_POLICY, type TaskBillingSnapshot } from "../src/task-billing";

const ORIGIN = "https://billing.example.test";
const defaultWorker = createWorker();
const models = [
  { id: "economy", upstreamModel: "gpt-6-luna", label: "Economy" },
  { id: "expert", upstreamModel: "gpt-6-astra", label: "Expert" },
].map(model => ({ ...model, protocol: "responses", enabled: true, pricingVersion: "legacy", inputMicroPointsPerMillion: 1000, cachedInputMicroPointsPerMillion: 1000, outputMicroPointsPerMillion: 1000, maxContextTokens: 4096, maxOutputTokens: 512 }));
let ip = 0;
function deployment(): Env {
  return { ...env, BETTER_AUTH_URL: ORIGIN, AUTH_EMAIL_VERIFICATION: "off", EMAIL_FROM: "", EMAIL: undefined,
    AI_OPERATOR_USER_IDS: "[]", AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1", AI_UPSTREAM_API_KEY: "test-billing-key",
    AI_MODELS: JSON.stringify(models), AI_DEFAULT_MODEL: "economy" } as unknown as Env;
}
async function call(worker: typeof defaultWorker, target: Env, path: string, token?: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(ORIGIN + path, { method: body === undefined ? "GET" : "POST", headers: {
    origin: ORIGIN, "cf-connecting-ip": `203.0.113.${++ip % 250}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) }), target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function setup(fetcher: typeof fetch) {
  const worker = createWorker(undefined, undefined, undefined, fetcher), target = deployment();
  async function register(name: string) {
    const response = await call(worker, target, "/api/auth/sign-up/email", undefined, { email: `${name}@example.test`, name, password: "test-billing-password" });
    expect(response.status).toBe(200);
    const { user } = await response.json<{ user: { id: string } }>();
    return { id: user.id, token: response.headers.get("set-auth-token")! };
  }
  const operator = await register("billing-operator"), customer = await register("billing-customer");
  Object.assign(target, { AI_OPERATOR_USER_IDS: JSON.stringify([operator.id]) });
  for (const [path, payload] of [["account", { enabled: true }], ["balance", { amountMicroPoints: 1_000_000_000 }]] as const) {
    expect((await call(worker, target, "/v1/operator/ai/" + path, operator.token, { userId: customer.id, operationId: crypto.randomUUID(), reason: "Isolated billing setup", ...payload })).status).toBe(200);
  }
  const tokenResponse = await call(worker, target, "/v1/account/ai/tokens", customer.token, { deviceId: crypto.randomUUID() });
  expect(tokenResponse.status).toBe(201);
  const { token } = await tokenResponse.json<{ token: string }>();
  const policy = { ...DEFAULT_BILLING_POLICY, enabled: true, profiles: [
    { modelId: "economy", capacity: "simple", tools: true, vision: true },
    { modelId: "expert", capacity: "complex", tools: true, vision: true },
  ] };
  const save = await call(worker, target, "/v1/operator/billing", operator.token, { revision: 0, reason: "Enable cost-aware routing", policy });
  expect(save.status).toBe(200);
  return { worker, target, operator, customer, token, policy };
}
const completion = (model: string) => ({ id: "resp-test", model, object: "response", status: "completed", output: [], usage: {
  input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0, cache_write_1h_tokens: 0 },
} });

describe("task billing HTTP contract", () => {
  it("quotes without reserving, routes by complexity, enforces budget and keeps costs operator-only", async () => {
    const calls: Record<string, unknown>[] = [];
    const s = await setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); calls.push(body); return Response.json(completion(body.model));
    }) as typeof fetch);
    for (const path of ["/v1/operator/billing", "/v1/operator/billing/metrics"]) {
      expect((await call(s.worker, s.target, path)).status).toBe(401);
      expect((await call(s.worker, s.target, path, s.customer.token)).status).toBe(403);
    }
    const request = { model: "auto-responses", input: "hello", max_output_tokens: 32 };
    const q = await call(s.worker, s.target, "/v1/ai/quote", s.token, { endpoint: "responses", request });
    expect(q.status).toBe(200);
    const quote = await q.json<{ selectedModel: string; complexity: string; reservedMicroPoints: number; estimatedMicroPoints: number }>();
    expect(quote.selectedModel).toBe("economy"); expect(quote.complexity).toBe("simple");
    expect(quote.estimatedMicroPoints).toBeLessThanOrEqual(quote.reservedMicroPoints);
    expect(calls).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM account_ai_requests").first<{ n: number }>())!.n).toBe(0);
    const rejected = await call(s.worker, s.target, "/v1/ai/responses", s.token, { ...request, billing: { maxMicroPoints: 1 } });
    expect(rejected.status).toBe(402); expect(await rejected.json()).toMatchObject({ error: { code: "budget_exceeded" } });
    expect(rejected.headers.get("x-ai-request-id")).toBeNull(); expect(calls).toEqual([]);
    const success = await call(s.worker, s.target, "/v1/ai/responses", s.token, request);
    expect(success.status).toBe(200); expect(success.headers.get("x-ai-model")).toBe("economy");
    const row = await env.DB.prepare("SELECT billing_snapshot, charged_micro_points, cost_micro_currency, cost_status FROM account_ai_requests WHERE id=?").bind(success.headers.get("x-ai-request-id")).first<{ billing_snapshot: string; charged_micro_points: number; cost_micro_currency: number; cost_status: string }>();
    expect(row!.charged_micro_points).toBe(29040); expect(row!.cost_micro_currency).toBe(14); expect(row!.cost_status).toBe("estimated");
    const snapshot = JSON.parse(row!.billing_snapshot) as TaskBillingSnapshot;
    expect(snapshot.requestedModel).toBe("auto-responses"); expect(snapshot.selectedModel).toBe("economy"); expect(row!.billing_snapshot).not.toContain("hello");
    const complex = await call(s.worker, s.target, "/v1/ai/quote", s.token, { endpoint: "responses", request: { model: "auto-responses", input: "Audit architecture and prove correctness", reasoning: { effort: "high" }, max_output_tokens: 32 } });
    expect(await complex.json()).toMatchObject({ selectedModel: "expert", complexity: "complex" });
    const explicit = await call(s.worker, s.target, "/v1/ai/quote", s.token, { endpoint: "responses", request: { ...request, model: "expert" } });
    expect(await explicit.json()).toMatchObject({ selectedModel: "expert" });
    const ledger = await call(s.worker, s.target, "/v1/account/ai/ledger", s.customer.token);
    expect(JSON.stringify(await ledger.json())).not.toMatch(/billingSnapshot|costMicroCurrency|tariffId|upstream\.example/);
    const metrics = await call(s.worker, s.target, "/v1/operator/billing/metrics", s.operator.token);
    expect(await metrics.json()).toMatchObject({ sampleCount: 1, unknownCostCount: 0, chargedMicroPoints: 29040, estimatedCostMicroCurrency: 14 });
    expect(calls[0]).toMatchObject({ model: "gpt-6-luna" }); expect(calls[0]).not.toHaveProperty("billing");
  });

  it("locks pricing before upstream execution even when policy changes during the call", async () => {
    let during: (() => Promise<void>) | undefined;
    const s = await setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
      await during!(); return Response.json(completion(JSON.parse(String(init?.body)).model));
    }) as typeof fetch);
    during = async () => {
      const update = await call(s.worker, s.target, "/v1/operator/billing", s.operator.token, { revision: 1, reason: "Change future requests only", policy: { ...s.policy, pointsPerCurrency: 2000 } });
      expect(update.status).toBe(200);
    };
    const response = await call(s.worker, s.target, "/v1/ai/responses", s.token, { model: "economy", input: "hello", max_output_tokens: 32 });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT billing_snapshot, charged_micro_points FROM account_ai_requests WHERE id=?").bind(response.headers.get("x-ai-request-id")).first<{ billing_snapshot: string; charged_micro_points: number }>();
    expect(JSON.parse(row!.billing_snapshot).pointsPerCurrency).toBe(1000); expect(row!.charged_micro_points).toBe(29040);
    const next = await call(s.worker, s.target, "/v1/ai/quote", s.token, { endpoint: "responses", request: { model: "economy", input: "hello", max_output_tokens: 32 } });
    expect(await next.json()).toMatchObject({ pointsPerCurrency: 2000, policyRevision: 2 });
  });

  it("settles streamed usage under its cost snapshot and keeps refused procurement cost unknown", async () => {
    let fail = false;
    const s = await setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (fail) return Response.json({ error: { message: "private vendor detail" } }, { status: 429 });
      const body = JSON.parse(String(init?.body));
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completion(body.model) })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    const response = await call(s.worker, s.target, "/v1/ai/responses", s.token, { model: "auto-responses", input: "hello", max_output_tokens: 32, stream: true });
    expect(response.status).toBe(200); expect(await response.text()).toContain("response.completed");
    const row = await env.DB.prepare("SELECT state, charged_micro_points, cost_status FROM account_ai_requests WHERE id=?").bind(response.headers.get("x-ai-request-id")).first();
    expect(row).toMatchObject({ state: "settled", charged_micro_points: 29040, cost_status: "estimated" });
    fail = true;
    const refused = await call(s.worker, s.target, "/v1/ai/responses", s.token, { model: "economy", input: "hello", max_output_tokens: 32 });
    expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ error: { code: "ai_temporarily_busy" } });
    const metrics = await call(s.worker, s.target, "/v1/operator/billing/metrics", s.operator.token);
    expect(await metrics.json()).toMatchObject({ sampleCount: 2, unknownCostCount: 1, estimatedCostMicroCurrency: 14 });
  });
});
