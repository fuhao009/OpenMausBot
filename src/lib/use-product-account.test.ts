import { describe, expect, it } from "vitest";
import type { ProductLedgerEntry } from "../../shared/product-account";
import { formatPointsMicros, productAccountNotice, productLedgerLine } from "./use-product-account";

const entry = (over: Partial<ProductLedgerEntry> = {}): ProductLedgerEntry => ({
  id: "req_1", kind: "request", createdAt: Date.UTC(2026, 10, 4, 9, 30), model: "hezuo-1",
  state: "settled", chargedMicroPoints: 2100, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, ...over,
});

const ai = {
  state: "ready" as const,
  unit: "points" as const,
  availableMicroPoints: 3_000_000,
  reservedMicroPoints: 2_400,
  defaultModel: "hezuo-1",
  models: [],
};

describe("a managed account's points", () => {
  it("prints micro-points exactly, so a real charge never reads as zero and no float rounds it", () => {
    expect(formatPointsMicros(2_100)).toBe("0.002100");
    expect(formatPointsMicros(1)).toBe("0.000001");
    expect(formatPointsMicros(0)).toBe("0.000000");
    expect(formatPointsMicros(1_000_000)).toBe("1.000000");
    expect(formatPointsMicros(12_345_678_901)).toBe("12345.678901");
    // Points are the product's own unit: no currency sign appears anywhere.
    expect(formatPointsMicros(2_100)).not.toContain("$");
    // Anything the gateway could not have charged is not shown as a charge.
    expect(formatPointsMicros(-1)).toBe("0.000000");
    expect(formatPointsMicros(1.5)).toBe("0.000000");
    expect(formatPointsMicros(Number.MAX_SAFE_INTEGER + 2)).toBe("0.000000");
  });

  it("names runtime trouble and service trouble differently", () => {
    expect(productAccountNotice({ auth: "signed_in", runtime: "error", errorCode: "workspace_start_failed" }))
      .toEqual({ tone: "error", key: "product.runtimeError" });
    expect(productAccountNotice({ auth: "unavailable", runtime: "stopped", errorCode: "network_unavailable" }))
      .toEqual({ tone: "error", key: "product.serviceUnavailable" });
    expect(productAccountNotice({ auth: "signed_in", runtime: "ready", ai: { ...ai, state: "insufficient_balance" } }))
      .toEqual({ tone: "warning", key: "product.insufficient_balance" });
    expect(productAccountNotice({ auth: "signed_in", runtime: "ready", ai }))
      .toEqual({ tone: "success", key: "product.ready" });
    expect(productAccountNotice({ auth: "signed_in", runtime: "starting" })).toEqual({ tone: "info", key: "product.starting" });
    // An account still loading is not a failure, and a stopped one says how to start it again.
    expect(productAccountNotice({ auth: "signed_in", runtime: "stopped" })).toEqual({ tone: "info", key: "product.runtimeStopped" });
    expect(productAccountNotice({ auth: "signed_out", runtime: "stopped" })).toBeNull();
  });

  it("reads one ledger entry as a person would", () => {
    const settled = productLedgerLine(entry(), "en");
    expect(settled.amount).toBe("Charged 0.002100 points");
    expect(settled.state).toEqual({ label: "Settled", review: false });

    // A request awaiting review holds its amount; it is not shown as a charge.
    const review = productLedgerLine(entry({ state: "review", chargedMicroPoints: undefined, reservedMicroPoints: 2400 }), "en");
    expect(review.amount).toBe("Held 0.002400 points");
    expect(review.state).toEqual({ label: "Awaiting review", review: true });

    const grant = productLedgerLine({ id: "a", kind: "grant", createdAt: 1, amountMicroPoints: 10_000_000 }, "en");
    expect(grant).toMatchObject({ title: "Points added", amount: "Granted 10.000000 points", state: null });

    const disable = productLedgerLine({ id: "b", kind: "disable", createdAt: Date.UTC(2026, 10, 4, 9, 30) }, "en");
    expect(disable).toMatchObject({ title: "AI access disabled", amount: null, detail: null });
    expect(disable.at).not.toBe("");
    // A missing or unusable timestamp shows no time rather than 1970.
    expect(productLedgerLine({ id: "c", kind: "disable", createdAt: 0 }, "en").at).toBe("");
  });
});
