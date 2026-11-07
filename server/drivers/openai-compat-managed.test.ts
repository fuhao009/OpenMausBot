// A managed account's model credential is read per request, never stored; an operator's pinned protocol is the only paid
// route a model may use. Real loopback HTTP, no fetch stub, so headers and paths are the ones a gateway would receive.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { createModelRoutes } from "./openai-responses.ts";

interface Call { path: string; authorization: string | undefined; body: Record<string, any> }
type Reply = (call: Call, response: ServerResponse, nth: number) => void;

const MCP_SCRIPT = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: [{ name: "tool", description: "Fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  else if (request.method === "tools/call") reply(request.id, { content: [{ type: "text", text: "Stored." }] });
  else if (request.id !== undefined && request.method === "ping") reply(request.id, {});
});
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

const chatText = (text: string): Reply => (_call, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
};
/** A one-off call asks for a whole JSON body, not a stream. */
const chatOnce = (text: string): Reply => (_call, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ model: "product-model", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
};
const chatToolCall: Reply = (call, response) => {
  if (call.path.endsWith("/responses")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "fixture_tool", arguments: "{}", status: "completed" } })}\n\n`);
    response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 9, output_tokens: 2 } } })}\n\n`);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "fixture_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
};
const responsesText = (text: string): Reply => (_call, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text })}\n\n`);
  response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`);
  response.end();
};

