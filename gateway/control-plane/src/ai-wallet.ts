import type {
  ProductLedgerEntry,
  ProductLedgerPage,
  ProductModel,
} from "../../../packages/shared/product-account";
import { HTTPError } from "./http";
import { calculateTaskCharge, calculateTaskReservation, type BillingUsage, type TaskBillingSnapshot } from "./task-billing";

/**
 * Account-funded AI ledger: balances, per-request reservations, settlement,
 * and the operator adjustments that enable accounts and add credit.
 *
 * Amounts are micro-points of service credit (1 point = 1,000,000
 * micro-points); a point is the product's own unit, never a currency or the
 * upstream's billed money. Prices are operator-configured micro-points per
 * million tokens. Every amount and token count is a
 * nonnegative JavaScript safe integer; all arithmetic that decides a charge
 * happens in BigInt and is range-checked before it becomes a number. The
 * triggers in `migrations/0012_account_ai.sql` enforce the same invariants
 * atomically, so two Workers can never spend the same balance or refund a
 * reservation twice.
 */

/** 2^53 - 1: the largest amount a Worker can hold exactly. */
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const MICRO_POINTS_PER_MILLION = 1_000_000n;
/** A reservation older than this is surfaced for review, never auto-charged
 * or auto-refunded. */
const STALE_RESERVATION_MS = 10 * 60 * 1_000;
const LEDGER_PAGE_LIMIT = 50;
const RECOVERY_BATCH_LIMIT = 100;
const MAX_SETTLEMENT_REASON = 200;
const MAX_MODEL_ID = 128;
const MAX_PRICING_VERSION = 64;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RequestState = "reserved" | "streaming" | "review" | "settled";
export type AdjustmentKind = "enable" | "disable" | "grant" | "settle";

export interface Balance {
  activatedAt: number | null;
  availableMicroPoints: number;
  enabled: boolean;
  reservedMicroPoints: number;
}

/** Rates are micro-points per million tokens, as published in the catalog. */
export interface PricingSnapshot {
  cachedRate: number;
  inputRate: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  outputRate: number;
  pricingVersion: string;
}

/** A missing `cachedInputTokens` means the upstream did not report cache
 * usage at all: it is billed at the higher of the two input rates instead of
 * being treated as a free cache hit. */
export interface Usage extends BillingUsage {}

export interface RequestEntry {
  cachedInputTokens: number | null;
  cachedRate: number;
  chargedMicroPoints: number | null;
  createdAt: number;
  endpoint: "chat" | "responses";
  id: string;
  inputRate: number;
  inputTokens: number | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  model: string;
  outputRate: number;
  outputTokens: number | null;
  pricingVersion: string;
  reservedMicroPoints: number;
  settlementReason: string | null;
  settledAt: number | null;
  state: RequestState;
  updatedAt: number;
  userId: string;
  cacheWriteTokens?: number | null;
  cacheWriteHourTokens?: number | null;
  costMicroCurrency?: number | null;
  costStatus?: "estimated" | "conservative" | "unknown" | null;
  latencyMs?: number | null;
  complexity?: TaskBillingSnapshot["complexity"];
  requestedModel?: string;
  serviceTier?: string;
}

interface BalanceRow {
  activated_at: number | null;
  available_micro_points: number;
  enabled: number;
  reserved_micro_points: number;
}

interface RequestRow {
  cached_input_tokens: number | null;
  cached_rate: number;
  charged_micro_points: number | null;
  created_at: number;
  endpoint: "chat" | "responses";
  id: string;
  input_rate: number;
  input_tokens: number | null;
  max_input_tokens: number;
  max_output_tokens: number;
  model: string;
  output_rate: number;
  output_tokens: number | null;
  owner_user_id: string;
  pricing_version: string;
  reserved_micro_points: number;
  settlement_reason: string | null;
  settled_at: number | null;
  state: RequestState;
  updated_at: number;
  billing_snapshot: string | null;
  cost_micro_currency: number | null;
  cost_status: "estimated" | "conservative" | "unknown" | null;
  cache_write_tokens: number | null;
  cache_write_hour_tokens: number | null;
  latency_ms: number | null;
}

interface AdmissionProbeRow {
  available_micro_points: number;
  enabled: number;
  in_flight: number;
  session_live: number;
  token_live: number;
}

interface CursorValue {
  createdAt: number;
  id: string;
}

function requireSafeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function ceilMicroPoints(numerator: bigint): number {
  if (numerator < 0n) throw new RangeError("amount_out_of_range");
  const amount = (numerator + MICRO_POINTS_PER_MILLION - 1n) / MICRO_POINTS_PER_MILLION;
  if (amount > BigInt(MAX_AMOUNT)) throw new RangeError("amount_out_of_range");
  return Number(amount);
}

