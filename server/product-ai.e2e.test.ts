// The account's AI through the real OpenAI-compatible driver and registry, against a local gateway that speaks the
// gateway's two OpenAI routes. Nothing here is a mock of the runtime: a stub upstream records what actually crossed the
// wire, and a real MCP server proves a tool round is a second metered request on the account's own token.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import {
  PRODUCT_AI_INSTANCE_ID,
  PRODUCT_AI_EXPIRED_MESSAGE,
  PRODUCT_AI_MODEL_MESSAGE,
  PRODUCT_AI_SUSPENDED_MESSAGE,
  ProductAiProviders,
} from "./product-ai.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { recordEvents } from "./testing/events.ts";

const TOKEN = `omb_product_ai_${"a".repeat(22)}.${"b".repeat(43)}`;
const NEXT_TOKEN = `omb_product_ai_${"c".repeat(22)}.${"d".repeat(43)}`;
const PERSONAL_KEY = "sk-personal-must-never-be-used";

const usage = { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } };
type Call = { path: string; authorization: string | undefined; body: Record<string, unknown> };
type Route = (call: Call, response: ServerResponse) => void;

/** An SSE body of one chat reply; `finish` last, as the gateway itself streams it. */
function chatText(response: ServerResponse, text: string, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}
function chatToolCall(response: ServerResponse, name: string, args: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: args } }] } }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}
/** The Responses route's frames, including the terminal usage the gateway settles on. */
function responsesText(response: ServerResponse, text: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (value: unknown) => response.write(`event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`);
  frame({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } });
  frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text, logprobs: [] });
  frame({ type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } });
  frame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
  response.end();
}
function gatewayError(response: ServerResponse, status: number, code: string, message: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code, message, type: status === 402 ? "insufficient_quota" : "invalid_request_error" } }));
}