async function upstream(reply: Reply) {
  const calls: Call[] = [];
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    let data = "";
    for await (const part of request) data += part.toString();
    const call: Call = { path: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(data) as Record<string, any> };
    calls.push(call);
    reply(call, response, calls.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}/v1`, calls };
}

function toolIntegrations(): SendTurnInput["integrations"] {
  const dir = mkdtempSync(join(tmpdir(), "omb-managed-driver-"));
  const script = join(dir, "mcp.mjs");
  writeFileSync(script, MCP_SCRIPT);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { custom: { fixture: { command: process.execPath, args: [script], env: {} } } };
}

async function managed(input: {
  url: string;
  credential: () => { apiKey: string; expiresAt: number };
  modelProtocols?: Record<string, "chat" | "responses">;
  environment?: Record<string, string>;
}) {
  const instance = await OpenAICompatDriver.create({
    instanceId: "product-ai", displayName: "Product", enabled: true,
    environment: input.environment ?? {},
    config: OpenAICompatDriver.decodeConfig({
      url: input.url, apiKeyEnv: "OPENMAUSBOT_PRODUCT_AI_TOKEN", provider: "", model: "product-model",
      ...(input.modelProtocols ? { modelProtocols: input.modelProtocols } : {}),
    }),
    requestCredential: input.credential,
  });
  cleanups.push(async () => { await instance.dispose(); });
  return instance;
}

async function completedTurn(instance: ProviderInstance, text: string, integrations?: SendTurnInput["integrations"]) {
  const recorder = recordEvents(instance.adapter);
  cleanups.push(() => recorder.stop());
  await instance.adapter.sendTurn({ threadId: `fixture-${Math.random()}`, text, approvalMode: "full", ...(integrations ? { integrations } : {}) });
  await recorder.until((event) => event.type === "turn.completed");
  return recorder.events;
}

describe("a managed credential is read per request", () => {
  it("reads the getter again for the next round, so a rotated token is used by that request", async () => {
    let issued = "before-renewal";
    const f = await upstream((call, response, nth) => {
      if (nth === 1) {
        issued = "after-renewal";
        chatToolCall(call, response, nth);
        return;
      }
      chatText("Done.")(call, response, nth);
    });
    const instance = await managed({ url: f.url, credential: () => ({ apiKey: issued, expiresAt: Date.now() + 60_000 }) });
    const events = await completedTurn(instance, "Use the tool", toolIntegrations());
    expect(f.calls.map((call) => call.authorization)).toEqual(["Bearer before-renewal", "Bearer after-renewal"]);
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
  }, 20_000);

  it("reads the getter for every one-off helper call", async () => {
    const tokens = ["helper-one", "helper-two"];
    const f = await upstream(chatOnce("helper result"));
    const instance = await managed({ url: f.url, credential: () => ({ apiKey: tokens.shift() ?? "exhausted", expiresAt: Date.now() + 60_000 }) });
    await expect(instance.generateText!("first", { model: "product-model" })).resolves.toBe("helper result");
    await expect(instance.generateText!("second", { model: "product-model" })).resolves.toBe("helper result");
    expect(f.calls.map((call) => call.authorization)).toEqual(["Bearer helper-one", "Bearer helper-two"]);
  });

  it("refuses a turn on the getter's own words, without a request and without falling back to an environment key", async () => {
    vi.stubEnv("OPENMAUSBOT_PRODUCT_AI_TOKEN", "stray-environment-key");
    const f = await upstream(chatOnce("must not run"));
    const instance = await managed({
      url: f.url, environment: { OPENMAUSBOT_PRODUCT_AI_TOKEN: "stray-instance-key" },
      credential: () => { throw new Error("Your account AI access has expired. Refresh your account status."); },
    });
    await expect(instance.adapter.sendTurn({ threadId: "refused", text: "hi" })).rejects.toThrow("account AI access has expired");
    await expect(instance.generateText!("helper")).rejects.toThrow("account AI access has expired");
    expect(f.calls).toEqual([]);
  });

  it("treats an empty getter answer as a refusal, never as a reason to read the static key", async () => {
    const f = await upstream(chatOnce("must not run"));
    const instance = await managed({ url: f.url, environment: { OPENMAUSBOT_PRODUCT_AI_TOKEN: "stray-instance-key" }, credential: () => ({ apiKey: "", expiresAt: 0 }) });
    await expect(instance.generateText!("helper")).rejects.toThrow(/account's AI access is not available/);
    expect(f.calls).toEqual([]);
  });

  it("reports readiness from the credential, and unavailability when the getter refuses", async () => {
    const f = await upstream(chatText("unused"));
    let allowed = true;
    const instance = await managed({
      url: f.url,
      credential: () => { if (!allowed) throw new Error("The account's AI access is not enabled."); return { apiKey: "token", expiresAt: Date.now() + 60_000 }; },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    allowed = false;
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("not enabled") });
    expect(f.calls).toEqual([]);
  });
});

const REFUSAL_TOOLS_NEED_RESPONSES = JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported here. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } });

describe("a managed credential and the liveness probe", () => {
  it("sends the current token with every probe, so a renewal reaches the probe too", async () => {
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_PROBE_MS", "120");
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "60000");
    const probes: Array<string | undefined> = [];
    const server: Server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        probes.push(request.headers.authorization);
        if (probes.length === 1) issued = "renewed-token";
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      if (request.method === "GET") {
        response.writeHead(404);
        response.end();
        return;
      }
      // A reply that never comes: the turn is stopped by the test once the probes have proved their point.
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    let issued = "initial-token";
    const instance = await managed({ url: `http://127.0.0.1:${address.port}/v1`, credential: () => ({ apiKey: issued, expiresAt: Date.now() + 60_000 }) });
    await instance.adapter.sendTurn({ threadId: "probing", text: "hi" });
    await vi.waitFor(() => { if (probes.length < 2) throw new Error(`only ${probes.length} probe(s)`); }, { timeout: 5_000, interval: 20 });
    await instance.adapter.interruptTurn("probing");
    expect(probes.slice(0, 2)).toEqual(["Bearer initial-token", "Bearer renewed-token"]);
  }, 20_000);

  it("stops a stalled reply when the getter refuses the probe's token", async () => {
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_PROBE_MS", "80");
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "60000");
    const server: Server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      if (request.method === "GET") {
        response.writeHead(404);
        response.end();
        return;
      }
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    let calls = 0;
    const instance = await managed({
      url: `http://127.0.0.1:${address.port}/v1`,
      credential: () => {
        calls += 1;
        // The turn's own admission read passes; the probe's next read is refused, so the stalled reply is stopped.
        if (calls > 1) throw new Error("The account's AI access is suspended.");
        return { apiKey: "initial-token", expiresAt: Date.now() + 60_000 };
      },
    });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(() => recorder.stop());
    await instance.adapter.sendTurn({ threadId: "refused-probe", text: "hi" });
    const done = await recorder.until((event) => event.type === "turn.completed", 5_000);
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.find((event) => event.type === "runtime.error")?.message).toContain("AI access is suspended");
  }, 20_000);
});

