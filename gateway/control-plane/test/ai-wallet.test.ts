import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ProductLedgerPage } from "../../../packages/shared/product-account";
import {
  applyAdjustment,
  chargeMicroPoints,
  decodeLedgerCursor,
  getBalance,
  getRequest,
  listLedger,
  markRequestStreaming,
  recoverStaleRequests,
  releaseRequest,
  reservationMicroPoints,
  reserveRequest,
  reviewRequest,
  settleRequest,
  type Balance,
  type ReserveInput,
  type ReserveResult,
} from "../src/ai-wallet";
import { HTTPError } from "../src/http";
import type { TaskBillingSnapshot } from "../src/task-billing";

/** The plan's worked example: R = ceil((1000×2_000_000 + 100×4_000_000)/1e6). */
const MODEL = {
  inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000,
  outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};
const RATES = {
  inputRate: MODEL.inputMicroPointsPerMillion,
  cachedRate: MODEL.cachedInputMicroPointsPerMillion,
  outputRate: MODEL.outputMicroPointsPerMillion,
};
const PRICING = {
  ...RATES,
  maxInputTokens: MODEL.maxContextTokens,
  maxOutputTokens: MODEL.maxOutputTokens,
  pricingVersion: "2026-11-01",
};
/** 1000 input tokens of which 200 were cached, plus 100 output tokens:
 * 800×2,000,000 + 200×500,000 + 100×4,000,000 = 2,100,000,000 / 1e6 = 2100. */
const USAGE = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 };
const REASONABLE_CHARGE = 2100;

async function seedUser(email: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(id, email.split("@", 1)[0], email, now, now).run();
  return id;
}

/** A live model credential row, as `account-ai.ts` issues it: bound to a
 * real, unexpired Better Auth session. */
