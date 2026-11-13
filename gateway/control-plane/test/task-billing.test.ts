import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../src/index";
import { readAiConfig } from "../src/ai-config";
import { getCostTariffs, parseCostDecimal, resolveCostTariff } from "../src/cost-tariffs";
import { applyBillingCatalog, calculateTaskCharge, calculateTaskReservation, DEFAULT_BILLING_POLICY, estimateTaskMicroPoints, getBillingMetrics, inputReservationTokens, loadBillingPolicy, planTaskBilling, refreshBillingController, saveBillingPolicy, type TaskBillingSnapshot } from "../src/task-billing";

it("reserves padded text estimates, caps context and keeps full image capacity", () => {
  const body = { messages: [{ role: "user", content: "hello" }] };
  const estimate = Math.ceil(JSON.stringify(body).length / 4);
  expect(inputReservationTokens(body, 500000, 100)).toBe(Math.ceil(estimate * 1.5) + 2048);
  expect(inputReservationTokens(body, 2100, 100)).toBe(2000);
  expect(inputReservationTokens({ messages: [{ content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }] }, 500000, 100)).toBe(499900);
});

it.each([
  ["English prompt ".repeat(100), 0.25],
  ["éàüß".repeat(100), 0.5],
  ["请解释这段代码".repeat(100), 1.5],
  ["日本語の説明".repeat(100), 1.5],
  ["🙂🚀".repeat(100), 2],
] as const)("accounts for multilingual text %s", (input, tokensPerCharacter) => {
  const body = { input };
  const framing = JSON.stringify({ input: "" }).length / 4;
  const estimate = Math.ceil(framing + [...input].length * tokensPerCharacter);
  expect(inputReservationTokens(body, 500000, 100)).toBe(Math.ceil(estimate * 1.5) + 2048);
});

