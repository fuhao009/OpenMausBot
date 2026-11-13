import { z } from "zod";
import type { AiConfig, AiModelConfig } from "./ai-config";
import { HTTPError } from "./http";
import { getCostTariffs, resolveCostTariff } from "./cost-tariffs";
export { getCostTariffs } from "./cost-tariffs";

export interface BillingRates { input: number; cached: number; output: number; write: number | null; writeHour: number | null }
export interface BillingUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number | null; cacheWriteTokens?: number | null; cacheWriteHourTokens?: number | null }
export type Complexity = "simple" | "standard" | "complex";
export interface TaskBillingSnapshot {
  version: 1; policyRevision: number; currency: "USD"; pointsPerCurrency: number; multiplierBps: number;
  tariffId: string; requestedModel: string; selectedModel: string; channelId: string | null; serviceTier: string; startedAt: number;
  complexity: Complexity; score: number; reasons: string[]; estimatedInputTokens: number; maxInputTokens: number; maxOutputTokens: number;
  rates: BillingRates; longRates: BillingRates | null; longThreshold: number | null; longInclusive: boolean;
  reservedMicroPoints: number; maxCostMicroCurrency: number;
}
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const policySchema = z.strictObject({
  enabled: z.boolean(), currency: z.literal("USD"), pointsPerCurrency: integer.min(1).max(1_000_000),
  targetMarginBps: integer.max(9500), overheadBps: integer.max(10000),
  minMultiplierBps: integer.min(10000).max(1_000_000), maxMultiplierBps: integer.min(10000).max(1_000_000),
  maxStepBps: integer.min(1).max(10000), minSamples: integer.min(1).max(1000), cooldownSeconds: integer.min(1).max(86400), windowMinutes: integer.min(1).max(10080),
  profiles: z.array(z.strictObject({ modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/), capacity: z.enum(["simple", "standard", "complex"]), tools: z.boolean(), vision: z.boolean() })).max(50),
});
export type BillingPolicy = z.infer<typeof policySchema>;
export const DEFAULT_BILLING_POLICY: BillingPolicy = { enabled: false, currency: "USD", pointsPerCurrency: 1000, targetMarginBps: 5000, overheadBps: 1000, minMultiplierBps: 10000, maxMultiplierBps: 50000, maxStepBps: 1000, minSamples: 20, cooldownSeconds: 60, windowMinutes: 60, profiles: [] };
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function safe(value: bigint): number { if (value < 0n || value > SAFE) throw new HTTPError(400, "billing_amount_overflow"); return Number(value); }
function ceil(value: bigint, divisor: bigint): bigint { return (value + divisor - 1n) / divisor; }
function count(value: number): bigint { if (!Number.isSafeInteger(value) || value < 0) throw new HTTPError(400, "invalid_billing_usage"); return BigInt(value); }
function floor(p: BillingPolicy): number { return Number(ceil(BigInt(10000 + p.overheadBps) * 10000n, BigInt(10000 - p.targetMarginBps))); }
function rateMax(r: BillingRates): number { return Math.max(r.input, r.cached, r.write ?? 0, r.writeHour ?? 0); }
function worst(s: Pick<TaskBillingSnapshot, "rates" | "longRates">): BillingRates {
  const a = s.rates, b = s.longRates ?? a;
  return { input: Math.max(rateMax(a), rateMax(b)), cached: Math.max(rateMax(a), rateMax(b)), output: Math.max(a.output, b.output), write: null, writeHour: null };
}
function amounts(s: Pick<TaskBillingSnapshot, "pointsPerCurrency" | "multiplierBps">, numerator: bigint) {
  return { costMicroCurrency: safe(ceil(numerator, 1_000_000n)), chargedMicroPoints: safe(ceil(numerator * count(s.pointsPerCurrency) * count(s.multiplierBps), 10_000_000_000n)) };
}
export function calculateTaskReservation(s: TaskBillingSnapshot): { reservedMicroPoints: number; maxCostMicroCurrency: number } {
  if (s.version !== 1 || s.currency !== "USD" || !Number.isSafeInteger(s.pointsPerCurrency) || s.pointsPerCurrency < 1 || !Number.isSafeInteger(s.multiplierBps) || s.multiplierBps < 10000) throw new HTTPError(400, "invalid_billing_snapshot");
  for (const r of [s.rates, ...(s.longRates ? [s.longRates] : [])]) {
    count(r.input); count(r.cached); count(r.output);
    if (r.write !== null) count(r.write);
    if (r.writeHour !== null) count(r.writeHour);
  }
  if (s.longRates !== null && (s.longThreshold === null || !Number.isSafeInteger(s.longThreshold) || s.longThreshold < 0)) throw new HTTPError(400, "invalid_billing_snapshot");
  const r = worst(s), result = amounts(s, count(s.maxInputTokens) * count(r.input) + count(s.maxOutputTokens) * count(r.output));
  return { reservedMicroPoints: result.chargedMicroPoints, maxCostMicroCurrency: result.costMicroCurrency };
}
export function calculateTaskCharge(s: TaskBillingSnapshot, usage: BillingUsage): { chargedMicroPoints: number; costMicroCurrency: number; costStatus: "estimated" | "conservative" } {
  const input = count(usage.inputTokens), output = count(usage.outputTokens);
  if (output > count(s.maxOutputTokens)) throw new HTTPError(400, "billing_usage_overrun");
  const long = s.longThreshold !== null && (s.longInclusive ? usage.inputTokens >= s.longThreshold : usage.inputTokens > s.longThreshold);
  const r = long && s.longRates ? s.longRates : s.rates;
  for (const v of Object.values(r)) if (v !== null) count(v);
  const cached = count(usage.cachedInputTokens ?? 0), write = count(usage.cacheWriteTokens ?? 0), hour = count(usage.cacheWriteHourTokens ?? 0);
  if (cached + write + hour > input) throw new HTTPError(400, "invalid_cache_partition");
  if (write > 0n && r.write === null || hour > 0n && r.writeHour === null) throw new HTTPError(400, "missing_cache_write_tariff");
  let remainingRate = r.input, conservative = false;
  if (usage.cachedInputTokens == null) { remainingRate = Math.max(remainingRate, r.cached); conservative = true; }
  if (usage.cacheWriteTokens == null && r.write !== null && r.write > remainingRate) { remainingRate = r.write; conservative = true; }
  if (usage.cacheWriteHourTokens == null && r.writeHour !== null && r.writeHour > remainingRate) { remainingRate = r.writeHour; conservative = true; }
  const numerator = (input - cached - write - hour) * count(remainingRate) + cached * count(r.cached) + write * count(r.write ?? 0) + hour * count(r.writeHour ?? 0) + output * count(r.output);
  const result = amounts(s, numerator);
  return { ...result, costStatus: conservative ? "conservative" : "estimated" };
}
export function estimateTaskMicroPoints(s: TaskBillingSnapshot): number {
  const long = s.longThreshold !== null && (s.longInclusive ? s.estimatedInputTokens >= s.longThreshold : s.estimatedInputTokens > s.longThreshold);
  const r = long && s.longRates ? s.longRates : s.rates;
  return amounts(s, count(s.estimatedInputTokens) * count(r.input) + count(s.maxOutputTokens) * count(r.output)).chargedMicroPoints;
}
interface PolicyRow { revision: number; policy_json: string; multiplier_bps: number; last_adjusted_at: number | null; adjustment_reason: string }
export interface BillingPolicyView { revision: number; policy: BillingPolicy; controller: { multiplierBps: number; lastAdjustedAt: number | null; reason: string } }
export async function loadBillingPolicy(env: Env): Promise<BillingPolicyView> {
  const row = await env.DB.prepare("SELECT revision, policy_json, multiplier_bps, last_adjusted_at, adjustment_reason FROM ai_billing_policy WHERE id = 1").first<PolicyRow>();
  if (!row) return { revision: 0, policy: structuredClone(DEFAULT_BILLING_POLICY), controller: { multiplierBps: floor(DEFAULT_BILLING_POLICY), lastAdjustedAt: null, reason: "initial cost-based floor" } };
  return { revision: row.revision, policy: policySchema.parse(JSON.parse(row.policy_json)), controller: { multiplierBps: row.multiplier_bps, lastAdjustedAt: row.last_adjusted_at, reason: row.adjustment_reason } };
}
export async function saveBillingPolicy(env: Env, actorId: string, input: unknown): Promise<BillingPolicyView> {
  const schema = z.strictObject({ revision: integer.max(Number.MAX_SAFE_INTEGER - 1), reason: z.string().trim().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/), policy: policySchema });
  const parsed = schema.safeParse(input);
  if (!parsed.success || !actorId || actorId.length > 128) throw new HTTPError(400, "invalid_billing_policy");
  const { revision, reason, policy } = parsed.data;
  const lower = floor(policy);
  if (policy.minMultiplierBps > lower || policy.maxMultiplierBps < lower || policy.minMultiplierBps > policy.maxMultiplierBps || new Set(policy.profiles.map(p => p.modelId)).size !== policy.profiles.length) throw new HTTPError(400, "invalid_billing_policy");
  // Ensure the highest published rate is representable even at the hard policy maximum.
  try { for (const t of getCostTariffs()) for (const r of [t.rates, ...(t.longRates ? [t.longRates] : [])]) for (const value of Object.values(r)) if (value !== null) safe(ceil(BigInt(value) * BigInt(policy.pointsPerCurrency) * BigInt(policy.maxMultiplierBps) * 6n, 10000n)); }
  catch { throw new HTTPError(400, "billing_price_limit"); }
  const old = await loadBillingPolicy(env);
  if (old.revision !== revision) throw new HTTPError(409, "billing_revision_conflict");
  const multiplier = Math.max(lower, Math.min(policy.maxMultiplierBps, old.controller.multiplierBps));
  const values = [JSON.stringify(policy), multiplier, Date.now(), "policy updated: " + reason, actorId, reason, Date.now()];
  const result = revision === 0
    ? await env.DB.prepare("INSERT INTO ai_billing_policy (id, revision, policy_json, multiplier_bps, last_adjusted_at, adjustment_reason, actor_id, reason, updated_at) VALUES (1,1,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(...values).run()
    : await env.DB.prepare("UPDATE ai_billing_policy SET revision=revision+1, policy_json=?, multiplier_bps=?, last_adjusted_at=?, adjustment_reason=?, actor_id=?, reason=?, updated_at=? WHERE id=1 AND revision=?").bind(...values, revision).run();
  if (!result.meta.changes) throw new HTTPError(409, "billing_revision_conflict");
  return loadBillingPolicy(env);
}