async function seedToken(
  ownerUserId: string,
  options: {
    createdAt?: number;
    expiresAt?: number;
    revokedAt?: number | null;
    signedOut?: boolean;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = options.createdAt ?? now - 1_000;
  const sessionId = crypto.randomUUID();
  if (!options.signedOut) {
    await env.DB.prepare(
      `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      new Date(now + 60 * 60 * 1_000).toISOString(),
      crypto.randomUUID(),
      new Date(createdAt).toISOString(),
      new Date(createdAt).toISOString(),
      ownerUserId,
    ).run();
  }
  await env.DB.prepare(
    `INSERT INTO account_ai_tokens
       (id, owner_user_id, session_id, device_id, lookup_id, secret_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    ownerUserId,
    sessionId,
    `dev-${crypto.randomUUID()}`,
    crypto.randomUUID().replaceAll("-", "").slice(0, 22),
    "a".repeat(64),
    createdAt,
    options.expiresAt ?? now + 10 * 60 * 1_000,
    options.revokedAt ?? null,
  ).run();
  return id;
}

async function enableAccount(
  operatorUserId: string,
  ownerUserId: string,
  availableMicroPoints: number,
): Promise<void> {
  // A fixed clock keeps the adjustment order deterministic: enable then grant.
  const enabled = await applyAdjustment(env, {
    operationId: crypto.randomUUID(),
    operatorUserId,
    ownerUserId,
    kind: "enable",
    enabled: true,
    reason: "approved",
    now: 1_000,
  });
  expect(enabled.status).toBe("applied");
  if (availableMicroPoints > 0) {
    await applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId,
      kind: "grant",
      amountMicroPoints: availableMicroPoints,
      reason: "welcome credit",
      now: 1_001,
    });
  }
}

interface TestAccount {
  operatorUserId: string;
  tokenId: string;
  userId: string;
}

async function fundedAccount(options: { availableMicroPoints?: number } = {}): Promise<TestAccount> {
  const operatorUserId = await seedUser("operator@example.com");
  const userId = await seedUser(`person-${crypto.randomUUID()}@example.com`);
  await enableAccount(operatorUserId, userId, options.availableMicroPoints ?? 3_000);
  const tokenId = await seedToken(userId);
  return { operatorUserId, tokenId, userId };
}

function reserve(
  account: Pick<TestAccount, "tokenId" | "userId">,
  overrides: Partial<ReserveInput> = {},
  now?: number,
): Promise<ReserveResult> {
  return reserveRequest(env, {
    endpoint: "chat",
    model: "m1",
    ownerUserId: account.userId,
    pricing: PRICING,
    tokenId: account.tokenId,
    ...overrides,
  }, now);
}

/** Reserves and proves admission, returning the request id. */
async function admittedId(
  account: Pick<TestAccount, "tokenId" | "userId">,
  overrides: Partial<ReserveInput> = {},
  now?: number,
): Promise<string> {
  const result = await reserve(account, overrides, now);
  if (!result.ok) throw new Error(`expected admission, got ${result.reason}`);
  expect(result.reservedMicroPoints).toBe(2_400);
  return result.id;
}

async function balanceOf(userId: string): Promise<Balance> {
  const balance = await getBalance(env, userId);
  if (!balance) throw new Error("missing balance row");
  return balance;
}

describe("money arithmetic", () => {
  it("reserves the worst case from the full context ceiling", () => {
    expect(reservationMicroPoints(MODEL)).toBe(2_400);
    // A cheaper cached rate never lowers the reservation: the same tokens
    // could arrive uncached.
    expect(reservationMicroPoints({ ...MODEL, cachedInputMicroPointsPerMillion: 0 })).toBe(2_400);
    expect(reservationMicroPoints({ ...MODEL, maxOutputTokens: 0 })).toBe(2_000);
  });

  it("charges exactly the worked example, not the reservation", () => {
    expect(chargeMicroPoints(RATES, USAGE)).toBe(REASONABLE_CHARGE);
    // Explicit zero usage is a real, chargeable outcome.
    expect(chargeMicroPoints(RATES, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
    // Cached tokens are billed at the cached rate, the rest at input.
    expect(chargeMicroPoints(RATES, { inputTokens: 10, cachedInputTokens: 10, outputTokens: 0 })).toBe(5);
    // Rounding is per request and always upward.
    expect(chargeMicroPoints({ inputRate: 1, cachedRate: 1, outputRate: 0 }, {
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 0,
    })).toBe(1);
  });

  it("bills missing cache detail at the higher input rate, never as a cache hit", () => {
    // Plan rule: without a cached count, all input is billed at
    // max(inputRate, cachedRate) and no cached count is invented.
    expect(chargeMicroPoints(RATES, { inputTokens: 1000, cachedInputTokens: null, outputTokens: 100 }))
      .toBe(2_400);
    expect(chargeMicroPoints(
      { inputRate: 1_000_000, cachedRate: 3_000_000, outputRate: 0 },
      { inputTokens: 2, cachedInputTokens: null, outputTokens: 0 },
    )).toBe(6);
    // An explicit zero is a reported cache miss, not an unknown.
    expect(chargeMicroPoints(
      { inputRate: 1_000_000, cachedRate: 3_000_000, outputRate: 0 },
      { inputTokens: 2, cachedInputTokens: 0, outputTokens: 0 },
    )).toBe(2);
  });

  it("rejects impossible or unrepresentable amounts instead of guessing", () => {
    expect(() => chargeMicroPoints(RATES, { inputTokens: 100, cachedInputTokens: 200, outputTokens: 0 }))
      .toThrow(RangeError);
    expect(() => chargeMicroPoints(RATES, { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }))
      .toThrow(RangeError);
    expect(() => chargeMicroPoints(RATES, { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0 }))
      .toThrow(RangeError);
    expect(() => reservationMicroPoints({
      ...MODEL,
      inputMicroPointsPerMillion: Number.MAX_SAFE_INTEGER,
      maxContextTokens: Number.MAX_SAFE_INTEGER,
    })).toThrow(RangeError);
    expect(() => chargeMicroPoints(
      { inputRate: Number.MAX_SAFE_INTEGER, cachedRate: 0, outputRate: Number.MAX_SAFE_INTEGER },
      { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER },
    )).toThrow(RangeError);
  });
});

describe("reservation and settlement", () => {
  it("moves the reservation out of available and returns the unused part once", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    expect(await balanceOf(account.userId)).toEqual({
      activatedAt: expect.any(Number),
      availableMicroPoints: 600,
      enabled: true,
      reservedMicroPoints: 2_400,
    });

    expect(await markRequestStreaming(env, id)).toBe(true);
    expect(await markRequestStreaming(env, id)).toBe(false);

    expect(await settleRequest(env, id, USAGE)).toEqual({ chargedMicroPoints: 2_100, status: "settled" });
    expect(await balanceOf(account.userId)).toEqual({
      activatedAt: expect.any(Number),
      availableMicroPoints: 900,
      enabled: true,
      reservedMicroPoints: 0,
    });

    // The same terminal usage arriving twice (duplicate frame) never charges
    // twice, and the row keeps the first terminal numbers.
    expect(await settleRequest(env, id, USAGE)).toEqual({ chargedMicroPoints: 2_100, status: "settled" });
    expect(await settleRequest(env, id, { ...USAGE, outputTokens: 10_000 }))
      .toEqual({ chargedMicroPoints: 2_100, status: "settled" });
    expect((await balanceOf(account.userId)).availableMicroPoints).toBe(900);
  });

  it("admits only one of two simultaneous requests when the balance covers one", async () => {
    const account = await fundedAccount();
    const results = await Promise.all([reserve(account), reserve(account)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "insufficient_balance" },
    ]);
    expect(await balanceOf(account.userId)).toMatchObject({
      availableMicroPoints: 600,
      reservedMicroPoints: 2_400,
    });
    const requests = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM account_ai_requests WHERE owner_user_id = ?",
    ).bind(account.userId).first<{ total: number }>();
    expect(requests?.total).toBe(1);
  });

  it("never holds more than two calls in flight, and reviews do not occupy a slot", async () => {
    const account = await fundedAccount({ availableMicroPoints: 100_000 });
    const first = await admittedId(account);
    await admittedId(account);
    expect(await reserve(account)).toEqual({ ok: false, reason: "ai_busy" });

    // A stuck reservation in review keeps its money but frees its slot.
    await reviewRequest(env, first, "usage_missing");
    await admittedId(account);
    expect(await balanceOf(account.userId)).toMatchObject({ reservedMicroPoints: 3 * 2_400 });
  });

  it("refuses an account without a ledger row and never creates one", async () => {
    const userId = await seedUser("never-enabled@example.com");
    const tokenId = await seedToken(userId);
    expect(await reserve({ tokenId, userId })).toEqual({ ok: false, reason: "not_enabled" });
    expect(await getBalance(env, userId)).toBeNull();
  });

  it("stops admitting new calls after a disable or a dead credential", async () => {
    const account = await fundedAccount();
    await applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId: account.operatorUserId,
      ownerUserId: account.userId,
      kind: "disable",
      enabled: false,
      reason: "billing review",
    });
    // Disabling keeps the balance exactly where it was.
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 3_000, enabled: false });
    expect(await reserve(account)).toEqual({ ok: false, reason: "not_enabled" });

    await applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId: account.operatorUserId,
      ownerUserId: account.userId,
      kind: "enable",
      enabled: true,
      reason: "restored",
    });
    await admittedId(account);

    // A credential revoked or expired between authentication and admission is
    // an authentication failure, not a permission one.
    const revoked = await seedToken(account.userId, { revokedAt: Date.now() });
    await expect(reserve({ ...account, tokenId: revoked }))
      .rejects.toMatchObject({ status: 401, code: "ai_token_invalid" });
    const expired = await seedToken(account.userId, {
      createdAt: Date.now() - 20 * 60 * 1_000,
      expiresAt: Date.now() - 5 * 60 * 1_000,
    });
    await expect(reserve({ ...account, tokenId: expired }))
      .rejects.toMatchObject({ status: 401, code: "ai_token_invalid" });
    // Signing out drops the session row while the credential row remains.
    const signedOut = await seedToken(account.userId, { signedOut: true });
    await expect(reserve({ ...account, tokenId: signedOut }))
      .rejects.toMatchObject({ status: 401, code: "ai_token_invalid" });
  });

  it("settles usage without cache detail at the full input rate and stores no cached count", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    // 1000 input × 2,000,000 + 100 output × 4,000,000 = 2400, the whole
    // reservation; the row must not claim a cached count it never saw.
    expect(await settleRequest(env, id, { inputTokens: 1000, cachedInputTokens: null, outputTokens: 100 }))
      .toEqual({ chargedMicroPoints: 2_400, status: "settled" });
    expect(await getRequest(env, id)).toMatchObject({
      state: "settled",
      chargedMicroPoints: 2_400,
      cachedInputTokens: null,
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 600, reservedMicroPoints: 0 });
  });

  it("settles an explicit zero-usage outcome at zero instead of reviewing it", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    expect(await settleRequest(env, id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }))
      .toEqual({ chargedMicroPoints: 0, status: "settled" });
    expect(await getRequest(env, id)).toMatchObject({
      state: "settled",
      chargedMicroPoints: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 3_000, reservedMicroPoints: 0 });
  });

  it("settles an already-admitted call even after its account is disabled", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    await applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId: account.operatorUserId,
      ownerUserId: account.userId,
      kind: "disable",
      enabled: false,
      reason: "suspicious activity",
    });
    expect(await settleRequest(env, id, USAGE)).toEqual({ chargedMicroPoints: 2_100, status: "settled" });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 900, reservedMicroPoints: 0 });
  });

  it("keeps the price snapshot when the operator reprices a model", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    // The admission snapshot is immutable, even against a direct rewrite.
    await expect(env.DB.prepare("UPDATE account_ai_requests SET input_rate = 1 WHERE id = ?").bind(id).run())
      .rejects.toThrow(/ai_request_immutable/);
    expect(await settleRequest(env, id, USAGE)).toEqual({ chargedMicroPoints: 2_100, status: "settled" });
  });

  it("moves usage beyond the reservation bounds to review without charging", async () => {
    const account = await fundedAccount({ availableMicroPoints: 100_000 });
    const overInput = await admittedId(account);
    expect(await settleRequest(env, overInput, { ...USAGE, inputTokens: 1_001 }))
      .toEqual({ reason: "usage_over_reservation", status: "review" });
    expect(await getRequest(env, overInput)).toMatchObject({
      state: "review",
      settlementReason: "usage_over_reservation",
      chargedMicroPoints: null,
      reservedMicroPoints: 2_400,
    });

    const overOutput = await admittedId(account);
    expect(await settleRequest(env, overOutput, { ...USAGE, outputTokens: 101 }))
      .toEqual({ reason: "usage_over_reservation", status: "review" });

    const impossibleCached = await admittedId(account);
    expect(await settleRequest(env, impossibleCached, { ...USAGE, cachedInputTokens: 1_001 }))
      .toEqual({ reason: "usage_invalid", status: "review" });

    // Every review keeps its own reservation until an operator settles it.
    expect(await balanceOf(account.userId)).toMatchObject({
      availableMicroPoints: 100_000 - 3 * 2_400,
      reservedMicroPoints: 3 * 2_400,
    });
  });

  it("releases a provably unsent request at zero exactly once", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    expect(await releaseRequest(env, id, "client_aborted_before_response")).toBe(true);
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 3_000, reservedMicroPoints: 0 });
    expect(await releaseRequest(env, id, "client_aborted_before_response")).toBe(false);
    expect(await settleRequest(env, id, USAGE)).toEqual({ chargedMicroPoints: 0, status: "settled" });
    expect((await balanceOf(account.userId)).availableMicroPoints).toBe(3_000);
  });
});