describe("an operator's pinned protocol", () => {
  it("keeps a chat-pinned model on Chat Completions when it offers tools, and never moves it to Responses", async () => {
    const f = await upstream((_call, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(REFUSAL_TOOLS_NEED_RESPONSES);
    });
    const instance = await managed({ url: f.url, modelProtocols: { "product-model": "chat" }, credential: () => ({ apiKey: "token", expiresAt: Date.now() + 60_000 }) });
    const events = await completedTurn(instance, "Use a tool", toolIntegrations());
    expect(f.calls.map((call) => call.path)).toEqual(["/v1/chat/completions"]);
    expect(events.find((event) => event.type === "runtime.error")?.message).toMatch(/set to use Chat Completions/);
  }, 20_000);

  it("starts a responses-pinned model on the Responses API for a tool-less helper call", async () => {
    const f = await upstream(responsesText("Responses helper"));
    const instance = await managed({ url: f.url, modelProtocols: { "product-model": "responses" }, credential: () => ({ apiKey: "token", expiresAt: Date.now() + 60_000 }) });
    await expect(instance.generateText!("hello", { model: "product-model" })).resolves.toBe("Responses helper");
    expect(f.calls.map((call) => call.path)).toEqual(["/v1/responses"]);
    expect(f.calls[0]!.body).toMatchObject({ model: "product-model", store: false, stream: true });
  });

  it("keeps a responses-pinned model on Responses for a tool turn, and does not fall back to Chat", async () => {
    const f = await upstream((_call, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Not found" } }));
    });
    const instance = await managed({ url: f.url, modelProtocols: { "product-model": "responses" }, credential: () => ({ apiKey: "token", expiresAt: Date.now() + 60_000 }) });
    const events = await completedTurn(instance, "Use a tool", toolIntegrations());
    expect(f.calls.map((call) => call.path)).toEqual(["/v1/responses"]);
    expect(events.find((event) => event.type === "runtime.error")?.message).toMatch(/set to use the Responses API/);
  }, 20_000);

  it("leaves an unlisted model's automatic negotiation intact: a relay's refusal keeps it on Chat with reasoning off", async () => {
    const f = await upstream((call, response, nth) => {
      if (call.body.reasoning_effort !== "none") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(REFUSAL_TOOLS_NEED_RESPONSES);
        return;
      }
      chatText("Negotiated.")(call, response, nth);
    });
    const instance = await managed({ url: f.url, modelProtocols: { "another-model": "chat" }, credential: () => ({ apiKey: "token", expiresAt: Date.now() + 60_000 }) });
    const events = await completedTurn(instance, "Use a tool", toolIntegrations());
    expect(f.calls.map((call) => call.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(f.calls[1]!.body).toMatchObject({ reasoning_effort: "none" });
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
  }, 20_000);
});

describe("createModelRoutes pins", () => {
  it("reports the pinned protocol and refuses to move a pinned model", () => {
    const routes = createModelRoutes("https://relay.example/v1", { "gpt-pinned": "responses", "chat-pinned": "chat" });
    expect(routes.routeFor("gpt-pinned", false)).toBe("responses");
    expect(routes.routeFor("gpt-pinned", true)).toBe("responses");
    expect(routes.advance("gpt-pinned", "responses-unavailable")).toBe(false);
    expect(routes.routeFor("chat-pinned", true)).toBe("chat");
    expect(routes.advance("chat-pinned", "tools-need-responses")).toBe(false);
    expect(routes.pinnedProtocol("gpt-pinned")).toBe("responses");
    expect(routes.pinnedProtocol("free")).toBeUndefined();
    expect(routes.routeFor("free", false)).toBe("chat");
  });

  it("still retries a pinned responses model without a summary when summaries are refused", () => {
    const routes = createModelRoutes("https://relay.example/v1", { "gpt-pinned": "responses" });
    expect(routes.advance("gpt-pinned", "summaries-refused")).toBe(true);
    expect(routes.advance("gpt-pinned", "summaries-refused")).toBe(false);
  });

  it("keeps every unpinned route exactly as it was", () => {
    const routes = createModelRoutes("https://relay.example/v1");
    expect(routes.routeFor("free", false)).toBe("chat");
    expect(routes.advance("free", "tools-need-responses")).toBe(true);
    expect(routes.routeFor("free", true)).toBe("chat-reasoning-off");
  });
});

describe("modelProtocols config", () => {
  it("accepts chat and responses per model and passes them through", () => {
    const config = OpenAICompatDriver.decodeConfig({ modelProtocols: { a: "chat", b: "responses" } });
    expect(config.modelProtocols).toEqual({ a: "chat", b: "responses" });
    expect(OpenAICompatDriver.decodeConfig({ modelProtocols: {} }).modelProtocols).toEqual({});
    expect(OpenAICompatDriver.decodeConfig({}).modelProtocols).toBeUndefined();
  });

  it("rejects anything else", () => {
    for (const raw of [
      { modelProtocols: [] as unknown },
      { modelProtocols: "chat" as unknown },
      { modelProtocols: { a: "responses-api" } },
      { modelProtocols: { a: "chat " } },
      { modelProtocols: { "": "chat" } },
      { modelProtocols: { a: 1 } },
    ]) {
      expect(() => OpenAICompatDriver.decodeConfig(raw), JSON.stringify(raw)).toThrow(/modelProtocols/);
    }
  });
});