/**
 * The amount a request must hold before it may reach the upstream:
 * `ceil((maxContext × max(inputRate, cachedRate) + effectiveMaxOutput ×
 * outputRate) / 1e6)`. The input ceiling is the model's full context bound,
 * not a guess from the prompt, so an accepted request can never exceed it.
 */
export function reservationMicroPoints(model: Pick<
  ProductModel,
  | "cachedInputMicroPointsPerMillion"
  | "inputMicroPointsPerMillion"
  | "maxContextTokens"
  | "maxOutputTokens"
  | "outputMicroPointsPerMillion"
>): number {
  const input = BigInt(requireSafeCount(model.inputMicroPointsPerMillion, "input rate"));
  const cached = BigInt(requireSafeCount(model.cachedInputMicroPointsPerMillion, "cached rate"));
  const output = BigInt(requireSafeCount(model.outputMicroPointsPerMillion, "output rate"));
  const context = BigInt(requireSafeCount(model.maxContextTokens, "context ceiling"));
  const maxOutput = BigInt(requireSafeCount(model.maxOutputTokens, "output ceiling"));
  return ceilMicroPoints(context * (input > cached ? input : cached) + maxOutput * output);
}

/**
 * The amount actually charged for a settled request:
 * `ceil(((input − cached) × inputRate + cached × cachedRate + output ×
 * outputRate) / 1e6)`. `cached` is a subset of `input` and reasoning tokens
 * are already inside `output`, so neither is billed twice. Without a cached
 * count, every input token is billed at the higher input rate.
 */
export function chargeMicroPoints(
  rates: Pick<PricingSnapshot, "cachedRate" | "inputRate" | "outputRate">,
  usage: Usage,
): number {
  const inputTokens = requireSafeCount(usage.inputTokens, "input tokens");
  const outputTokens = requireSafeCount(usage.outputTokens, "output tokens");
  const input = BigInt(requireSafeCount(rates.inputRate, "input rate"));
  const cached = BigInt(requireSafeCount(rates.cachedRate, "cached rate"));
  const output = BigInt(requireSafeCount(rates.outputRate, "output rate"));
  const cachedTokens = usage.cachedInputTokens;
  if (cachedTokens === undefined || cachedTokens === null) {
    return ceilMicroPoints(
      BigInt(inputTokens) * (input > cached ? input : cached) + BigInt(outputTokens) * output,
    );
  }
  const cachedCount = requireSafeCount(cachedTokens, "cached input tokens");
  if (cachedCount > inputTokens) throw new RangeError("cached_input_tokens_exceeds_input");
  return ceilMicroPoints(
    BigInt(inputTokens - cachedCount) * input
      + BigInt(cachedCount) * cached
      + BigInt(outputTokens) * output,
  );
}

function base64URLEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64URLDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new HTTPError(400, "invalid_cursor");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HTTPError(400, "invalid_cursor");
  }
}

function encodeCursor(cursor: CursorValue): string {
  return base64URLEncode(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }));
}

/** A ledger cursor is opaque, but strictly validated: a malformed one is a
 * client error, never a silent restart from the beginning. */
export function decodeLedgerCursor(cursor: string): CursorValue {
  if (cursor.length === 0 || cursor.length > 256 || !CURSOR_PATTERN.test(cursor)) {
    throw new HTTPError(400, "invalid_cursor");
  }
  let value: unknown;
  try {
    value = JSON.parse(base64URLDecode(cursor));
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(400, "invalid_cursor");
  }
  if (typeof value !== "object" || value === null) throw new HTTPError(400, "invalid_cursor");
  if (!("createdAt" in value) || !("id" in value)) throw new HTTPError(400, "invalid_cursor");
  const { createdAt, id } = value;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new HTTPError(400, "invalid_cursor");
  }
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new HTTPError(400, "invalid_cursor");
  return { createdAt, id };
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return LEDGER_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) return LEDGER_PAGE_LIMIT;
  return Math.min(limit, LEDGER_PAGE_LIMIT);
}