describe("task billing ledger", () => {
  function snapshot(now = Date.now()): TaskBillingSnapshot {
    return {
      version: 1, policyRevision: 1, currency: "USD", pointsPerCurrency: 1000,
      multiplierBps: 22000, tariffId: "test", requestedModel: "auto-chat", selectedModel: "m1",
      channelId: null, serviceTier: "standard", startedAt: now,
      complexity: "standard", score: 3, reasons: ["test workload"], estimatedInputTokens: 100,
      maxInputTokens: 1000, maxOutputTokens: 100,
      rates: { input: 1000000, cached: 100000, output: 2000000, write: 1250000, writeHour: 2000000 },
      longRates: null, longThreshold: null, longInclusive: false,
      reservedMicroPoints: 4840000, maxCostMicroCurrency: 2200,
    };
  }

  function dynamic(billing = snapshot()): Partial<ReserveInput> {
    return { billing, pricing: { ...PRICING, inputRate: 4400000000, cachedRate: 4400000000,
      outputRate: 4400000000 } };
  }

  async function dynamicId(account: TestAccount, billing = snapshot()): Promise<string> {
    const result = await reserve(account, dynamic(billing), billing.startedAt);
    if (!result.ok) throw new Error(result.reason);
    expect(result.reservedMicroPoints).toBe(4840000);
    return result.id;
  }

  const measured = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100,
    cacheWriteTokens: 100, cacheWriteHourTokens: 50 };

  it("settles disjoint cache partitions and cost atomically, preserving the immutable snapshot", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const billing = snapshot();
    const id = await dynamicId(account, billing);
    billing.rates.input = 1;
    await expect(env.DB.prepare("UPDATE account_ai_requests SET billing_snapshot = NULL WHERE id = ?")
      .bind(id).run()).rejects.toThrow(/ai_request_immutable/);
    expect(await settleRequest(env, id, measured, billing.startedAt + 125))
      .toEqual({ status: "settled", chargedMicroPoints: 2409000 });
    expect(await getRequest(env, id)).toMatchObject({ costMicroCurrency: 1095, costStatus: "estimated",
      cacheWriteTokens: 100, cacheWriteHourTokens: 50, latencyMs: 125, requestedModel: "auto-chat" });
    expect(await settleRequest(env, id, { ...measured, outputTokens: 9999 }, billing.startedAt + 999))
      .toEqual({ status: "settled", chargedMicroPoints: 2409000 });
    expect(await getRequest(env, id)).toMatchObject({ costMicroCurrency: 1095, latencyMs: 125 });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 7591000, reservedMicroPoints: 0 });
    await expect(env.DB.prepare("UPDATE account_ai_requests SET cost_micro_currency = 0 WHERE id = ?")
      .bind(id).run()).rejects.toThrow(/ai_request_immutable/);
    const entry = (await listLedger(env, account.userId)).items.find((item) => item.id === id);
    expect(entry).not.toHaveProperty("costMicroCurrency");
  });

  it("uses a conservative write ceiling rather than inventing missing cache discounts", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const id = await dynamicId(account);
    expect(await settleRequest(env, id, { inputTokens: 1000, outputTokens: 100 }))
      .toEqual({ status: "settled", chargedMicroPoints: 4840000 });
    expect(await getRequest(env, id)).toMatchObject({ costMicroCurrency: 2200, costStatus: "conservative",
      cacheWriteTokens: null, cacheWriteHourTokens: null, cachedInputTokens: null });
  });

  it("keeps unknown costs for overrun, invalid partitions, release and manual settlement", async () => {
    const account = await fundedAccount({ availableMicroPoints: 30000000 });
    const billing = snapshot();
    const over = await dynamicId(account, billing);
    expect(await settleRequest(env, over, { ...measured, inputTokens: 1001 }, billing.startedAt + 50))
      .toEqual({ status: "review", reason: "usage_over_reservation" });
    expect(await getRequest(env, over)).toMatchObject({ costMicroCurrency: null, costStatus: "unknown", latencyMs: 50 });
    await applyAdjustment(env, { operationId: crypto.randomUUID(), operatorUserId: account.operatorUserId,
      ownerUserId: account.userId, kind: "settle", requestId: over, amountMicroPoints: 10,
      reason: "usage could not be reconciled", now: billing.startedAt + 70 });
    expect(await getRequest(env, over)).toMatchObject({ costMicroCurrency: null, costStatus: "unknown",
      chargedMicroPoints: 10, latencyMs: 70 });
    const invalid = await dynamicId(account);
    expect(await settleRequest(env, invalid, { ...measured, cacheWriteTokens: 900 }))
      .toMatchObject({ status: "review" });
    const released = await dynamicId(account, billing);
    expect(await releaseRequest(env, released, "not_sent", billing.startedAt + 100)).toBe(true);
    expect(await getRequest(env, released)).toMatchObject({ chargedMicroPoints: 0,
      costMicroCurrency: null, costStatus: "unknown", latencyMs: 100 });
    expect(await releaseRequest(env, released, "duplicate")).toBe(false);
  });

  it("never double charges concurrent terminal usage, or mismatches cost and charge", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const id = await dynamicId(account);
    const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 };
    const results = await Promise.all([settleRequest(env, id, measured), settleRequest(env, id, zero)]);
    expect(results[0]).toEqual(results[1]);
    const row = await getRequest(env, id);
    expect([0, 2409000]).toContain(row?.chargedMicroPoints);
    expect(row?.costMicroCurrency).toBe(row?.chargedMicroPoints === 0 ? 0 : 1095);
    expect((await balanceOf(account.userId)).availableMicroPoints).toBe(10000000 - row!.chargedMicroPoints!);
  });

  it("reserves from exact tariff arithmetic instead of rounded public sale hints", async () => {
    const account = await fundedAccount();
    const billing: TaskBillingSnapshot = { ...snapshot(), pointsPerCurrency: 1, multiplierBps: 10001,
      maxInputTokens: 1000000, maxOutputTokens: 1000000,
      rates: { input: 1, cached: 1, output: 1, write: null, writeHour: null },
      reservedMicroPoints: 3, maxCostMicroCurrency: 2 };
    const result = await reserve(account, { billing, pricing: { ...PRICING,
      maxInputTokens: 1000000, maxOutputTokens: 1000000, inputRate: 2, cachedRate: 2, outputRate: 2 } });
    expect(result).toMatchObject({ ok: true, reservedMicroPoints: 3 });
    if (!result.ok) throw new Error(result.reason);
    expect(await settleRequest(env, result.id, { inputTokens: 1000000, outputTokens: 1000000,
      cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 }))
      .toEqual({ status: "settled", chargedMicroPoints: 3 });
    expect(await getRequest(env, result.id)).toMatchObject({ costMicroCurrency: 2 });
  });

  it("rejects mismatched bounds, model, sale rates and forged reservation before any money moves", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const billing = snapshot();
    await expect(reserve(account, dynamic({ ...billing, reservedMicroPoints: 1 }))).rejects.toThrow();
    await expect(reserve(account, dynamic({ ...billing, maxCostMicroCurrency: 1 }))).rejects.toThrow();
    await expect(reserve(account, dynamic({ ...billing, selectedModel: "other" }))).rejects.toThrow();
    await expect(reserve(account, dynamic({ ...billing, maxInputTokens: 999 }))).rejects.toThrow();
    await expect(reserve(account, { ...dynamic(), pricing: PRICING })).rejects.toThrow();
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 10000000, reservedMicroPoints: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM account_ai_requests WHERE owner_user_id = ?")
      .bind(account.userId).first()).toEqual({ total: 0 });
  });

  it("reviews reported cache writes without a matching tariff, never pricing them at zero", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const billing = snapshot();
    billing.rates.write = null;
    const id = await dynamicId(account, billing);
    expect(await settleRequest(env, id, measured)).toMatchObject({ status: "review" });
    expect(await getRequest(env, id)).toMatchObject({ costMicroCurrency: null, costStatus: "unknown",
      chargedMicroPoints: null, reservedMicroPoints: 4840000 });
  });

  it("records stale dynamic requests as unknown without releasing held points", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10000000 });
    const billing = snapshot();
    const id = await dynamicId(account, billing);
    await recoverStaleRequests(env, billing.startedAt + 600001);
    expect(await getRequest(env, id)).toMatchObject({ state: "review", costMicroCurrency: null,
      costStatus: "unknown", latencyMs: 600001, chargedMicroPoints: null });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 5160000, reservedMicroPoints: 4840000 });
  });

  it("atomically admits only one dynamic request when funds cover one snapshot", async () => {
    const account = await fundedAccount({ availableMicroPoints: 5000000 });
    const result = await Promise.all([reserve(account, dynamic()), reserve(account, dynamic())]);
    expect(result.filter((item) => item.ok)).toHaveLength(1);
    expect(result.filter((item) => !item.ok)).toEqual([{ ok: false, reason: "insufficient_balance" }]);
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 160000, reservedMicroPoints: 4840000 });
  });

  it("leaves legacy rows on the old arithmetic with no fabricated cost metadata", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    expect(await settleRequest(env, id, USAGE)).toEqual({ status: "settled", chargedMicroPoints: 2100 });
    expect(await getRequest(env, id)).not.toHaveProperty("costMicroCurrency");
    expect(await env.DB.prepare("SELECT billing_snapshot, cost_micro_currency, cost_status, latency_ms FROM account_ai_requests WHERE id = ?")
      .bind(id).first()).toEqual({ billing_snapshot: null, cost_micro_currency: null, cost_status: null, latency_ms: null });
  });
});

