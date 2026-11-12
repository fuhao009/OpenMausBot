// Product mode's helper models: decisions and extraction run on the account's own model through the registered
// `product-ai` provider (one callback), never through a helper module's own fetch, URL or key. No live calls.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider, deciderReady, describeDecider, setProductHelperMode, setProductHelperState } from "./index.ts";
import { createExtractor, describeExtractor, extractorReady } from "../extractor/index.ts";
import { describeHelpers } from "../extractor/index.ts";
import { KEY_CHECK_QUESTION } from "./relay.ts";

const PRODUCT_CONFIG: AppConfig = { decider: { provider: "off" } };
const UNCONFIGURED: AppConfig = {};
const STATE = { new_message: { from: "Sam", text: "Which bot should answer?" } };
const QUESTION = { instructions: "Which bot should answer?", options: { a: "First bot.", b: "Second bot." } };
const CHOICE = { answers: { answer: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 } } } };

afterEach(() => {
  setProductHelperState(null);
  setProductHelperMode(false);
});

function install(answer: string | Error) {
  const prompts: string[] = [];
  const helper = {
    generateText: async (prompt: string) => {
      prompts.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  setProductHelperMode(true);
  setProductHelperState(helper);
  return prompts;
}

describe("product mode helpers", () => {
  it("decides on the account's model, with the same prompt shape and parser as the OpenRouter chat backend", async () => {
    const prompts = install(JSON.stringify(CHOICE));
    const result = await createDecider({ config: () => UNCONFIGURED, fetch: vi.fn() as unknown as typeof fetch }).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "product", answers: { choice: "a", pTop: 0.9 } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You are a fast classifier inside an application");
    expect(prompts[0]).toContain("new_message");
    expect(deciderReady(UNCONFIGURED, "roomRouting")).toBe(true);
    expect(describeDecider(UNCONFIGURED)).toMatchObject({ provider: "product", product: true, configured: true, enabled: true });
  });

  it("reads a fenced JSON answer the way a chat model often writes it", async () => {
    install("```json\n" + JSON.stringify({ answers: { answer: { noul: 0.93 } } }) + "\n```");
    const result = await createDecider({ config: () => UNCONFIGURED }).yesNo("roomRouting", STATE, "Is it?");
    expect(result).toMatchObject({ ok: true, provider: "product", answers: { p: 0.93 } });
  });

  it("extracts with the shared parser and reports the managed provider", async () => {
    const prompts = install(JSON.stringify({ values: { total: 12.5, paid: true } }));
    const result = await createExtractor({ config: () => UNCONFIGURED }).extract(
      "botExtract",
      { total: { type: "number" }, paid: { type: "boolean" } },
      { text: "Invoice total 12.50, paid." },
    );
    expect(result).toMatchObject({ ok: true, provider: "product", values: { total: 12.5, paid: true } });
    expect(prompts[0]).toContain("Invoice total 12.50");
    expect(extractorReady(UNCONFIGURED)).toBe(true);
    expect(describeExtractor(UNCONFIGURED)).toMatchObject({ provider: "product", product: true, ready: true });
    expect(describeHelpers(UNCONFIGURED).extraction).toMatchObject({ provider: "product", product: true, ready: true });
  });

  it("never sends an image to a text helper: it refuses rather than answering from text alone", async () => {
    const prompts = install(JSON.stringify({ values: { caption: "ignored" } }));
    const result = await createExtractor({ config: () => UNCONFIGURED }).extract(
      "botExtract",
      { caption: { type: "string" } },
      { images: [{ mime: "image/png", data: "aGVsbG8=" }] },
    );
    expect(result).toMatchObject({ ok: false, reason: "misconfigured" });
    expect(prompts).toEqual([]);
  });

  it("never falls back to a local key, the included relay or the OpenRouter fallback", async () => {
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", "https://cloud.example.test/api/cloud/services/decider");
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "omb_decide_included_token_0123456789");
    const fetchImpl = vi.fn<typeof fetch>();
    const local: AppConfig = {
      openrouter: { key: "sk-or-v1-shared" },
      decider: { enabled: true, key: "tsk_local_jev_key", workersAiToken: "cf_local_token", workersAiAccountId: "0123456789abcdef0123456789abcdef", openrouterKey: "sk-or-v1-local" },
    };
    setProductHelperMode(true);
    const refused = await createDecider({ config: () => local, fetch: fetchImpl as unknown as typeof fetch }).choose("roomRouting", STATE, QUESTION);
    expect(refused).toMatchObject({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deciderReady(local, "roomRouting")).toBe(false);
    expect(describeDecider(local)).toMatchObject({ configured: false });
    const extracted = await createExtractor({ config: () => local, fetch: fetchImpl as unknown as typeof fetch }).extract(
      "botExtract", { total: { type: "number" } }, { text: "total 3" },
    );
    expect(extracted).toMatchObject({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("maps a refused account call to a fixed reason, never the vendor body", async () => {
    install(new Error("upstream HTTP 402: insufficient balance"));
    const result = await createDecider({ config: () => UNCONFIGURED }).choose("roomRouting", STATE, QUESTION);
    expect(result).toEqual({ ok: false, provider: "product", reason: "no_balance", latencyMs: expect.any(Number) });
    install(new Error("The account's AI access is suspended."));
    expect(await createDecider({ config: () => UNCONFIGURED }).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "rejected" });
    install(new Error("ai_unavailable"));
    expect(await createDecider({ config: () => UNCONFIGURED }).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "unreachable" });
    install(new Error("ai_busy"));
    expect(await createDecider({ config: () => UNCONFIGURED }).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("keeps the person's own switch: helpers off in config stay off", async () => {
    const prompts = install(JSON.stringify(CHOICE));
    const off: AppConfig = { decider: { enabled: false } };
    expect(await createDecider({ config: () => off }).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "disabled" });
    expect(await createDecider({ config: () => PRODUCT_CONFIG }).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "disabled" });
    expect(prompts).toEqual([]);
  });

  it("checks the account's model for the Settings Test button, without a local key", async () => {
    install(JSON.stringify({ answers: { answer: { noul: 0.98 } } }));
    const result = await createDecider({ config: () => UNCONFIGURED }).testKey();
    expect(result).toMatchObject({ ok: true, provider: "product" });
    expect(KEY_CHECK_QUESTION.length).toBeGreaterThan(0);
  });
});