async function listen(handler: (call: Call, response: ServerResponse) => void) {
  const calls: Call[] = [];
  const server: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const call: Call = { path: new URL(req.url ?? "/", "http://fixture").pathname, authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
    calls.push(call);
    handler(call, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const model = (id: string, protocol: "chat" | "responses" = "chat", over: Record<string, unknown> = {}) => ({
  id, label: id === "maus-default" ? "MausBot" : id, protocol, pricingVersion: "v1",
  inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1_000, maxOutputTokens: 100, ...over,
});

interface Harness {
  origin: string;
  calls: Call[];
  provider: ProductAiProviders;
  instance: ProviderInstance;
  events: RuntimeEvent[];
  registry: ProviderRegistry;
  close(): Promise<void>;
}

const harnesses: Harness[] = [], mcps: FakeHttpMcp[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  for (const mcp of mcps.splice(0)) await mcp.close();
  for (const close of closers.splice(0)) await close();
});

async function launchHarness(options: {
  route: Route;
  models?: ReturnType<typeof model>[];
  defaultModel?: string;
  now?: () => number;
}): Promise<Harness> {
  const upstream = await listen(options.route);
  closers.push(upstream.close);
  const registry = new ProviderRegistry([OpenAICompatDriver], { npmAvailable: () => false });
  const provider = new ProductAiProviders({ registry, now: options.now ?? (() => Date.now()), allowLoopbackOrigin: true });
  const models = options.models ?? [model("maus-default")];
  await provider.apply({
    state: "ready",
    connection: {
      origin: upstream.origin, userId: "user-1", tokenId: "token-1", token: TOKEN,
      expiresAt: (options.now ?? (() => Date.now()))() + 15 * 60_000,
      defaultModel: options.defaultModel ?? models[0]!.id, models,
    },
  });
  const instance = registry.get(PRODUCT_AI_INSTANCE_ID);
  if (!instance) throw new Error("the account engine did not load");
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  const launched: Harness = {
    origin: upstream.origin, calls: upstream.calls, provider, instance, events, registry,
    close: async () => { await provider.close(); await registry.disposeAll(); },
  };
  harnesses.push(launched);
  return launched;
}

const settle = (event: RuntimeEvent | undefined) => event !== undefined;

describe("the account engine over the real driver and registry", () => {
  it("runs a chat turn on the gateway with the account token only, never the workspace's personal key", async () => {
    process.env.OPENAI_COMPAT_API_KEY = PERSONAL_KEY;
    try {
      const harness = await launchHarness({
        route: (call, response) => call.path.endsWith("/models")
          ? (response.writeHead(200, { "content-type": "application/json" }), response.end(JSON.stringify({ data: [] })))
          : chatText(response, "Hello from your account."),
      });
      const turns = recordEvents(harness.instance.adapter);
      await harness.instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
      const completed = await turns.until(event => event.type === "turn.completed");
      expect(completed).toMatchObject({ type: "turn.completed", ok: true });
      expect(turns.events.filter(event => event.type === "item.completed").map(event => (event as { text?: string }).text))
        .toContain("Hello from your account.");
      const chat = harness.calls.filter(call => call.path === "/v1/ai/chat/completions");
      expect(chat).toHaveLength(1);
      expect(chat[0]!.authorization).toBe(`Bearer ${TOKEN}`);
      expect(chat[0]!.body).toMatchObject({ model: "maus-default", stream: true });
      expect(chat[0]!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "hello" })]));
      // Nothing crossed the wire with the workspace key, in any header or body.
      expect(JSON.stringify(harness.calls)).not.toContain(PERSONAL_KEY);
      expect(harness.events.some(event => event.type === "runtime.error")).toBe(false);
      // The engine's own catalog is the account's, so a picker cannot offer another engine's models.
      expect(harness.instance.models.options.map(option => option.id)).toEqual(["maus-default"]);
    } finally { delete process.env.OPENAI_COMPAT_API_KEY; }
  });

  it("sends a tool round as a second metered request, then finishes the same turn", async () => {
    const mcp = await startFakeHttpMcp({
      tools: [{ name: "write", description: "Write the fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
      callResult: () => ({ content: [{ type: "text", text: "written" }] }),
    });
    mcps.push(mcp);
    let round = 0;
    const harness = await launchHarness({
      route: (call, response) => {
        // The engine probes a loopback host it was pointed at (Ollama's /api/version): answer 404, not a completion.
        if (!call.path.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
        round += 1;
        if (round === 1) chatToolCall(response, "notes_write", JSON.stringify({ value: "verified" }));
        else chatText(response, "The note is written.");
      },
    });
    const turns = recordEvents(harness.instance.adapter);
    await harness.instance.adapter.sendTurn({
      threadId: "tool-thread", text: "Write the note.", approvalMode: "full",
      toolScope: { allow: ["mcp:notes:write"] },
      integrations: { custom: { notes: { type: "http", url: mcp.url, headers: {} } } },
    });
    await turns.until(event => event.type === "turn.completed", 20_000);
    const chat = harness.calls.filter(call => call.path === "/v1/ai/chat/completions");
    expect(chat).toHaveLength(2);
    expect(chat.map(call => call.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect((chat[0]!.body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toContain("notes_write");
    // The tool result went back to the model on the second request, and the tool really ran.
    expect(JSON.stringify(chat[1]!.body.messages)).toContain("written");
    expect(mcp.calls).toHaveLength(1);
    expect(turns.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  }, 30_000);

  it("keeps a pinned Responses model on the Responses route, for a turn and for a helper call", async () => {
    const harness = await launchHarness({
      route: (call, response) => call.path.endsWith("/models")
        ? (response.writeHead(200), response.end("{}"))
        : responsesText(response, call.path === "/v1/ai/responses" ? "Answered on Responses." : "wrong route"),
      models: [model("maus-pro", "responses")],
    });
    const turns = recordEvents(harness.instance.adapter);
    await harness.instance.adapter.sendTurn({ threadId: "pinned", text: "hello" });
    await turns.until(event => event.type === "turn.completed");
    expect(harness.calls.filter(call => call.path === "/v1/ai/responses").length).toBeGreaterThan(0);
    expect(harness.calls.filter(call => call.path === "/v1/ai/chat/completions")).toHaveLength(0);
    const before = harness.calls.length;
    await expect(harness.instance.generateText!("summarize")).resolves.toBe("Answered on Responses.");
    const helper = harness.calls.slice(before);
    expect(helper.every(call => call.path === "/v1/ai/responses" || call.path.endsWith("/models"))).toBe(true);
    expect(helper.filter(call => call.path === "/v1/ai/responses")).toHaveLength(1);
    expect(helper[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("uses the rotated token on the next request without replacing the engine", async () => {
    const harness = await launchHarness({
      route: (call, response) => call.path.endsWith("/models")
        ? (response.writeHead(200), response.end("{}"))
        : chatText(response, "ok"),
    });
    const turns = recordEvents(harness.instance.adapter);
    await harness.instance.adapter.sendTurn({ threadId: "rotate", text: "first" });
    await turns.until(event => event.type === "turn.completed");
    await harness.provider.apply({
      state: "ready",
      connection: {
        origin: harness.origin, userId: "user-1", tokenId: "token-2", token: NEXT_TOKEN,
        expiresAt: Date.now() + 15 * 60_000, defaultModel: "maus-default", models: [model("maus-default")],
      },
    });
    expect(harness.registry.get(PRODUCT_AI_INSTANCE_ID)).toBe(harness.instance);
    const after = recordEvents(harness.instance.adapter);
    await harness.instance.adapter.sendTurn({ threadId: "rotate", text: "second" });
    await after.until(event => event.type === "turn.completed");
    const chat = harness.calls.filter(call => call.path === "/v1/ai/chat/completions");
    expect(chat.map(call => call.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT_TOKEN}`]);
    // Accepted work finished; the renewal itself never interrupted it.
    expect(harness.events.some(event => event.type === "runtime.error")).toBe(false);
  });

  it("refuses an unlisted model and an expired session before any request leaves", async () => {
    let now = 1_800_000_000_000;
    const harness = await launchHarness({
      now: () => now,
      route: (call, response) => call.path.endsWith("/models")
        ? (response.writeHead(200), response.end("{}"))
        : chatText(response, "ok"),
    });
    await expect(harness.instance.adapter.sendTurn({ threadId: "refused", text: "hi", model: "gpt-personal" }))
      .rejects.toThrow(PRODUCT_AI_MODEL_MESSAGE);
    expect(harness.calls).toHaveLength(0);
    now += 15 * 60_000;
    const turns = recordEvents(harness.instance.adapter);
    await expect(harness.instance.adapter.sendTurn({ threadId: "refused", text: "late" })).rejects.toThrow(PRODUCT_AI_EXPIRED_MESSAGE);
    expect(harness.calls).toHaveLength(0);
    expect(turns.events).toEqual([]);
    expect(harness.provider.status()).toBe("unavailable");
    await expect(harness.instance.generateText!("helper")).rejects.toThrow(PRODUCT_AI_EXPIRED_MESSAGE);
    expect(harness.calls).toHaveLength(0);
  });

  it("surfaces the gateway's balance refusal as the turn's error, without another attempt or another key", async () => {
    const harness = await launchHarness({
      route: (call, response) => call.path.endsWith("/models")
        ? (response.writeHead(200), response.end("{}"))
        : gatewayError(response, 402, "insufficient_balance", "Available points cannot cover another request."),
    });
    const turns = recordEvents(harness.instance.adapter);
    await harness.instance.adapter.sendTurn({ threadId: "broke", text: "hello" });
    const error = await turns.until(event => event.type === "runtime.error");
    expect((error as { message: string }).message).toContain("Available points cannot cover another request.");
    expect((error as { message: string }).message).toContain("insufficient_balance");
    await turns.until(event => event.type === "turn.completed");
    const chat = harness.calls.filter(call => call.path === "/v1/ai/chat/completions");
    expect(chat).toHaveLength(1);
    expect(chat[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("answers a revoked capability with a fence before its engine can be reused", async () => {
    const harness = await launchHarness({
      route: (call, response) => call.path.endsWith("/models")
        ? (response.writeHead(200), response.end("{}"))
        : chatText(response, "ok"),
    });
    await harness.provider.apply({ state: "suspended", connection: null });
    expect(harness.registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();
    await expect(harness.instance.adapter.sendTurn({ threadId: "gone", text: "hi" })).rejects.toThrow(PRODUCT_AI_SUSPENDED_MESSAGE);
    expect(harness.calls).toHaveLength(0);
    expect(settle(harness.events.find(event => event.type === "runtime.error"))).toBe(false);
  });
});