describe("review and recovery", () => {
  it("surfaces a stale reservation for review without releasing or charging it", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    expect(await markRequestStreaming(env, id)).toBe(true);

    // Too new: the sweep leaves it alone.
    expect(await recoverStaleRequests(env, Date.now(), 100)).toBe(0);
    expect(await recoverStaleRequests(env, Date.now() + 11 * 60 * 1_000, 100)).toBe(1);

    expect(await getRequest(env, id)).toMatchObject({
      state: "review",
      settlementReason: "stale_reservation",
      chargedMicroPoints: null,
    });
    // Money is neither returned nor charged while waiting for an operator.
    expect(await balanceOf(account.userId)).toMatchObject({
      availableMicroPoints: 600,
      reservedMicroPoints: 2_400,
    });
    // Running the sweep again is idempotent.
    expect(await recoverStaleRequests(env, Date.now() + 12 * 60 * 1_000, 100)).toBe(0);
  });

  it("recovers at most one bounded batch per sweep and leaves the rest reserved", async () => {
    const account = await fundedAccount({ availableMicroPoints: 100_000 });
    const stale = Date.now() - 30 * 60 * 1_000;
    await admittedId(account, {}, stale);
    await admittedId(account, {}, stale);

    // The batch ceiling bounds one sweep, not the whole backlog.
    expect(await recoverStaleRequests(env, Date.now(), 1)).toBe(1);
    // The freed execution slot admits another stale reservation.
    await admittedId(account, {}, stale);
    expect(await recoverStaleRequests(env, Date.now(), 100)).toBe(2);

    const states = await env.DB.prepare(
      "SELECT state FROM account_ai_requests WHERE owner_user_id = ?",
    ).bind(account.userId).all<{ state: string }>();
    expect(states.results).toEqual([{ state: "review" }, { state: "review" }, { state: "review" }]);
    // Review keeps every reservation: nothing was charged or refunded.
    expect(await balanceOf(account.userId)).toMatchObject({
      availableMicroPoints: 100_000 - 3 * 2_400,
      reservedMicroPoints: 3 * 2_400,
    });
  });

  it("settles a review manually within the reservation, and never refunds twice", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    await reviewRequest(env, id, "upstream_stream_error");

    const settleOperation = {
      operationId: crypto.randomUUID(),
      operatorUserId: account.operatorUserId,
      ownerUserId: account.userId,
      kind: "settle" as const,
      requestId: id,
      amountMicroPoints: 0,
      reason: "upstream never received it",
    };
    expect(await applyAdjustment(env, settleOperation)).toMatchObject({ status: "applied" });
    expect(await balanceOf(account.userId)).toMatchObject({ availableMicroPoints: 3_000, reservedMicroPoints: 0 });

    // A new operation on the settled request is refused…
    await expect(applyAdjustment(env, { ...settleOperation, operationId: crypto.randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: "request_not_in_review" });
    // …and replaying the first one returns its stored result without moving money.
    expect(await applyAdjustment(env, settleOperation)).toMatchObject({ status: "replayed" });
    expect((await balanceOf(account.userId)).availableMicroPoints).toBe(3_000);
    // Neither the charge nor the released reservation can be rewritten.
    await expect(env.DB.prepare(
      "UPDATE account_ai_requests SET charged_micro_points = 100 WHERE id = ?",
    ).bind(id).run()).rejects.toThrow(/ai_request_immutable/);
  });

  it("refuses a settlement above the reservation and a non-review request", async () => {
    const account = await fundedAccount();
    const id = await admittedId(account);
    const settle = (amountMicroPoints: number) => applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId: account.operatorUserId,
      ownerUserId: account.userId,
      kind: "settle",
      requestId: id,
      amountMicroPoints,
      reason: "checked upstream",
    });
    await expect(settle(0)).rejects.toMatchObject({ status: 409, code: "request_not_in_review" });
    await reviewRequest(env, id, "usage_missing");
    await expect(settle(2_401)).rejects.toMatchObject({ status: 400 });
    expect(await getRequest(env, id)).toMatchObject({ state: "review" });
    expect(await balanceOf(account.userId)).toMatchObject({ reservedMicroPoints: 2_400 });
  });
});