it("includes instructions, tool schemas and tool results in the shared reserve", () => {
  const base = { input: "hello" };
  const instructed = { ...base, instructions: "Follow the supplied policy. ".repeat(1000) };
  const tools = { ...instructed, tools: [{ type: "function", name: "search", description: "Search reference material. ".repeat(1000), parameters: { type: "object", properties: { query: { type: "string" } } } }] };
  const result = { ...tools, input: [{ type: "function_call_output", call_id: "call_1", output: "检索结果".repeat(1000) }] };
  const reserve = (body: Record<string, unknown>) => inputReservationTokens(body, 500000, 100);
  expect(reserve(instructed)).toBeGreaterThan(reserve(base));
  expect(reserve(tools)).toBeGreaterThan(reserve(instructed));
  expect(reserve(result)).toBeGreaterThan(reserve(tools));
});
function snapshot(id = "gpt-6-luna"): TaskBillingSnapshot {
  const tariff = resolveCostTariff(id, "default", Date.UTC(2026, 10, 9, 0))!;
  const s: TaskBillingSnapshot = { version: 1, policyRevision: 1, currency: "USD", pointsPerCurrency: 1000, multiplierBps: 22000, tariffId: id, requestedModel: id, selectedModel: id, channelId: "test", serviceTier: "default", startedAt: 0, complexity: "simple", score: 0, reasons: ["test"], estimatedInputTokens: 100, maxInputTokens: 500000, maxOutputTokens: 10000, rates: tariff.rates, longRates: tariff.longRates, longThreshold: tariff.longThreshold, longInclusive: tariff.longInclusive, reservedMicroPoints: 0, maxCostMicroCurrency: 0 };
  Object.assign(s, calculateTaskReservation(s));
  return s;
}
const config = () => readAiConfig({ AI_UPSTREAM_BASE_URL: "https://example.test/v1", AI_UPSTREAM_API_KEY: "test-key", AI_DEFAULT_MODEL: "luna", AI_MODELS: [{ id: "luna", label: "Luna", protocol: "chat", pricingVersion: "old", inputMicroPointsPerMillion: 1, outputMicroPointsPerMillion: 1, maxContextTokens: 500000, maxOutputTokens: 10000, upstreamModel: "gpt-6-luna", chatMaxTokensField: "max_tokens", enabled: true }] });
async function enable() {
  return saveBillingPolicy(env, "operator", { revision: 0, reason: "test policy", policy: { ...DEFAULT_BILLING_POLICY, enabled: true, profiles: [{ modelId: "luna", capacity: "complex", tools: true, vision: true }] } });
}
async function seedMetrics(rows: Array<{ state: "settled" | "review"; cost: number | null; charged: number; points: number }>, now: number) {
  const user = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(user, "Billing", `${user}@example.test`, now, now).run();
  for (const row of rows) {
    const s = snapshot(); s.pointsPerCurrency = row.points;
    await env.DB.prepare(`INSERT INTO account_ai_requests (id,owner_user_id,token_id,model,endpoint,pricing_version,input_rate,cached_rate,output_rate,max_input_tokens,max_output_tokens,reserved_micro_points,state,charged_micro_points,created_at,updated_at,billing_snapshot,cost_micro_currency,cost_status,latency_ms) VALUES (?,?,?,'luna','chat','task-test',1,1,1,500000,10000,1000000,?,?,?,?,?,?,?,50)`).bind(crypto.randomUUID(), user, "test-token", row.state, row.state === "settled" ? row.charged : null, now, now, JSON.stringify(s), row.cost, row.cost === null ? "unknown" : "estimated").run();
  }
}
afterEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM ai_billing_policy"), env.DB.prepare("DELETE FROM ai_billing_policy_audit")]); });
describe("operator supplied tariff registry", () => {
  it("imports all 22 models and normalizes decimal prices exactly", () => {
    expect(getCostTariffs()).toHaveLength(22);
    expect(parseCostDecimal("122.816")).toBe(122816000);
    expect(parseCostDecimal("0.000001")).toBe(1);
    expect(() => parseCostDecimal("122.81600000003232")).toThrow();
    expect(getCostTariffs().find(t => t.id === "claude-sonnet-4-6")!.rates.writeHour).toBe(122816000);
    expect(getCostTariffs().find(t => t.id === "gpt-6-astra")!.rates.writeHour).toBeNull();
  });
  it("freezes Shanghai weekday and half-open peak windows", () => {
    const rate = (iso: string) => resolveCostTariff("deepseek-v4.1-flash", "default", Date.parse(iso))!.rates.input;
    expect(rate("2026-11-09T00:59:59Z")).toBe(1000000);
    expect(rate("2026-11-09T01:00:00Z")).toBe(2000000);
    expect(rate("2026-11-09T04:00:00Z")).toBe(1000000);
    expect(rate("2026-11-09T06:00:00Z")).toBe(2000000);
    expect(rate("2026-11-09T10:00:00Z")).toBe(1000000);
    expect(rate("2026-11-14T01:00:00Z")).toBe(1000000);
  });
  it("applies priority once, and rejects unsupported tiers", () => {
    expect(resolveCostTariff("gpt-6.1-sol", "ultrafast", 0)!.rates.input).toBe(12000000);
    expect(resolveCostTariff("gpt-6.1-sol-ultrafast", "ultrafast", 0)!.rates.input).toBe(12000000);
    expect(resolveCostTariff("gpt-6.1-sol-ultrafast", "default", 0)!.rates.input).toBe(12000000);
    expect(resolveCostTariff("gpt-6-luna", "fast", 0)!.rates.input).toBe(200000);
    expect(() => resolveCostTariff("gpt-6-luna", "ultrafast", 0)).toThrow();
    expect(() => resolveCostTariff("glm-5.3", "priority", 0)).toThrow();
  });
});
describe("exact immutable task arithmetic", () => {
  it("rounds points directly from the exact numerator, not rounded cost", () => {
    const result = calculateTaskCharge(snapshot(), { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 });
    expect(result).toEqual({ chargedMicroPoints: 220, costMicroCurrency: 1, costStatus: "estimated" });
  });
  it("uses actual threshold totals including cache categories", () => {
    const charge = (id: string, inputTokens: number) => calculateTaskCharge(snapshot(id), { inputTokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 }).costMicroCurrency;
    expect(charge("gpt-6-luna", 271999)).toBe(27200);
    expect(charge("gpt-6-luna", 272000)).toBe(54400);
    expect(charge("claude-haiku-5-5", 100000)).toBe(202000);
    expect(charge("claude-haiku-5-5", 100001)).toBe(1010011);
  });
  it("partitions read, ordinary write and hour write without duplication", () => {
    const result = calculateTaskCharge(snapshot("kimi-k3.1-pro"), { inputTokens: 100, outputTokens: 2, cachedInputTokens: 10, cacheWriteTokens: 20, cacheWriteHourTokens: 30 });
    expect(result.costMicroCurrency).toBe(1709);
    expect(result.costStatus).toBe("estimated");
    expect(() => calculateTaskCharge(snapshot(), { inputTokens: 10, outputTokens: 0, cachedInputTokens: 5, cacheWriteTokens: 6 })).toThrow();
    expect(() => calculateTaskCharge(snapshot(), { inputTokens: 10, outputTokens: 0, cacheWriteHourTokens: 1 })).toThrow();
  });
  it("uses conservative undisclosed cache/write partitions", () => {
    expect(calculateTaskCharge(snapshot("claude-sonnet-4-6"), { inputTokens: 100, outputTokens: 0 }).costMicroCurrency).toBe(12282);
    expect(calculateTaskCharge(snapshot("claude-sonnet-4-6"), { inputTokens: 100, outputTokens: 0 }).costStatus).toBe("conservative");
    const s = snapshot(); s.rates.cached = 900000; s.longRates = null; Object.assign(s, calculateTaskReservation(s));
    expect(calculateTaskCharge(s, { inputTokens: 100, outputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 }).costMicroCurrency).toBe(90);
  });
  it("rejects malformed usage and output-cap overruns, not input estimate overruns", () => {
    const s = snapshot();
    for (const bad of [-1, .5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => calculateTaskCharge(s, { inputTokens: bad, outputTokens: 0 })).toThrow();
    expect(calculateTaskCharge(s, { inputTokens: s.maxInputTokens + 1, outputTokens: 0 }).chargedMicroPoints).toBeGreaterThan(0);
    expect(() => calculateTaskCharge(s, { inputTokens: 0, outputTokens: s.maxOutputTokens + 1 })).toThrow();
    const bound = calculateTaskCharge(s, { inputTokens: s.maxInputTokens, outputTokens: s.maxOutputTokens });
    expect(bound.chargedMicroPoints).toBeLessThanOrEqual(s.reservedMicroPoints);
    expect(estimateTaskMicroPoints(s)).toBeLessThanOrEqual(s.reservedMicroPoints);
  });
  it("charges provider-injected context and cached input beyond the admission estimate", () => {
    const s = snapshot("gpt-6-astra");
    s.maxInputTokens = 2050;
    s.maxOutputTokens = 5;
    Object.assign(s, calculateTaskReservation(s));
    const usage = { inputTokens: 4123, cachedInputTokens: 3968, outputTokens: 5, cacheWriteTokens: 0, cacheWriteHourTokens: 0 };
    const charge = calculateTaskCharge(s, usage);
    expect(charge.costMicroCurrency).toBe(5768);
    const withoutEstimate = { ...s, maxInputTokens: 500000 };
    Object.assign(withoutEstimate, calculateTaskReservation(withoutEstimate));
    expect(charge).toEqual(calculateTaskCharge(withoutEstimate, usage));
    const uncached = calculateTaskCharge(s, { ...usage, cachedInputTokens: 0 });
    expect(uncached.chargedMicroPoints).toBeGreaterThan(s.reservedMicroPoints);
    expect(uncached.costMicroCurrency).toBeGreaterThan(s.maxCostMicroCurrency);
  });
  it("selects actual long-context tariffs after an input estimate overrun", () => {
    const s = snapshot();
    s.maxInputTokens = 2100;
    Object.assign(s, calculateTaskReservation(s));
    const charge = calculateTaskCharge(s, { inputTokens: 272000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 });
    expect(charge.costMicroCurrency).toBe(54400);
    expect(charge.chargedMicroPoints).toBeGreaterThan(s.reservedMicroPoints);
  });
});
describe("policy CAS and routing", () => {
  it("defaults disabled, keeps legacy behavior and rejects auto", async () => {
    expect((await loadBillingPolicy(env)).policy.enabled).toBe(false);
    expect(await planTaskBilling(env, config(), "chat", { model: "luna", messages: [] })).toBeNull();
    await expect(planTaskBilling(env, config(), "chat", { model: "auto-chat" })).rejects.toMatchObject({ status: 403 });
  });
  it("audits atomic saves and rejects stale revision and invalid margin bounds", async () => {
    const v = await enable();
    expect(v.controller.multiplierBps).toBe(22000);
    expect(v.revision).toBe(1);
    await expect(enable()).rejects.toMatchObject({ status: 409 });
    await expect(saveBillingPolicy(env, "operator", { revision: 1, reason: "bad", policy: { ...v.policy, maxMultiplierBps: 20000 } })).rejects.toMatchObject({ status: 400 });
    await expect(saveBillingPolicy(env, "operator", { revision: 1, reason: "bad", policy: { ...v.policy, unknown: 1 } })).rejects.toMatchObject({ status: 400 });
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_billing_policy_audit").first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });
  it("routes locally, freezes reservation and adds only eligible aliases", async () => {
    await enable();
    const selected = await planTaskBilling(env, config(), "chat", { model: "auto-chat", messages: [{ role: "user", content: "hello" }], max_tokens: 100 });
    expect(selected!.model.id).toBe("luna");
    expect(selected!.snapshot.requestedModel).toBe("auto-chat");
    expect(selected!.snapshot.maxInputTokens).toBe(Math.ceil(selected!.snapshot.estimatedInputTokens * 1.5) + 2048);
    expect(selected!.snapshot.reservedMicroPoints).toBe(calculateTaskReservation(selected!.snapshot).reservedMicroPoints);
    expect(selected!.model.inputMicroPointsPerMillion).toBe(550000000);
    const catalog = await applyBillingCatalog(env, config());
    expect(catalog.models.map(m => m.id)).toEqual(["luna", "auto-chat"]);
    expect(catalog.routes).toBeUndefined();
    expect(JSON.stringify(selected!.snapshot)).not.toContain("hello");
  });
  it("requires published capability and sufficient context", async () => {
    const v = await enable();
    await saveBillingPolicy(env, "operator", { revision: v.revision, reason: "disable tools", policy: { ...v.policy, profiles: [{ modelId: "luna", capacity: "simple", tools: false, vision: false }] } });
    await expect(planTaskBilling(env, config(), "chat", { model: "auto-chat", tools: [{ type: "function" }] })).rejects.toMatchObject({ status: 400 });
    await expect(planTaskBilling(env, config(), "responses", { model: "auto-responses" })).rejects.toMatchObject({ status: 400 });
    await expect(planTaskBilling(env, config(), "chat", { model: "luna", messages: [{ content: "x".repeat(2000001) }] })).rejects.toMatchObject({ status: 400 });
  });
  it("does not claim profit for an empty ledger or adjust without samples", async () => {
    const v = await enable();
    const metrics = await getBillingMetrics(env);
    expect(metrics.sampleCount).toBe(0);
    expect(metrics.estimatedMarginBps).toBeNull();
    expect(metrics.estimatedRevenueMicroCurrency).toBe(0);
    expect((await refreshBillingController(env, Date.now() + 100000)).controller).toEqual(v.controller);
  });
});

describe("bounded controller and known-cost valuation", () => {
  it("values historical revenue at the immutable conversion and excludes unknown cost", async () => {
    await enable();
    const now = Date.now();
    await seedMetrics([{ state: "settled", cost: 100, charged: 400000, points: 2000 }, { state: "settled", cost: null, charged: 900000, points: 1000 }, { state: "review", cost: null, charged: 0, points: 1000 }], now);
    const m = await getBillingMetrics(env);
    expect(m.sampleCount).toBe(3);
    expect(m.settledCount).toBe(2);
    expect(m.reviewCount).toBe(1);
    expect(m.unknownCostCount).toBe(2);
    expect(m.estimatedRevenueMicroCurrency).toBe(200);
    expect(m.estimatedCostMicroCurrency).toBe(100);
    expect(m.estimatedProfitMicroCurrency).toBe(100);
    expect(m.estimatedMarginBps).toBe(5000);
    expect(m.models[0]!.latencyAvgMs).toBe(50);
  });
  it("raises only one bounded step after cooldown and records controller audit", async () => {
    const initial = await enable();
    const policy = await saveBillingPolicy(env, "operator", { revision: initial.revision, reason: "test controller", policy: { ...initial.policy, minSamples: 2, maxMultiplierBps: 23000 } });
    const now = Date.now();
    await seedMetrics([{ state: "review", cost: null, charged: 0, points: 1000 }, { state: "settled", cost: 100, charged: 220000, points: 1000 }], now + 1);
    expect((await refreshBillingController(env, now)).controller.multiplierBps).toBe(22000);
    const adjusted = await refreshBillingController(env, now + 61000);
    expect(adjusted.controller.multiplierBps).toBe(23000);
    expect(adjusted.controller.reason).toContain("estimated costs only");
    expect((await refreshBillingController(env, now + 62000)).controller).toEqual(adjusted.controller);
    expect((await refreshBillingController(env, now + 122000)).controller.multiplierBps).toBe(23000);
    expect(policy.policy.maxMultiplierBps).toBe(23000);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_billing_policy_audit WHERE actor_id='billing-controller'").first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });
});

describe("admission boundaries", () => {
  it("quotes and reserves a measured 35k-token prompt within a 30-point consumer budget", async () => {
    await enable();
    await env.DB.prepare("UPDATE ai_billing_policy SET multiplier_bps=25000 WHERE id=1").run();
    const origin = "https://billing-estimate.example.test";
    const target = { ...env, BETTER_AUTH_URL: origin, AUTH_EMAIL_VERIFICATION: "off", EMAIL_FROM: "", EMAIL: undefined,
      AI_OPERATOR_USER_IDS: "[]", AI_UPSTREAM_BASE_URL: "https://upstream.example.test/v1", AI_UPSTREAM_API_KEY: "test-key",
      AI_DEFAULT_MODEL: "luna", AI_MODELS: JSON.stringify(config().models) } as unknown as Env;
    let upstreamCalls = 0;
    const worker = createWorker(undefined, undefined, undefined, (async () => {
      upstreamCalls++;
      return Response.json({ id: "chat-estimate", object: "chat.completion", model: "gpt-6-luna",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 35012, completion_tokens: 1, total_tokens: 35013,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 } } });
    }) as typeof fetch);
    async function call(path: string, body: unknown, token?: string) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(origin + path, { method: "POST", headers: {
        origin, "content-type": "application/json", "cf-connecting-ip": "203.0.113.179",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, body: JSON.stringify(body) }), target, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }
    const registration = await call("/api/auth/sign-up/email", { email: `${crypto.randomUUID()}@example.test`, name: "Token estimate", password: "test-estimate-password" });
    expect(registration.status).toBe(200);
    const { user } = await registration.json<{ user: { id: string } }>();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO account_ai_balances (owner_user_id,enabled,activated_at,available_micro_points,reserved_micro_points,updated_at) VALUES (?,1,?,30000000,0,?)").bind(user.id, now, now).run();
    const issued = await call("/v1/account/ai/tokens", { deviceId: crypto.randomUUID() }, registration.headers.get("set-auth-token")!);
    expect(issued.status).toBe(201);
    const { token } = await issued.json<{ token: string }>();
    const request = { model: "luna", messages: [{ role: "user", content: "x ".repeat(35000) }], max_tokens: 100, billing: { maxMicroPoints: 30000000 } };
    const quote = await call("/v1/ai/quote", { endpoint: "chat", request }, token);
    expect(quote.status).toBe(200);
    const quoted = await quote.json<{ estimatedInputTokens: number; estimatedMicroPoints: number; reservedMicroPoints: number }>();
    expect(quoted.estimatedInputTokens).toBeLessThan(30000);
    expect(quoted.estimatedMicroPoints).toBeLessThan(quoted.reservedMicroPoints);
    expect(quoted.reservedMicroPoints).toBeLessThanOrEqual(30000000);
    for (const extra of [
      { messages: [{ role: "user", content: "请解释代码🙂".repeat(1000) }] },
      { messages: [{ role: "system", content: "Respect these instructions. ".repeat(1000) }, { role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "search", description: "Search the supplied references. ".repeat(1000), parameters: { type: "object", properties: { query: { type: "string" } } } } }] },
    ]) {
      const multilingualRequest = { ...request, ...extra };
      const multilingualQuote = await call("/v1/ai/quote", { endpoint: "chat", request: multilingualRequest }, token);
      expect(multilingualQuote.status).toBe(200);
      const value = await multilingualQuote.json<{ estimatedInputTokens: number; reservedMicroPoints: number }>();
      const planned = (await planTaskBilling(env, config(), "chat", multilingualRequest))!;
      expect(value.estimatedInputTokens).toBe(planned.snapshot.estimatedInputTokens);
      expect(value.reservedMicroPoints).toBe(planned.snapshot.reservedMicroPoints);
      expect(planned.snapshot.maxInputTokens).toBe(inputReservationTokens(multilingualRequest, 500000, 100));
    }
    expect(upstreamCalls).toBe(0);
    const completion = await call("/v1/ai/chat/completions", request, token);
    expect(completion.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    const row = await env.DB.prepare("SELECT reserved_micro_points, billing_snapshot FROM account_ai_requests WHERE id=?").bind(completion.headers.get("x-ai-request-id")).first<{ reserved_micro_points: number; billing_snapshot: string }>();
    expect(row!.reserved_micro_points).toBe(quoted.reservedMicroPoints);
    expect(JSON.parse(row!.billing_snapshot).estimatedInputTokens).toBe(quoted.estimatedInputTokens);
  });
  it("does not count base64 image bytes as text tokens", async () => {
    await enable();
    const planned = await planTaskBilling(env, config(), "chat", { model: "auto-chat", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(600000)}` } }] }], max_tokens: 100 });
    expect(planned!.snapshot.estimatedInputTokens).toBeLessThan(1000);
    expect(planned!.snapshot.maxInputTokens).toBe(499900);
  });
  it("never reprices an admitted snapshot when operator conversion changes", async () => {
    const v = await enable();
    const first = (await planTaskBilling(env, config(), "chat", { model: "luna", messages: [], max_tokens: 100 }))!;
    const usage = { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 };
    const before = calculateTaskCharge(first.snapshot, usage);
    await saveBillingPolicy(env, "operator", { revision: v.revision, reason: "new valuation", policy: { ...v.policy, pointsPerCurrency: 2000 } });
    const second = (await planTaskBilling(env, config(), "chat", { model: "luna", messages: [], max_tokens: 100 }))!;
    expect(calculateTaskCharge(first.snapshot, usage)).toEqual(before);
    expect(second.snapshot.policyRevision).toBe(2);
    expect(second.snapshot.reservedMicroPoints).toBe(first.snapshot.reservedMicroPoints * 2);
  });
  it("drifts down toward the margin floor only with new known-cost evidence", async () => {
    const initial = await enable();
    await saveBillingPolicy(env, "operator", { revision: initial.revision, reason: "test healthy window", policy: { ...initial.policy, minSamples: 1 } });
    await env.DB.prepare("UPDATE ai_billing_policy SET multiplier_bps=24000, last_adjusted_at=? WHERE id=1").bind(Date.now() - 120000).run();
    const now = Date.now();
    await seedMetrics([{ state: "settled", cost: 100, charged: 300000, points: 1000 }], now);
    expect((await refreshBillingController(env, now + 1)).controller.multiplierBps).toBe(23000);
    expect((await refreshBillingController(env, now + 61000)).controller.multiplierBps).toBe(23000);
    await seedMetrics([{ state: "settled", cost: 100, charged: 300000, points: 1000 }], now + 62000);
    expect((await refreshBillingController(env, now + 62001)).controller.multiplierBps).toBe(22000);
  });
});
