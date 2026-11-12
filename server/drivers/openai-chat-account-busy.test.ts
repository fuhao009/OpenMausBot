import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const busy = () => new Response(JSON.stringify({ error: { message: "Too many requests are in flight for this account.", code: "ai_busy" } }), {
  status: 429, headers: { "content-type": "application/json" },
});
const limited = () => new Response(JSON.stringify({ error: { message: "Slow down.", code: "rate_limited" } }), {
  status: 429, headers: { "content-type": "application/json" },
});
const completion = () => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const sseText = (...chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const GATEWAY_FAILURE = { error: { code: "upstream_error", message: "The upstream request failed.", type: "upstream_error" } };
const streamFailure = () => sseText(GATEWAY_FAILURE);
const failureAfterText = () => sseText({ choices: [{ delta: { content: "par" } }] }, GATEWAY_FAILURE);
const plain = () => new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
  status: 200, headers: { "content-type": "application/json" },
});

let requests = 0;
function serve(answers: Array<() => Response>) {
  requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    if (!String(url).endsWith("/chat/completions")) return new Response("", { status: 404 });
    const answer = answers[Math.min(requests, answers.length - 1)]!;
    requests++;
    return answer();
  }));
}

async function start(accountSlotWaitMs?: number, upstreamStreamRetries?: number) {
  const instance = await OpenAICompatDriver.create({
    instanceId: "gateway", displayName: "Gateway", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://gateway.example.test/v1/ai", apiKeyEnv: "GATEWAY_KEY", model: "m", ...(accountSlotWaitMs ? { accountSlotWaitMs } : {}), ...(upstreamStreamRetries ? { upstreamStreamRetries } : {}) }),
    environment: { GATEWAY_KEY: "secret" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  return { instance, events };
}
const finished = (events: RuntimeEvent[]) => events.find((event) => event.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }> | undefined;
const retries = (events: RuntimeEvent[]) => events.filter((event): event is Extract<RuntimeEvent, { type: "turn.retrying" }> => event.type === "turn.retrying");
const settle = async (events: RuntimeEvent[], limitMs = 120_000) => {
  for (let waited = 0; !finished(events) && waited < limitMs; waited += 500) await vi.advanceTimersByTimeAsync(500);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a gateway that admits only a few requests per account", () => {
  it("waits for a free slot and sends the same request again until it is taken", async () => {
    serve([busy, busy, completion]);
    const { instance, events } = await start(600_000);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(finished(events)).toMatchObject({ ok: true });
    expect(requests).toBe(3);
    expect(retries(events).map((event) => [event.attempt, event.reason])).toEqual([[1, "account_busy"], [2, "account_busy"]]);
    expect(retries(events).every((event) => event.delayMs >= 1_000 && event.delayMs <= 8_000 * 1.25)).toBe(true);
    await instance.dispose();
  });

  it("fails on the first refusal when no wait was asked for", async () => {
    serve([busy, completion]);
    const { instance, events } = await start();
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBe(1);
    expect(retries(events)).toEqual([]);
    expect(events.some((event) => event.type === "runtime.error" && /ai_busy/.test(JSON.stringify(event)))).toBe(true);
    await instance.dispose();
  });

  it("stops waiting when the turn is stopped, and sends nothing more", async () => {
    serve([busy]);
    const { instance, events } = await start(600_000);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await vi.advanceTimersByTimeAsync(100);
    expect(retries(events)).toHaveLength(1);
    await instance.adapter.interruptTurn("thread");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toBe(1);
    expect(retries(events)).toHaveLength(1);
    await instance.dispose();
  });

  it("gives up with the refusal once it has waited as long as it was allowed", async () => {
    serve([busy]);
    const { instance, events } = await start(5_000);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBeGreaterThan(1);
    expect(retries(events).reduce((total, event) => total + event.delayMs, 0)).toBeLessThanOrEqual(5_000);
    expect(events.some((event) => event.type === "runtime.error" && /ai_busy/.test(JSON.stringify(event)))).toBe(true);
    await instance.dispose();
  });

  it("leaves any other rate limit to the usual handling", async () => {
    serve([limited, completion]);
    const { instance, events } = await start(600_000);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBe(1);
    expect(retries(events)).toEqual([]);
    await instance.dispose();
  });

  it("waits the same way for a helper's text, such as a title", async () => {
    serve([busy, plain]);
    const { instance } = await start(600_000);
    const text = instance.generateText!("title please");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(text).resolves.toBe("done");
    expect(requests).toBe(2);
    await instance.dispose();
  });
});

describe("a gateway whose upstream stream fails before any of the reply arrived", () => {
  it("asks again, saying why, and the turn completes", async () => {
    serve([streamFailure, completion]);
    const { instance, events } = await start(undefined, 2);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(finished(events)).toMatchObject({ ok: true });
    expect(requests).toBe(2);
    expect(retries(events).map((event) => [event.attempt, event.reason])).toEqual([[1, "upstream_stream"]]);
    expect(retries(events)[0]!.delayMs).toBeGreaterThanOrEqual(1_500);
    await instance.dispose();
  });

  it("gives up with the gateway's own message after the attempts it was given", async () => {
    serve([streamFailure]);
    const { instance, events } = await start(undefined, 2);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBe(3);
    expect(retries(events).map((event) => event.reason)).toEqual(["upstream_stream", "upstream_stream"]);
    expect(events.some((event) => event.type === "runtime.error" && /The upstream request failed/.test(JSON.stringify(event)))).toBe(true);
    await instance.dispose();
  });

  it("does not ask again once part of the reply has streamed", async () => {
    serve([failureAfterText, completion]);
    const { instance, events } = await start(undefined, 2);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBe(1);
    expect(retries(events)).toEqual([]);
    await instance.dispose();
  });

  it("does nothing of the kind when it was not asked to", async () => {
    serve([streamFailure, completion]);
    const { instance, events } = await start();
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await settle(events);
    expect(requests).toBe(1);
    expect(retries(events)).toEqual([]);
    await instance.dispose();
  });

  it("stops waiting when the turn is stopped, and sends nothing more", async () => {
    serve([streamFailure]);
    const { instance, events } = await start(undefined, 2);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    await vi.advanceTimersByTimeAsync(100);
    expect(retries(events)).toHaveLength(1);
    await instance.adapter.interruptTurn("thread");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toBe(1);
    await instance.dispose();
  });
});