describe("operator adjustments", () => {
  it("credits exactly once per operation id and refuses a conflicting reuse", async () => {
    const operatorUserId = await seedUser("op@example.com");
    const userId = await seedUser("granted@example.com");
    const operation = {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId: userId,
      kind: "grant" as const,
      amountMicroPoints: 1_000,
      reason: "welcome",
    };
    expect(await applyAdjustment(env, operation)).toEqual({
      status: "applied",
      result: { amountMicroPoints: 1_000, kind: "grant", userId },
    });
    expect(await applyAdjustment(env, operation)).toMatchObject({ status: "replayed" });
    expect((await balanceOf(userId)).availableMicroPoints).toBe(1_000);
    // A used operation id names one frozen body: changing any field conflicts.
    await expect(applyAdjustment(env, { ...operation, amountMicroPoints: 5_000 }))
      .rejects.toMatchObject({ status: 409, code: "operation_conflict" });
    expect((await balanceOf(userId)).availableMicroPoints).toBe(1_000);
    // A grant alone does not enable AI: the account is still pending.
    expect(await balanceOf(userId)).toMatchObject({ enabled: false, activatedAt: null });
  });

  it("stamps activation once and keeps it across a disable/enable cycle", async () => {
    const operatorUserId = await seedUser("op2@example.com");
    const userId = await seedUser("cycle@example.com");
    const change = (enabled: boolean, at?: number) => applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId: userId,
      kind: enabled ? "enable" : "disable",
      enabled,
      reason: enabled ? "approved" : "paused",
      ...(at === undefined ? {} : { now: at }),
    });
    await change(true, 1_000);
    expect((await balanceOf(userId)).activatedAt).toBe(1_000);
    await change(false, 2_000);
    expect(await balanceOf(userId)).toMatchObject({ enabled: false, activatedAt: 1_000 });
    await change(true, 3_000);
    expect(await balanceOf(userId)).toMatchObject({ enabled: true, activatedAt: 1_000 });
  });

  it("never invents an account and never overflows the balance", async () => {
    const operatorUserId = await seedUser("op3@example.com");
    await expect(applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId: "no-such-user",
      kind: "grant",
      amountMicroPoints: 1_000,
      reason: "typo",
    })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind("no-such-user").first()).toBeNull();

    const userId = await seedUser("overflow@example.com");
    await applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId: userId,
      kind: "grant",
      amountMicroPoints: Number.MAX_SAFE_INTEGER - 10,
      reason: "large credit",
    });
    await expect(applyAdjustment(env, {
      operationId: crypto.randomUUID(),
      operatorUserId,
      ownerUserId: userId,
      kind: "grant",
      amountMicroPoints: 11,
      reason: "one more",
    })).rejects.toMatchObject({ status: 400, code: "amount_out_of_range" });
    expect((await balanceOf(userId)).availableMicroPoints).toBe(Number.MAX_SAFE_INTEGER - 10);

    // The database refuses a negative balance even for a hand-written update.
    await expect(env.DB.prepare(
      "UPDATE account_ai_balances SET available_micro_points = -1 WHERE owner_user_id = ?",
    ).bind(userId).run()).rejects.toThrow(/CHECK/);
  });

  it("rejects a zero or negative grant and a malformed operation id", async () => {
    const operatorUserId = await seedUser("op4@example.com");
    const userId = await seedUser("zero@example.com");
    for (const amountMicroPoints of [0, -1]) {
      await expect(applyAdjustment(env, {
        operationId: crypto.randomUUID(),
        operatorUserId,
        ownerUserId: userId,
        kind: "grant",
        amountMicroPoints,
        reason: "nothing",
      })).rejects.toMatchObject({ status: 400 });
    }
    await expect(applyAdjustment(env, {
      operationId: "not-a-uuid",
      operatorUserId,
      ownerUserId: userId,
      kind: "enable",
      enabled: true,
      reason: "approved",
    })).rejects.toMatchObject({ status: 400 });
    expect(await getBalance(env, userId)).toBeNull();
  });

  it("keeps the audit trail append-only", async () => {
    const account = await fundedAccount();
    await expect(env.DB.prepare("UPDATE account_ai_adjustments SET reason = 'rewritten'").run())
      .rejects.toThrow(/ai_adjustment_immutable/);
    const rows = await env.DB.prepare(
      "SELECT kind, enabled, amount_micro_points, reason FROM account_ai_adjustments WHERE owner_user_id = ? ORDER BY created_at, kind",
    ).bind(account.userId).all<{
      amount_micro_points: number | null;
      enabled: number | null;
      kind: string;
      reason: string;
    }>();
    expect(rows.results).toEqual([
      { kind: "enable", enabled: 1, amount_micro_points: null, reason: "approved" },
      { kind: "grant", enabled: null, amount_micro_points: 3_000, reason: "welcome credit" },
    ]);
  });
});