function cursorClause(
  table: string,
  idColumn: string,
  cursor: CursorValue | null,
): { sql: string; values: unknown[] } {
  if (!cursor) return { sql: "", values: [] };
  return {
    sql: ` AND (${table}.created_at < ? OR (${table}.created_at = ? AND ${table}.${idColumn} < ?))`,
    values: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

function requestEntry(row: RequestRow): RequestEntry {
  const billing: TaskBillingSnapshot | null = row.billing_snapshot === null ? null : JSON.parse(row.billing_snapshot);
  return {
    cachedInputTokens: row.cached_input_tokens,
    cachedRate: row.cached_rate,
    chargedMicroPoints: row.charged_micro_points,
    createdAt: row.created_at,
    endpoint: row.endpoint,
    id: row.id,
    inputRate: row.input_rate,
    inputTokens: row.input_tokens,
    maxInputTokens: row.max_input_tokens,
    maxOutputTokens: row.max_output_tokens,
    model: row.model,
    outputRate: row.output_rate,
    outputTokens: row.output_tokens,
    pricingVersion: row.pricing_version,
    reservedMicroPoints: row.reserved_micro_points,
    settlementReason: row.settlement_reason,
    settledAt: row.settled_at,
    state: row.state,
    updatedAt: row.updated_at,
    userId: row.owner_user_id,
    ...(billing === null ? {} : {
      cacheWriteTokens: row.cache_write_tokens,
      cacheWriteHourTokens: row.cache_write_hour_tokens,
      costMicroCurrency: row.cost_micro_currency,
      costStatus: row.cost_status,
      latencyMs: row.latency_ms,
      complexity: billing.complexity,
      requestedModel: billing.requestedModel,
      serviceTier: billing.serviceTier,
    }),
  };
}

const REQUEST_COLUMNS = `id, owner_user_id, model, endpoint, pricing_version, input_rate, cached_rate,
  output_rate, max_input_tokens, max_output_tokens, reserved_micro_points, state,
  charged_micro_points, input_tokens, cached_input_tokens, output_tokens,
  settlement_reason, created_at, updated_at, settled_at, billing_snapshot,
  cost_micro_currency, cost_status, cache_write_tokens, cache_write_hour_tokens, latency_ms`;

/** The account's ledger row, or null when it has never been touched. An
 * account without a row is pending with a zero balance; reading never
 * creates one. */
export async function getBalance(env: Env, userId: string): Promise<Balance | null> {
  const row = await env.DB.prepare(
    `SELECT enabled, activated_at, available_micro_points, reserved_micro_points
       FROM account_ai_balances
      WHERE owner_user_id = ?`,
  ).bind(userId).first<BalanceRow>();
  if (row === null) return null;
  return {
    activatedAt: row.activated_at,
    availableMicroPoints: row.available_micro_points,
    enabled: row.enabled === 1,
    reservedMicroPoints: row.reserved_micro_points,
  };
}

export async function getRequest(env: Env, requestId: string): Promise<RequestEntry | null> {
  if (!UUID_PATTERN.test(requestId)) return null;
  const row = await env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM account_ai_requests WHERE id = ?`,
  ).bind(requestId).first<RequestRow>();
  return row === null ? null : requestEntry(row);
}

function ledgerRequestEntry(row: RequestRow): ProductLedgerEntry {
  const entry: ProductLedgerEntry = {
    id: row.id,
    kind: "request",
    createdAt: row.created_at,
    model: row.model,
    state: row.state,
    reservedMicroPoints: row.reserved_micro_points,
  };
  if (row.charged_micro_points !== null) entry.chargedMicroPoints = row.charged_micro_points;
  if (row.input_tokens !== null) entry.inputTokens = row.input_tokens;
  if (row.cached_input_tokens !== null) entry.cachedInputTokens = row.cached_input_tokens;
  if (row.output_tokens !== null) entry.outputTokens = row.output_tokens;
  if (row.settlement_reason !== null) entry.reason = row.settlement_reason;
  return entry;
}

interface AdjustmentRow {
  amount_micro_points: number | null;
  created_at: number;
  kind: AdjustmentKind;
  operation_id: string;
  reason: string;
}

function ledgerAdjustmentEntry(row: AdjustmentRow): ProductLedgerEntry {
  const entry: ProductLedgerEntry = {
    id: row.operation_id,
    kind: row.kind,
    createdAt: row.created_at,
    reason: row.reason,
  };
  if (row.amount_micro_points !== null) entry.amountMicroPoints = row.amount_micro_points;
  return entry;
}

function compareEntries(left: ProductLedgerEntry, right: ProductLedgerEntry): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

/**
 * The signed-in account's own history: requests (including ones awaiting
 * review) and operator adjustments, newest first. Conversation content and
 * credentials are never part of an entry.
 */
export async function listLedger(
  env: Env,
  userId: string,
  cursor?: string,
  limit?: number,
): Promise<ProductLedgerPage> {
  const take = pageLimit(limit);
  const after = cursor === undefined || cursor === "" ? null : decodeLedgerCursor(cursor);
  const requestCursor = cursorClause("account_ai_requests", "id", after);
  const adjustmentCursor = cursorClause("account_ai_adjustments", "operation_id", after);
  // One extra row per side proves whether anything remains past the cut.
  const fetch = take + 1;
  const [requests, adjustments] = await Promise.all([
    env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM account_ai_requests
        WHERE owner_user_id = ?${requestCursor.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(userId, ...requestCursor.values, fetch).all<RequestRow>(),
    env.DB.prepare(
      `SELECT operation_id, kind, amount_micro_points, reason, created_at
         FROM account_ai_adjustments
        WHERE owner_user_id = ?${adjustmentCursor.sql}
        ORDER BY created_at DESC, operation_id DESC
        LIMIT ?`,
    ).bind(userId, ...adjustmentCursor.values, fetch).all<AdjustmentRow>(),
  ]);

  const merged = [
    ...requests.results.map(ledgerRequestEntry),
    ...adjustments.results.map(ledgerAdjustmentEntry),
  ].sort(compareEntries);
  const items = merged.slice(0, take);
  const last = items.at(-1);
  const nextCursor = merged.length > take && last
    ? encodeCursor({ createdAt: last.createdAt, id: last.id })
    : null;
  return { items, nextCursor };
}

/**
 * The operator's request view: every reservation, including the ones whose
 * outcome is unknown and whose money is still held.
 */
export async function listRequests(
  env: Env,
  userId: string,
  cursor?: string,
  limit?: number,
): Promise<{ items: RequestEntry[]; nextCursor: string | null }> {
  const take = pageLimit(limit);
  const after = cursor === undefined || cursor === "" ? null : decodeLedgerCursor(cursor);
  const page = cursorClause("account_ai_requests", "id", after);
  const rows = await env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM account_ai_requests
      WHERE owner_user_id = ?${page.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).bind(userId, ...page.values, take + 1).all<RequestRow>();
  const items = rows.results.slice(0, take).map(requestEntry);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.results.length > take && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  };
}

export interface ReserveInput {
  endpoint: "chat" | "responses";
  model: string;
  ownerUserId: string;
  pricing: PricingSnapshot;
  tokenId: string;
  billing?: TaskBillingSnapshot;
}

export type ReserveResult =
  | { id: string; ok: true; reservedMicroPoints: number }
  | { ok: false; reason: "ai_busy" | "insufficient_balance" | "not_enabled" };

function validatePricing(pricing: PricingSnapshot, calculateReservation = true): number {
  requireSafeCount(pricing.inputRate, "input rate");
  requireSafeCount(pricing.cachedRate, "cached rate");
  requireSafeCount(pricing.outputRate, "output rate");
  requireSafeCount(pricing.maxInputTokens, "max input tokens");
  requireSafeCount(pricing.maxOutputTokens, "max output tokens");
  if (pricing.maxInputTokens < 1) throw new RangeError("max input tokens must be positive");
  if (
    typeof pricing.pricingVersion !== "string"
    || pricing.pricingVersion.length < 1
    || pricing.pricingVersion.length > MAX_PRICING_VERSION
  ) {
    throw new RangeError("invalid pricing version");
  }
  if (!calculateReservation) return 0;
  return ceilMicroPoints(
    BigInt(pricing.maxInputTokens) * BigInt(Math.max(pricing.inputRate, pricing.cachedRate))
      + BigInt(pricing.maxOutputTokens) * BigInt(pricing.outputRate),
  );
}

/** Dynamic callers supply the planner's selected model, maximum sale rates and
 * exact token bounds. The hold uses exact tariff arithmetic, not the rounded
 * public per-million hints (rounding those first can overstate the hold). */
function validateBilling(input: ReserveInput): number {
  const billing = input.billing!;
  if (billing.version !== 1 || billing.currency !== "USD"
    || billing.selectedModel !== input.model
    || billing.maxInputTokens !== input.pricing.maxInputTokens
    || billing.maxOutputTokens !== input.pricing.maxOutputTokens) {
    throw new RangeError("billing_snapshot_mismatch");
  }
  const bound = calculateTaskReservation(billing);
  if (requireSafeCount(billing.reservedMicroPoints, "billing reservation") !== bound.reservedMicroPoints
    || requireSafeCount(billing.maxCostMicroCurrency, "billing cost bound") !== bound.maxCostMicroCurrency) {
    throw new RangeError("billing_reservation_mismatch");
  }
  const all = billing.longRates === null ? [billing.rates] : [billing.rates, billing.longRates];
  const inputRate = Math.max(...all.flatMap((rate) => [rate.input, rate.cached, rate.write ?? 0, rate.writeHour ?? 0]));
  const outputRate = Math.max(...all.map((rate) => rate.output));
  const saleRate = (rate: number): number => {
    const numerator = BigInt(requireSafeCount(rate, "tariff rate"))
      * BigInt(requireSafeCount(billing.pointsPerCurrency, "points per currency"))
      * BigInt(requireSafeCount(billing.multiplierBps, "billing multiplier"));
    const result = (numerator + 9999n) / 10000n;
    if (result > BigInt(MAX_AMOUNT)) throw new RangeError("amount_out_of_range");
    return Number(result);
  };
  if (input.pricing.inputRate !== saleRate(inputRate)
    || input.pricing.cachedRate !== saleRate(inputRate)
    || input.pricing.outputRate !== saleRate(outputRate)) {
    throw new RangeError("billing_sale_rates_mismatch");
  }
  return bound.reservedMicroPoints;
}

/**
 * Admits one upstream call and moves its worst-case cost from available to
 * reserved. A single `INSERT ... SELECT` decides every condition against one
 * snapshot — the account is enabled, the credential is still live, the
 * balance covers the reservation — and the in-flight trigger caps concurrent
 * calls at two. Nothing is reserved when the request cannot be forwarded.
 */
export async function reserveRequest(
  env: Env,
  input: ReserveInput,
  now: number = Date.now(),
): Promise<ReserveResult> {
  if (input.endpoint !== "chat" && input.endpoint !== "responses") {
    throw new RangeError("unsupported endpoint");
  }
  if (typeof input.model !== "string" || input.model.length < 1 || input.model.length > MAX_MODEL_ID) {
    throw new RangeError("invalid model");
  }
  if (typeof input.ownerUserId !== "string" || input.ownerUserId.length === 0) {
    throw new RangeError("invalid owner");
  }
  if (typeof input.tokenId !== "string" || input.tokenId.length === 0) {
    throw new RangeError("invalid token");
  }
  const legacyReserved = validatePricing(input.pricing, input.billing === undefined);
  const reserved = input.billing === undefined ? legacyReserved : validateBilling(input);
  const billingJSON = input.billing === undefined ? null : JSON.stringify(input.billing);
  const id = crypto.randomUUID();

  try {
    const result = await env.DB.prepare(
      `INSERT INTO account_ai_requests
         (id, owner_user_id, token_id, model, endpoint, pricing_version,
          input_rate, cached_rate, output_rate, max_input_tokens, max_output_tokens,
          reserved_micro_points, state, created_at, updated_at, billing_snapshot, cost_status)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?
         FROM account_ai_balances b
         JOIN account_ai_tokens t
           ON t.id = ? AND t.owner_user_id = b.owner_user_id
          AND t.revoked_at IS NULL AND t.expires_at > ?
         JOIN "session" s ON s.id = t.session_id AND s."userId" = t.owner_user_id
        WHERE b.owner_user_id = ?
          AND b.enabled = 1
          AND b.available_micro_points >= ?`,
    ).bind(
      id,
      input.ownerUserId,
      input.tokenId,
      input.model,
      input.endpoint,
      input.pricing.pricingVersion,
      input.pricing.inputRate,
      input.pricing.cachedRate,
      input.pricing.outputRate,
      input.pricing.maxInputTokens,
      input.pricing.maxOutputTokens,
      reserved,
      now,
      now,
      billingJSON,
      billingJSON === null ? null : "unknown",
      input.tokenId,
      now,
      input.ownerUserId,
      reserved,
    ).run();
    if ((result.meta.changes ?? 0) > 0) return { id, ok: true, reservedMicroPoints: reserved };
  } catch (error) {
    if (error instanceof Error && /ai_busy/i.test(error.message)) {
      return { ok: false, reason: "ai_busy" };
    }
    // Another admission won the balance between the SELECT and the transfer;
    // the probe below reports the state it actually left behind.
    if (
      !(error instanceof Error)
      || !/ai_reserve_conflict|CHECK constraint failed: available_micro_points/i.test(error.message)
    ) {
      throw error;
    }
  }

  const probe = await env.DB.prepare(
    `SELECT b.enabled AS enabled,
            b.available_micro_points AS available_micro_points,
            (SELECT COUNT(*) FROM account_ai_requests r
              WHERE r.owner_user_id = b.owner_user_id AND r.state IN ('reserved', 'streaming')) AS in_flight,
            EXISTS (
              SELECT 1 FROM account_ai_tokens t
               WHERE t.id = ? AND t.owner_user_id = b.owner_user_id
                 AND t.revoked_at IS NULL AND t.expires_at > ?
            ) AS token_live,
            EXISTS (
              SELECT 1 FROM account_ai_tokens t
                JOIN "session" s ON s.id = t.session_id AND s."userId" = t.owner_user_id
               WHERE t.id = ? AND t.owner_user_id = b.owner_user_id
            ) AS session_live
       FROM account_ai_balances b
      WHERE b.owner_user_id = ?`,
  ).bind(input.tokenId, now, input.tokenId, input.ownerUserId)
    .first<AdmissionProbeRow>();
  if (!probe || probe.enabled !== 1) return { ok: false, reason: "not_enabled" };
  // The credential itself died between authentication and admission (revoked,
  // expired, or its session signed out): that is an authentication failure,
  // not a permission one.
  if (!probe.token_live || !probe.session_live) throw new HTTPError(401, "ai_token_invalid");
  if (probe.in_flight >= 2) return { ok: false, reason: "ai_busy" };
  if (probe.available_micro_points < reserved) return { ok: false, reason: "insufficient_balance" };
  // Every condition held and still nothing was written: a concurrent
  // admission filled the last slot between these two statements.
  return { ok: false, reason: "ai_busy" };
}

/** `reserved` → `streaming`, once the upstream has answered. */
export async function markRequestStreaming(
  env: Env,
  requestId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE account_ai_requests SET state = 'streaming', updated_at = ?
      WHERE id = ? AND state = 'reserved'`,
  ).bind(now, requestId).run();
  return (result.meta.changes ?? 0) > 0;
}

export type SettleResult =
  | { chargedMicroPoints: number; status: "settled" }
  | { reason: string; status: "review" }
  | { status: "missing" };

/**
 * Settles a finished request at its real usage and returns the unused part of
 * the reservation exactly once. Usage outside the snapshot's bounds is never
 * charged at the maximum: the row moves to `review` with the reservation
 * intact for an operator to check.
 */
export async function settleRequest(
  env: Env,
  requestId: string,
  usage: Usage,
  now: number = Date.now(),
): Promise<SettleResult> {
  if (!UUID_PATTERN.test(requestId)) return { status: "missing" };
  const row = await env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM account_ai_requests WHERE id = ?`,
  ).bind(requestId).first<RequestRow>();
  if (row === null) return { status: "missing" };
  if (row.state === "settled") {
    return { chargedMicroPoints: row.charged_micro_points ?? 0, status: "settled" };
  }
  if (row.state === "review") return { reason: row.settlement_reason ?? "under_review", status: "review" };

  const invalid = reasonForUnusable(row, usage);
  if (invalid !== null) return { status: "review", reason: await reviewOrKeep(env, requestId, invalid, now) };

  let charged: number;
  let costMicroCurrency: number | null = null;
  let costStatus: "estimated" | "conservative" | null = null;
  try {
    if (row.billing_snapshot !== null) {
      const cost = calculateTaskCharge(JSON.parse(row.billing_snapshot) as TaskBillingSnapshot, usage);
      charged = cost.chargedMicroPoints;
      costMicroCurrency = cost.costMicroCurrency;
      costStatus = cost.costStatus;
    } else {
      charged = chargeMicroPoints(
        { cachedRate: row.cached_rate, inputRate: row.input_rate, outputRate: row.output_rate },
        usage,
      );
    }
  } catch {
    return { status: "review", reason: await reviewOrKeep(env, requestId, "usage_invalid", now) };
  }
  if (charged > row.reserved_micro_points) {
    return { status: "review", reason: await reviewOrKeep(env, requestId, "charge_exceeds_reservation", now) };
  }

  const cached = usage.cachedInputTokens === undefined || usage.cachedInputTokens === null
    ? null
    : usage.cachedInputTokens;
  const result = await env.DB.prepare(
    `UPDATE account_ai_requests
        SET state = 'settled', charged_micro_points = ?, input_tokens = ?,
            cached_input_tokens = ?, output_tokens = ?, settlement_reason = NULL,
            settled_at = ?, updated_at = ?, cost_micro_currency = ?, cost_status = ?,
            cache_write_tokens = ?, cache_write_hour_tokens = ?, latency_ms = ?
      WHERE id = ? AND state IN ('reserved', 'streaming') AND charged_micro_points IS NULL`,
  ).bind(
    charged,
    usage.inputTokens,
    cached,
    usage.outputTokens,
    now,
    now,
    costMicroCurrency,
    costStatus,
    costStatus === null ? null : usage.cacheWriteTokens ?? null,
    costStatus === null ? null : usage.cacheWriteHourTokens ?? null,
    costStatus === null ? null : Math.max(0, now - row.created_at),
    requestId,
  ).run();
  if ((result.meta.changes ?? 0) > 0) return { chargedMicroPoints: charged, status: "settled" };

  // Another writer settled it first (a duplicated terminal frame) or an
  // operator settled it out of review. Report what actually happened.
  const current = await env.DB.prepare(
    "SELECT state, charged_micro_points, settlement_reason FROM account_ai_requests WHERE id = ?",
  ).bind(requestId).first<{ charged_micro_points: number | null; settlement_reason: string | null; state: RequestState }>();
  if (!current) return { status: "missing" };
  if (current.state === "settled") {
    return { chargedMicroPoints: current.charged_micro_points ?? 0, status: "settled" };
  }
  if (current.state === "review") return { reason: current.settlement_reason ?? "under_review", status: "review" };
  return { status: "missing" };
}

function reasonForUnusable(row: RequestRow, usage: Usage): string | null {
  for (const value of [usage.inputTokens, usage.outputTokens]) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "usage_invalid";
  }
  const cached = usage.cachedInputTokens;
  if (cached !== undefined && cached !== null) {
    if (typeof cached !== "number" || !Number.isSafeInteger(cached) || cached < 0) return "usage_invalid";
    if (cached > usage.inputTokens) return "usage_invalid";
  }
  if (usage.inputTokens > row.max_input_tokens) return "usage_over_reservation";
  if (usage.outputTokens > row.max_output_tokens) return "usage_over_reservation";
  return null;
}

async function reviewOrKeep(env: Env, requestId: string, reason: string, now: number): Promise<string> {
  const moved = await reviewRequest(env, requestId, reason, now).catch(() => false);
  return moved ? reason : "review_state_changed";
}

/** `reserved`/`streaming` → `review`: keep the reservation, charge nothing,
 * refund nothing. Used when the outcome cannot be proven. */
export async function reviewRequest(
  env: Env,
  requestId: string,
  reason: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE account_ai_requests
        SET state = 'review', settlement_reason = ?, updated_at = ?,
            cost_micro_currency = NULL,
            cost_status = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE 'unknown' END,
            latency_ms = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE max(0, ? - created_at) END
      WHERE id = ? AND state IN ('reserved', 'streaming')`,
  ).bind(reason.slice(0, MAX_SETTLEMENT_REASON) || "review", now, now, requestId).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Settles a request that provably never reached the upstream at zero, which
 * releases its whole reservation. Any doubt must use `reviewRequest` instead.
 */
export async function releaseRequest(
  env: Env,
  requestId: string,
  reason: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE account_ai_requests
        SET state = 'settled', charged_micro_points = 0, settlement_reason = ?,
            settled_at = ?, updated_at = ?, cost_micro_currency = NULL,
            cost_status = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE 'unknown' END,
            latency_ms = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE max(0, ? - created_at) END
      WHERE id = ? AND state IN ('reserved', 'streaming') AND charged_micro_points IS NULL`,
  ).bind(reason.slice(0, MAX_SETTLEMENT_REASON) || "released", now, now, now, requestId).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * The scheduled sweep: a reservation that never reached a terminal state
 * (the process died, the client vanished, the upstream never answered) is
 * surfaced for review rather than charged at its maximum or given away.
 */
export async function recoverStaleRequests(
  env: Env,
  now: number = Date.now(),
  limit: number = RECOVERY_BATCH_LIMIT,
): Promise<number> {
  const cutoff = now - STALE_RESERVATION_MS;
  const take = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, RECOVERY_BATCH_LIMIT)
    : RECOVERY_BATCH_LIMIT;
  const result = await env.DB.prepare(
    `UPDATE account_ai_requests
        SET state = 'review', settlement_reason = 'stale_reservation', updated_at = ?,
            cost_micro_currency = NULL,
            cost_status = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE 'unknown' END,
            latency_ms = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE max(0, ? - created_at) END
      WHERE state IN ('reserved', 'streaming') AND created_at <= ?
        AND id IN (
          SELECT id FROM account_ai_requests
           WHERE state IN ('reserved', 'streaming') AND created_at <= ?
           ORDER BY created_at, id
           LIMIT ?
        )`,
  ).bind(now, now, cutoff, cutoff, take).run();
  return result.meta.changes ?? 0;
}

export interface AdjustmentInput {
  amountMicroPoints?: number;
  enabled?: boolean;
  kind: AdjustmentKind;
  /** Defaults to `Date.now()`; tests pin the clock. */
  now?: number;
  operationId: string;
  operatorUserId: string;
  ownerUserId: string;
  reason: string;
  requestId?: string;
}

export interface AdjustmentResult {
  result: Record<string, unknown>;
  status: "applied" | "replayed";
}

interface AdjustmentAuditRow {
  body_hash: string;
  result_json: string;
}

/** The stored identity of an operator body. Derived here from the fields that
 * actually move money, so a caller cannot make two different requests share
 * one operation id (or make one request look like another) by lying about a
 * hash it computed itself. */
async function canonicalBodyHash(input: AdjustmentInput, reason: string): Promise<string> {
  const canonical = JSON.stringify({
    kind: input.kind,
    operatorUserId: input.operatorUserId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId ?? null,
    amountMicroPoints: input.amountMicroPoints ?? null,
    enabled: input.enabled ?? null,
    reason,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertReason(reason: unknown): string {
  if (typeof reason !== "string") throw new HTTPError(400, "invalid_request");
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500) throw new HTTPError(400, "invalid_request");
  for (const character of trimmed) {
    const point = character.codePointAt(0);
    if (point === undefined || point < 32 || point === 127) throw new HTTPError(400, "invalid_request");
  }
  return trimmed;
}

async function requireExistingUser(env: Env, userId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(userId).first<{ id: string }>();
  if (row === null) throw new HTTPError(404, "not_found");
}

function replayedAudit(row: AdjustmentAuditRow, bodyHash: string): AdjustmentResult {
  if (row.body_hash !== bodyHash) throw new HTTPError(409, "operation_conflict");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.result_json);
  } catch {
    throw new HTTPError(500, "internal_error");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HTTPError(500, "internal_error");
  }
  // The row stores exactly the JSON object written in the same transaction.
  const result = parsed as Record<string, unknown>;
  return { result, status: "replayed" };
}

/**
 * Applies one operator mutation exactly once. The operation id is the
 * idempotency key: replaying the same canonical body returns the stored
 * result, while reusing the id with a different body is a conflict. The audit
 * row, the money movement, and the request transition are one statement (the
 * database triggers apply the effects), so a retry can never grant twice.
 */
export async function applyAdjustment(env: Env, input: AdjustmentInput): Promise<AdjustmentResult> {
  if (!UUID_PATTERN.test(input.operationId)) throw new HTTPError(400, "invalid_request");
  if (typeof input.operatorUserId !== "string" || input.operatorUserId.length === 0) {
    throw new HTTPError(400, "invalid_request");
  }
  if (typeof input.ownerUserId !== "string" || input.ownerUserId.length === 0) {
    throw new HTTPError(400, "invalid_request");
  }
  const reason = assertReason(input.reason);
  const now = input.now ?? Date.now();
  const bodyHash = await canonicalBodyHash(input, reason);

  const existing = await env.DB.prepare(
    "SELECT body_hash, result_json FROM account_ai_adjustments WHERE operation_id = ?",
  ).bind(input.operationId).first<AdjustmentAuditRow>();
  if (existing) return replayedAudit(existing, bodyHash);

  let enabled: number | null = null;
  let amount: number | null = null;
  let requestId: string | null = null;
  let result: Record<string, unknown>;

  switch (input.kind) {
    case "grant": {
      const value = input.amountMicroPoints;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new HTTPError(400, "invalid_request");
      }
      await requireExistingUser(env, input.ownerUserId);
      // Credit must keep every refund path representable: a reservation in
      // flight will return into `available`, so both columns count.
      const balance = await getBalance(env, input.ownerUserId);
      const total = BigInt(balance?.availableMicroPoints ?? 0)
        + BigInt(balance?.reservedMicroPoints ?? 0)
        + BigInt(value);
      if (total > BigInt(MAX_AMOUNT)) throw new HTTPError(400, "amount_out_of_range");
      amount = value;
      result = { amountMicroPoints: value, kind: "grant", userId: input.ownerUserId };
      break;
    }
    case "enable":
    case "disable": {
      if (input.kind === "enable" ? input.enabled !== true : input.enabled !== false) {
        throw new HTTPError(400, "invalid_request");
      }
      await requireExistingUser(env, input.ownerUserId);
      enabled = input.kind === "enable" ? 1 : 0;
      result = { enabled: enabled === 1, kind: input.kind, userId: input.ownerUserId };
      break;
    }
    case "settle": {
      const value = input.amountMicroPoints;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new HTTPError(400, "invalid_request");
      }
      if (typeof input.requestId !== "string" || !UUID_PATTERN.test(input.requestId)) {
        throw new HTTPError(400, "invalid_request");
      }
      const request = await getRequest(env, input.requestId);
      if (request === null || request.userId !== input.ownerUserId) throw new HTTPError(404, "not_found");
      if (request.state !== "review") throw new HTTPError(409, "request_not_in_review");
      if (value > request.reservedMicroPoints) throw new HTTPError(400, "invalid_request");
      requestId = input.requestId;
      amount = value;
      result = { chargedMicroPoints: value, kind: "settle", requestId: input.requestId };
      break;
    }
    default:
      throw new HTTPError(400, "invalid_request");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO account_ai_adjustments
         (operation_id, operator_user_id, owner_user_id, kind, request_id, body_hash,
          amount_micro_points, enabled, reason, created_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.operationId,
      input.operatorUserId,
      input.ownerUserId,
      input.kind,
      requestId,
      bodyHash,
      amount,
      enabled,
      reason,
      now,
      JSON.stringify(result),
    ).run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (/UNIQUE constraint failed: account_ai_adjustments\.operation_id/i.test(error.message)) {
      // Two operators raced the same operation id; the loser reports what the
      // winner actually did.
      const winner = await env.DB.prepare(
        "SELECT body_hash, result_json FROM account_ai_adjustments WHERE operation_id = ?",
      ).bind(input.operationId).first<AdjustmentAuditRow>();
      if (winner) return replayedAudit(winner, bodyHash);
      throw error;
    }
    if (/ai_request_not_in_review/i.test(error.message)) {
      throw new HTTPError(409, "request_not_in_review");
    }
    if (/ai_balance_overflow/i.test(error.message)) throw new HTTPError(400, "amount_out_of_range");
    if (/ai_charge_invalid/i.test(error.message)) throw new HTTPError(400, "invalid_request");
    if (/CHECK constraint failed|integer overflow/i.test(error.message)) {
      throw new HTTPError(400, "amount_out_of_range");
    }
    if (/FOREIGN KEY constraint failed/i.test(error.message)) throw new HTTPError(404, "not_found");
    throw error;
  }
  return { result, status: "applied" };
}