function active(config: AiConfig, m: AiModelConfig): boolean { return m.enabled && (config.routes ? config.routes.has(m.id) : !!config.upstreamBaseURL && !!config.upstreamApiKey); }
const rank: Record<Complexity, number> = { simple: 0, standard: 1, complex: 2 };
const INPUT_RESERVE_FACTOR = 1.5;
const INPUT_RESERVE_MARGIN = 2048;

/** Shared admission estimate for fixed pricing, task pricing and quotes. */
export function inputReservationTokens(body: Record<string, unknown>, context: number, output: number): number {
  const assessment = assess(body);
  return boundedInputReservation(assessment, context, output);
}

function boundedInputReservation(assessment: { vision: boolean; estimatedInputTokens: number }, context: number, output: number): number {
  const remaining = context - output;
  return assessment.vision ? remaining : Math.min(remaining,
    Math.ceil(assessment.estimatedInputTokens * INPUT_RESERVE_FACTOR) + INPUT_RESERVE_MARGIN);
}

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    tokens += point <= 0x7f ? 0.25 : point <= 0x7ff ? 0.5 : point <= 0xffff ? 1.5 : 2;
  }
  return Math.max(1, Math.ceil(tokens));
}
/** Local structural heuristic only. Request text is inspected transiently, never stored. */
function assess(body: Record<string, unknown>) {
  const content = body.messages ?? body.input ?? "";
  const text = JSON.stringify(content);
  const estimatedText = JSON.stringify(body, (key, value: unknown) => key === "image_url" || key === "image" || typeof value === "string" && value.startsWith("data:image/") ? "[image]" : value);
  const estimatedInputTokens = estimateTextTokens(estimatedText);
  const turns = Array.isArray(content) ? content.length : 1;
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const vision = /"(?:image_url|input_image|image)"\s*:/.test(text) || /"type"\s*:\s*"(?:input_image|image_url)"/.test(text);
  if (/"(?:input_audio|audio|video)"/.test(text) || body.modalities !== undefined && JSON.stringify(body.modalities) !== '["text"]') throw new HTTPError(400, "unsupported_billing_modality");
  let score = 0;
  const reasons: string[] = [];
  if (estimatedInputTokens > 8000) { score += 2; reasons.push("large_request"); }
  if (estimatedInputTokens > 32000) { score += 3; reasons.push("very_large_request"); }
  if (turns > 8) { score++; reasons.push("many_turns"); }
  if (tools) { score += 2; reasons.push("tools_requested"); }
  if (vision) { score += 2; reasons.push("vision_requested"); }
  if (body.reasoning !== undefined || body.reasoning_effort === "high") { score += 3; reasons.push("reasoning_requested"); }
  if (/\b(prove|architecture|refactor|audit)\b|证明|架构|重构|审计/i.test(text)) { score += 2; reasons.push("task_markers"); }
  if (!reasons.length) reasons.push("small_text_request");
  return { complexity: (score >= 5 ? "complex" : score >= 2 ? "standard" : "simple") as Complexity, score, reasons, estimatedInputTokens, tools, vision };
}
function saleModel(model: AiModelConfig, s: TaskBillingSnapshot): AiModelConfig {
  const r = worst(s);
  const sale = (value: number) => safe(ceil(count(value) * count(s.pointsPerCurrency) * count(s.multiplierBps), 10000n));
  return { ...model, pricingVersion: `task-v1-r${s.policyRevision}-m${s.multiplierBps}`, inputMicroPointsPerMillion: sale(r.input), cachedInputMicroPointsPerMillion: sale(r.cached), outputMicroPointsPerMillion: sale(r.output) };
}
export async function planTaskBilling(env: Env, config: AiConfig, mode: "chat" | "responses", body: Record<string, unknown>, now = Date.now()): Promise<{ model: AiModelConfig; snapshot: TaskBillingSnapshot } | null> {
  const view = await loadBillingPolicy(env);
  const requested = typeof body.model === "string" ? body.model : config.defaultModel ?? "";
  const auto = requested === "auto-chat" || requested === "auto-responses";
  if (!view.policy.enabled) { if (auto) throw new HTTPError(403, "task_billing_disabled"); return null; }
  if (auto && requested !== `auto-${mode}`) throw new HTTPError(400, "model_protocol_mismatch");
  const profiles = view.policy.profiles;
  const explicit = config.models.find(m => m.id === requested);
  const explicitProfile = profiles.find(p => p.modelId === requested);
  if (!auto && (!explicit || !explicitProfile || !getCostTariffs().some(t => t.id === explicit.upstreamModel))) return null;
  const a = assess(body);
  const tier = body.service_tier === undefined ? "default" : body.service_tier;
  if (typeof tier !== "string") throw new HTTPError(400, "unsupported_service_tier");
  const outputValue = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (outputValue !== undefined && (typeof outputValue !== "number" || !Number.isSafeInteger(outputValue) || outputValue < 1)) throw new HTTPError(400, "invalid_max_tokens");
  const candidates: Array<{ model: AiModelConfig; snapshot: TaskBillingSnapshot }> = [];
  for (const model of config.models) {
    if (!auto && model.id !== requested) continue;
    const profile = profiles.find(p => p.modelId === model.id);
    if (!profile || !active(config, model) || model.protocol !== mode) continue;
    if (a.tools && !profile.tools || a.vision && !profile.vision || auto && rank[profile.capacity] < rank[a.complexity]) continue;
    let tariff;
    try { tariff = resolveCostTariff(model.upstreamModel, tier, now); } catch { if (!auto) throw new HTTPError(400, "unsupported_service_tier"); continue; }
    if (!tariff) continue;
    const maxOutputTokens = Math.min((outputValue as number | undefined) ?? model.maxOutputTokens, model.maxOutputTokens);
    const remaining = model.maxContextTokens - maxOutputTokens;
    if (remaining < a.estimatedInputTokens) continue;
    const maxInputTokens = boundedInputReservation(a, model.maxContextTokens, maxOutputTokens);
    const s: TaskBillingSnapshot = { version: 1, policyRevision: view.revision, currency: "USD", pointsPerCurrency: view.policy.pointsPerCurrency, multiplierBps: view.controller.multiplierBps, tariffId: tariff.id, requestedModel: requested, selectedModel: model.id, channelId: model.channelId ?? null, serviceTier: model.upstreamModel.endsWith("-ultrafast") ? "ultrafast" : tier, startedAt: now, complexity: a.complexity, score: a.score, reasons: a.reasons, estimatedInputTokens: a.estimatedInputTokens, maxInputTokens, maxOutputTokens, rates: tariff.rates, longRates: tariff.longRates, longThreshold: tariff.longThreshold, longInclusive: tariff.longInclusive, reservedMicroPoints: 0, maxCostMicroCurrency: 0 };
    Object.assign(s, calculateTaskReservation(s));
    candidates.push({ model: saleModel(model, s), snapshot: s });
  }
  candidates.sort((a, b) => estimateTaskMicroPoints(a.snapshot) - estimateTaskMicroPoints(b.snapshot) || a.model.id.localeCompare(b.model.id));
  const selected = candidates[0];
  if (!selected) throw new HTTPError(400, "no_eligible_billing_model");
  return selected;
}
export async function applyBillingCatalog(env: Env, config: AiConfig): Promise<AiConfig> {
  const view = await loadBillingPolicy(env);
  if (!view.policy.enabled) return config;
  const eligible: AiModelConfig[] = [];
  const models = config.models.map(model => {
    if (!active(config, model) || !view.policy.profiles.some(p => p.modelId === model.id)) return model;
    const t = resolveCostTariff(model.upstreamModel, "default", Date.now());
    if (!t) return model;
    const s = { rates: t.rates, longRates: t.longRates, pointsPerCurrency: view.policy.pointsPerCurrency, multiplierBps: view.controller.multiplierBps, policyRevision: view.revision } as TaskBillingSnapshot;
    const priced = saleModel(model, s); eligible.push(priced); return priced;
  });
  for (const mode of ["chat", "responses"] as const) {
    const first = eligible.filter(m => m.protocol === mode).sort((a, b) => a.inputMicroPointsPerMillion - b.inputMicroPointsPerMillion || a.id.localeCompare(b.id))[0];
    if (first && !models.some(m => m.id === `auto-${mode}`)) models.push({ ...first, id: `auto-${mode}`, label: mode === "chat" ? "Auto chat · task routing" : "Auto responses · task routing" });
  }
  return { ...config, models };
}
interface MetricRow { id: string; model: string; billing_snapshot: string; state: string; charged_micro_points: number | null; cost_micro_currency: number | null; cost_status: string | null; created_at: number; updated_at: number; latency_ms: number | null }
async function metricRows(env: Env, minutes: number, now: number): Promise<MetricRow[]> {
  const result = await env.DB.prepare("SELECT id, model, billing_snapshot, state, charged_micro_points, cost_micro_currency, cost_status, created_at, updated_at, latency_ms FROM account_ai_requests WHERE created_at >= ? AND billing_snapshot IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1000").bind(now - minutes * 60000).all<MetricRow>();
  return result.results;
}
export async function getBillingMetrics(env: Env) {
  const v = await loadBillingPolicy(env), rows = await metricRows(env, v.policy.windowMinutes, Date.now());
  const known = rows.filter(r => r.state === "settled" && r.cost_micro_currency !== null && (r.cost_status === "estimated" || r.cost_status === "conservative"));
  const charged = known.reduce((s, r) => s + BigInt(r.charged_micro_points ?? 0), 0n);
  const cost = known.reduce((s, r) => s + BigInt(r.cost_micro_currency!), 0n);
  // Valuation follows each immutable snapshot, not today's conversion policy.
  const revenue = known.reduce((s, r) => s + BigInt(r.charged_micro_points ?? 0) / BigInt((JSON.parse(r.billing_snapshot) as TaskBillingSnapshot).pointsPerCurrency), 0n);
  const models = [...new Set(rows.map(r => r.model))].map(model => {
    const selected = rows.filter(r => r.model === model), k = known.filter(r => r.model === model), latency = selected.filter(r => r.latency_ms !== null);
    return { model, sampleCount: selected.length, settledCount: selected.filter(r => r.state === "settled").length, reviewCount: selected.filter(r => r.state === "review").length, unknownCostCount: selected.filter(r => r.cost_micro_currency === null).length, chargedMicroPoints: safe(k.reduce((s, r) => s + BigInt(r.charged_micro_points ?? 0), 0n)), estimatedCostMicroCurrency: safe(k.reduce((s, r) => s + BigInt(r.cost_micro_currency!), 0n)), latencyAvgMs: latency.length ? latency.reduce((s, r) => s + r.latency_ms!, 0) / latency.length : null };
  });
  return { currency: v.policy.currency, pointsPerCurrency: v.policy.pointsPerCurrency, windowMinutes: v.policy.windowMinutes, sampleCount: rows.length, settledCount: rows.filter(r => r.state === "settled").length, reviewCount: rows.filter(r => r.state === "review").length, unknownCostCount: rows.filter(r => r.cost_micro_currency === null).length, chargedMicroPoints: safe(charged), estimatedCostMicroCurrency: safe(cost), estimatedRevenueMicroCurrency: safe(revenue), estimatedProfitMicroCurrency: Number(revenue - cost), estimatedMarginBps: revenue > 0n ? Number((revenue - cost) * 10000n / revenue) : null, multiplierBps: v.controller.multiplierBps, lastAdjustedAt: v.controller.lastAdjustedAt, adjustmentReason: v.controller.reason, models, recent: rows.slice(0, 50).map(r => ({ id: r.id, model: r.model, complexity: (JSON.parse(r.billing_snapshot) as TaskBillingSnapshot).complexity, chargedMicroPoints: r.charged_micro_points, costMicroCurrency: r.cost_micro_currency, costStatus: r.cost_status ?? "unknown", state: r.state, createdAt: r.created_at, latencyMs: r.latency_ms })), tariffs: getCostTariffs() };
}
export async function refreshBillingController(env: Env, now = Date.now()): Promise<BillingPolicyView> {
  const v = await loadBillingPolicy(env), p = v.policy;
  if (!p.enabled || v.controller.lastAdjustedAt !== null && now - v.controller.lastAdjustedAt < p.cooldownSeconds * 1000) return v;
  const rows = (await metricRows(env, p.windowMinutes, now)).filter(r => r.state === "settled" || r.state === "review");
  if (rows.length < p.minSamples || !rows.some(r => r.updated_at > (v.controller.lastAdjustedAt ?? -1))) return v;
  const failures = rows.filter(r => r.state === "review" || r.cost_micro_currency === null).length;
  const known = rows.filter(r => r.state === "settled" && r.cost_micro_currency !== null && (r.cost_status === "estimated" || r.cost_status === "conservative"));
  const cost = known.reduce((sum, r) => sum + BigInt(r.cost_micro_currency!), 0n);
  const revenue = known.reduce((sum, r) => sum + BigInt(r.charged_micro_points ?? 0) / BigInt((JSON.parse(r.billing_snapshot) as TaskBillingSnapshot).pointsPerCurrency), 0n);
  const deficit = known.length >= p.minSamples && (revenue === 0n ? cost > 0n : (revenue - cost) * 10000n < revenue * BigInt(p.targetMarginBps));
  const increase = failures / rows.length > .1 || deficit;
  const next = Math.max(floor(p), Math.min(p.maxMultiplierBps, v.controller.multiplierBps + (increase ? p.maxStepBps : -p.maxStepBps)));
  const reason = failures / rows.length > .1 ? "bounded risk allowance: review/unknown cost fraction >10%; estimated costs only" : deficit ? "bounded correction: known-cost estimated margin below target; not actual invoice profit" : "bounded drift toward cost-based margin floor; estimated costs only";
  await env.DB.prepare("UPDATE ai_billing_policy SET multiplier_bps=?, last_adjusted_at=?, adjustment_reason=?, actor_id='billing-controller', reason=?, updated_at=? WHERE id=1 AND revision=? AND multiplier_bps=? AND last_adjusted_at IS ?").bind(next, now, reason, reason, now, v.revision, v.controller.multiplierBps, v.controller.lastAdjustedAt).run();
  return loadBillingPolicy(env);
}