describe("ledger", () => {
  it("merges charges and adjustments newest first with a strict cursor", async () => {
    const account = await fundedAccount({ availableMicroPoints: 10_000 });
    // Distinct admission times keep the merge order unambiguous.
    const first = await admittedId(account, {}, 5_000);
    expect(await settleRequest(env, first, USAGE, 5_100)).toMatchObject({ status: "settled" });
    const second = await admittedId(account, {}, 6_000);
    await reviewRequest(env, second, "usage_missing", 6_100);

    const page = await listLedger(env, account.userId, undefined, 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.map((item) => item.kind)).toEqual(["request", "request"]);
    expect(page.items[0]).toMatchObject({ state: "review", reservedMicroPoints: 2_400, model: "m1" });
    expect(page.items[1]).toMatchObject({ state: "settled", chargedMicroPoints: 2_100, outputTokens: 100 });
    // Neither the credential nor any conversation field reaches the ledger.
    expect(page.items.every((item) => !("tokenId" in item) && !("messages" in item))).toBe(true);

    const rest = await listLedger(env, account.userId, page.nextCursor ?? undefined, 2);
    expect(rest.items.map((item) => item.kind)).toEqual(["grant", "enable"]);
    expect(rest.items[0]).toMatchObject({ amountMicroPoints: 10_000, reason: "welcome credit" });
    expect(rest.nextCursor).toBeNull();

    // Walking the whole ledger with a one-item page visits each entry once.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const step: ProductLedgerPage = await listLedger(env, account.userId, cursor, 1);
      expect(step.items.length).toBeLessThanOrEqual(1);
      for (const item of step.items) seen.push(`${item.kind}:${item.id}`);
      if (step.nextCursor === null) break;
      cursor = step.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(4);

    expect(() => decodeLedgerCursor("not-a-cursor")).toThrow(HTTPError);
    expect(() => decodeLedgerCursor("")).toThrow(HTTPError);
    const missingTime = Buffer.from(JSON.stringify({ id: "x" })).toString("base64url");
    expect(() => decodeLedgerCursor(missingTime)).toThrow(HTTPError);
    const negativeTime = Buffer.from(JSON.stringify({ createdAt: -1, id: "x" })).toString("base64url");
    expect(() => decodeLedgerCursor(negativeTime)).toThrow(HTTPError);
    await expect(listLedger(env, account.userId, "%%%")).rejects.toMatchObject({ status: 400 });
  });

  it("never shows one account's ledger to another", async () => {
    await fundedAccount();
    const stranger = await seedUser("stranger@example.com");
    expect(await listLedger(env, stranger)).toEqual({ items: [], nextCursor: null });
    expect(await getBalance(env, stranger)).toBeNull();
    expect(await getRequest(env, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
