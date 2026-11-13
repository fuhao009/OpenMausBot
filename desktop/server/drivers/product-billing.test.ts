import { describe, expect, it, vi } from "vitest";
import { billedFetch, turnBudget } from "./product-billing.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const error = (code: string, status: number) => json({ error: { code } }, status);
const init = { method: "POST", body: JSON.stringify({ model: "auto-responses", input: "hello" }) };
const url = "https://fixture.invalid/v1/ai/responses";
const credential = () => ({ apiKey: "fixture", expiresAt: Date.now() + 60000, billing: { availableMicroPoints: 80_000_000, quoteProtocols: ["responses" as const], fallbackModels: [{ id: "explicit", protocol: "responses" as const }] } });

describe("managed request billing", () => {
  it("bounds default authorization by balance and the named per-turn cap", () => {
    expect(turnBudget(80_000_000)).toBe(50_000_000);
    expect(turnBudget(12)).toBe(12);
    expect(turnBudget(80_000_000, true)).toBe(80_000_000);
  });
  it("sends a fixed model directly with its budget when the catalog advertises no automatic model", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const fixed = { ...init, body: JSON.stringify({ model: "explicit", input: "hello" }) };
    await billedFetch(send, url, fixed, () => ({ ...credential(), billing: { availableMicroPoints: 80_000_000 } }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(url);
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ model: "explicit", input: "hello", billing: { maxMicroPoints: 50_000_000 } });
  });
  it("quotes the complete request before dispatch and includes the budget", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ selectedModel: "explicit" })).mockResolvedValueOnce(json({}));
    await billedFetch(send, url, init, credential);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe("https://fixture.invalid/v1/ai/quote");
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ endpoint: "responses", request: { model: "auto-responses", input: "hello", billing: { maxMicroPoints: 50_000_000 } } });
  });
  it("never resends a 402 without explicit user confirmation", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(error("budget_exceeded", 402));
    const confirm = vi.fn(async () => false);
    await expect(billedFetch(send, url, init, credential, confirm)).rejects.toThrow("product_budget_exceeded:50");
    expect(send).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("raises authorization to available balance only when confirmed", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(error("budget_exceeded", 402)).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}));
    await billedFetch(send, url, init, credential, async () => true);
    expect(JSON.parse(String(send.mock.calls[2]![1]!.body)).billing.maxMicroPoints).toBe(80_000_000);
  });
  it("falls back only for dynamic billing disabled, before an upstream dispatch", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(error("dynamic_billing_disabled", 503)).mockResolvedValueOnce(json({}));
    await billedFetch(send, url, init, credential);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(send.mock.calls[1]![1]!.body)).model).toBe("explicit");
  });
  it.each([502, 503])("does not replay an ambiguous HTTP %s", async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(error("upstream_error", status));
    expect((await billedFetch(send, url, init, credential)).status).toBe(status);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("never replays an inference response even when its code is dynamic_billing_disabled", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(error("dynamic_billing_disabled", 503));
    expect((await billedFetch(send, url, init, credential)).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("renews an invalid token once and re-reads the credential", async () => {
    const renewToken = vi.fn(async () => true);
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(error("ai_token_invalid", 401)).mockResolvedValueOnce(error("ai_token_invalid", 401));
    const current = () => ({ ...credential(), billing: { ...credential().billing, renewToken } });
    await expect(billedFetch(send, url, init, current)).rejects.toThrow("product_ai_session_expired");
    expect(renewToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("reports zero balance without even quoting", async () => {
    const send = vi.fn<typeof fetch>();
    await expect(billedFetch(send, url, init, () => ({ ...credential(), billing: { availableMicroPoints: 0 } }))).rejects.toThrow("product_insufficient_balance:0");
    expect(send).not.toHaveBeenCalled();
  });
});
