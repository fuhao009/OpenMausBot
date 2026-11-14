import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotTestApi } from "./bot-test-api.mjs";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bot-test-api-"));
  const calls = [];
  let stream, sendId, threadCount = 0;
  const rows = [];
  const response = value => Response.json(value);
  const request = async (route, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, ...init, body });
    if (overrides.request) {
      const result = await overrides.request(route, init);
      if (result) return result;
    }
    if (route === "/api/bots") return response({ bot: { id: "dedicated-bot", name: "Desktop API Test Bot", modelSelection: { instanceId: "gateway", model: "configured-model" } } });
    if (route.endsWith("/tasks")) return response({ task: { threadId: `thread-${++threadCount}`, modelSelection: { instanceId: "gateway", model: "configured-model" } } });
    if (route === "/api/events") return new Response(new ReadableStream({
      start(controller) {
        stream = controller;
        init.signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/messages")) {
      sendId = body.sendId;
      const message = { id: `request-${threadCount}`, role: "user", kind: "text", text: body.text, sendId, at: Date.now(), requestPending: true };
      rows.splice(0, rows.length, message);
      return response({ ok: true, threadId: body.threadId, message });
    }
    if (route.includes("/messages?")) return response({ messages: rows, hasMore: false });
    if (route.endsWith("/interrupt")) return response({ ok: true });
    throw new Error(`Unexpected route ${route}`);
  };
  const descriptorPath = join(directory, "api.json");
  const api = createBotTestApi({ request, descriptorPath, ...(overrides.ready ? { ready: overrides.ready } : {}) });
  const descriptor = await api.start();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path, method = "GET", body, headers = {}) => fetch(`${descriptor.url}${path}`, {
    method, headers: { authorization: `Bearer ${descriptor.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const emit = frame => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
  const until = async predicate => {
    for (let count = 0; count < 100; count++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("Expected asynchronous condition");
  };
  return { api, descriptor, descriptorPath, directory, calls, call, emit, until, rows, get sendId() { return sendId; } };
}

test("private descriptor, strict authentication, browser exclusion and bounded routes", async t => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse(await readFile(f.descriptorPath, "utf8")), f.descriptor);
  if (process.platform !== "win32") assert.equal((await stat(f.descriptorPath)).mode & 0o777, 0o600);
  assert.equal(new URL(f.descriptor.url).hostname, "127.0.0.1");
  assert.equal((await f.call("/v1/status", "GET", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.call("/v1/status", "GET", undefined, { origin: "null" })).status, 403);
  assert.equal((await f.call("/v1/status", "GET", undefined, { "sec-fetch-site": "same-origin" })).status, 403);
  assert.equal((await f.call("/api/bots")).status, 404);
  assert.equal((await f.call("/v1/runs", "POST", { text: "hello", botId: "existing" })).status, 400);
  assert.equal((await f.call("/v1/runs", "POST", { text: "x".repeat(70_000) })).status, 413);
  assert.equal(f.calls.length, 0);
  await f.api.close();
  await f.api.close();
  await assert.rejects(readFile(f.descriptorPath), { code: "ENOENT" });
  await assert.rejects(fetch(`${f.descriptor.url}/v1/status`));
});

test("normal Bot dispatch, real event timings, approval pause and final transcript", async t => {
  const f = await fixture(t);
  const { run } = await (await f.call("/v1/runs", "POST", { text: "Original prompt" })).json();
  await f.until(() => Boolean(f.sendId));
  assert.equal((await f.call("/v1/runs", "POST", { text: "second" })).status, 409);
  const create = f.calls.find(call => call.route === "/api/bots").body;
  assert.deepEqual(create, { name: "Desktop API Test Bot" });
  assert.deepEqual(f.calls.find(call => call.route.endsWith("/tasks")).body, { title: "Desktop API test", select: true });
  const event = (type, fields = {}, time = 20) => f.emit({ kind: "runtime", event: { type, threadId: "thread-1", turnId: "turn-1", createdAt: new Date(run.startedAt + time).toISOString(), ...fields } });
  event("session.started", { model: "actual-model", providerInstanceId: "gateway", provider: "openai" });
  event("item.started", { itemType: "tool", itemId: "tool-1", title: "Browser" }, 30);
  event("request.opened", { requestId: "approval", requestType: "permission", tool: "Browser", summary: "Open page" }, 40);
  let state;
  for (let i = 0; i < 30; i++) {
    state = (await (await f.call(`/v1/runs/${run.id}`)).json()).run;
    if (state.status === "needs-user") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.status, "needs-user");
  assert.equal(f.calls.some(call => /respond|approval/.test(call.route)), false);
  event("request.resolved", { requestId: "approval", behavior: "allow", source: "user" }, 50);
  event("item.completed", { itemType: "tool", itemId: "tool-1", ok: true, output: "Opened" }, 70);
  f.emit({ kind: "message", threadId: "thread-1", message: { id: "final", role: "bot", kind: "text", text: "Finished", requestMessageId: "request-1", turnTerminal: true, turnSucceeded: true, turnCompletedAt: run.startedAt + 100 } });
  f.emit({ kind: "message.patch", threadId: "thread-1", message: { ...f.rows[0], requestPending: false } });
  await new Promise(resolve => setTimeout(resolve, 20));
  state = (await (await f.call(`/v1/runs/${run.id}`)).json()).run;
  assert.equal(state.status, "completed");
  assert.equal(state.prompt, "Original prompt");
  assert.equal(state.finalText, "Finished");
  assert.equal(state.configuredModel.model, "configured-model");
  assert.equal(state.actualModel.model, "actual-model");
  assert.equal(state.tools[0].elapsedMs, 40);
  assert.ok(state.elapsedMs >= 0);
  assert.equal(state.completedAt, run.startedAt + 100);
  assert.equal(state.timings.firstModelEventMs, 20);
  assert.equal(state.requests[0].behavior, "allow");
});

test("stop interrupts only owned fresh task and each run creates a fresh task", async t => {
  const f = await fixture(t);
  const first = (await (await f.call("/v1/runs", "POST", { text: "First" })).json()).run;
  await f.until(() => Boolean(f.sendId));
  const stopped = (await (await f.call(`/v1/runs/${first.id}/stop`, "POST")).json()).run;
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(f.calls.find(call => call.route.endsWith("/interrupt")).body, { threadId: "thread-1" });
  const second = (await (await f.call("/v1/runs", "POST", { text: "Second" })).json()).run;
  await f.until(() => f.calls.filter(call => call.route.endsWith("/messages")).length === 2);
  await f.api.close();
  assert.equal(f.calls.filter(call => call.route === "/api/bots").length, 1);
  assert.equal(f.calls.filter(call => call.route.endsWith("/tasks")).length, 2);
  assert.ok(f.calls.some(call => call.route.endsWith("/interrupt") && call.body.threadId === "thread-2"));
  assert.notEqual(first.id, second.id);
});

test("closing during creation fences subsequent task and send requests", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { request: async route => {
    if (route === "/api/bots") { await gate; return Response.json({ bot: { id: "late-bot", name: "Late" } }); }
  } });
  await f.call("/v1/runs", "POST", { text: "Close now" });
  await f.until(() => f.calls.length === 1);
  const closing = f.api.close();
  release();
  await closing;
  assert.equal(f.calls.length, 1);
});

test("start failures preserve another instance's descriptor and release listener", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bot-test-collision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const descriptorPath = join(directory, "api.json");
  await writeFile(descriptorPath, "existing");
  const api = createBotTestApi({ request: async () => { throw new Error("unused"); }, descriptorPath });
  await assert.rejects(api.start(), { code: "EEXIST" });
  await api.close();
  assert.equal(await readFile(descriptorPath, "utf8"), "existing");
});

test("unready capability rejects dispatch without creating a bot", async t => {
  const f = await fixture(t, { ready: () => false });
  assert.equal((await (await f.call("/v1/status")).json()).status, "starting");
  assert.equal((await f.call("/v1/runs", "POST", { text: "hello" })).status, 503);
  assert.equal(f.calls.length, 0);
});

test("project failures retain route and status but never response secrets", async t => {
  const f = await fixture(t, { request: async () => Response.json({ code: "model_unavailable", error: "secret must not escape" }, { status: 409 }) });
  const { run } = await (await f.call("/v1/runs", "POST", { text: "hello" })).json();
  await f.until(async () => (await (await f.call(`/v1/runs/${run.id}`)).json()).run.status === "failed");
  const result = (await (await f.call(`/v1/runs/${run.id}`)).json()).run;
  assert.equal(result.error, "Project API POST /api/bots failed (409): model_unavailable");
  assert.equal(JSON.stringify(result).includes("secret must not escape"), false);
});
