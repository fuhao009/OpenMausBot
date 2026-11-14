#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchVerificationServer } from "./control-omb.ts";
import { handleToolCall } from "./mcp-server.ts";
import { createBotTestApi } from "../desktop/electron/bot-test-api.mjs";

const scratch = await mkdtemp(join(tmpdir(), "hezuo-bot-api-"));
const gate = join(scratch, "finish-turn");
const ownerToken = randomBytes(32).toString("base64url");
let fixture;
let api;
let replacement;
const checks = [];
const until = async (read, predicate, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
};
const timing = (value, label) => assert.ok(value === null || (Number.isFinite(value) && value >= 0), label);
try {
  fixture = await launchVerificationServer({
    ...process.env,
    OMB_TEST_DESKTOP_OWNER_TOKEN: ownerToken,
    FAKE_CLAUDE_MODE: "slow",
    FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
    FAKE_CLAUDE_TOOL_CALLS: "[]",
  });
  const request = (route, init = {}) => fetch(`${fixture.info.url}${route}`, {
    ...init,
    redirect: "error",
    headers: { ...init.headers, "x-hezuo-desktop-owner": ownerToken },
  });
  const serverJson = async (route, init) => {
    const response = await request(route, init);
    assert.ok(response.ok, `fixture server ${route}: ${response.status}`);
    return response.json();
  };
  const control = (name, args = {}) => handleToolCall(name, args, serverJson);
  const originalBots = (await control("list_bots")).bots;
  assert.ok(originalBots.length > 0);
  const originalMessages = await Promise.all(originalBots.map((bot) => control("get_bot_messages", {
    bot_id: bot.id, task_id: bot.activeTaskId, limit: 200,
  })));
  const descriptorPath = join(fixture.info.dataDir, "bot-test-api.json");
  api = createBotTestApi({ request, descriptorPath });
  const descriptor = await api.start();
  assert.deepEqual(JSON.parse(await readFile(descriptorPath, "utf8")), descriptor);
  assert.equal(new URL(descriptor.url).hostname, "127.0.0.1");
  assert.notEqual(descriptor.token, ownerToken);
  assert.ok(descriptor.token.length >= 32);
  if (process.platform !== "win32") assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
  checks.push("loopback listener, independent token, private descriptor");
  const call = (path, { token = descriptor.token, method = "GET", body, headers = {} } = {}) => fetch(`${descriptor.url}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path, options) => {
    const response = await call(path, options);
    assert.ok(response.ok, `test API ${path}: ${response.status}`);
    return response.json();
  };
  for (const token of [null, "wrong-token", ownerToken]) assert.equal((await call("/v1/status", { token })).status, 401);
  for (const origin of ["https://example.invalid", "null", descriptor.url]) {
    const response = await call("/v1/status", { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await call("/v1/runs", { method: "OPTIONS", headers: { Origin: "https://example.invalid", "Access-Control-Request-Method": "POST" } })).status, 403);
  assert.equal((await call("/api/bots")).status, 404);
  assert.equal((await json("/v1/status")).bot, null);
  checks.push("missing/wrong/owner token denied; browser Origin and generic proxy denied");
  for (const body of [{ text: "isolation", botId: originalBots[0].id }, { text: "isolation", threadId: originalBots[0].activeTaskId }, { text: "" }]) {
    assert.equal((await call("/v1/runs", { method: "POST", body })).status, 400);
  }
  assert.equal((await call("/v1/runs", { method: "POST", body: { text: "x".repeat(1_000_000) } })).status, 413);
  const prompt = "Isolated Bot API fixture completion";
  const submittedAt = performance.now();
  const accepted = await call("/v1/runs", { method: "POST", body: { text: prompt } });
  assert.equal(accepted.status, 202);
  const first = (await accepted.json()).run;
  const getRun = async (id) => (await json(`/v1/runs/${id}`)).run;
  const running = await until(() => getRun(first.id), (run) => run.threadId && run.status === "running", "normal Bot dispatch");
  assert.ok(!originalBots.some((bot) => bot.id === running.bot.id));
  assert.ok(running.bot.name);
  const dump = await until(async () => {
    try { return JSON.parse(await readFile(fixture.fixtureDumpPath, "utf8")); } catch { return null; }
  }, (value) => value && JSON.stringify(value.prompt).includes(prompt), "fixture engine receives original prompt");
  assert.ok(dump.argv, "real fixture CLI was launched");
  assert.equal((await call("/v1/runs", { method: "POST", body: { text: "must not overlap" } })).status, 409);
  await writeFile(gate, "finish");
  const completed = await until(() => getRun(first.id), (run) => ["completed", "failed"].includes(run.status), "Bot completion");
  assert.equal(completed.status, "completed");
  assert.ok(completed.finalText.includes(prompt));
  assert.ok(completed.requestMessageId);
  assert.ok(completed.startedAt && completed.completedAt);
  assert.ok(completed.elapsedMs >= 0 && completed.elapsedMs <= performance.now() - submittedAt + 1000);
  for (const [name, value] of Object.entries(completed.timings)) timing(value, name);
  assert.ok(Number.isFinite(completed.timings.dispatchMs));
  const status = await json("/v1/status");
  assert.equal(status.status, "ready");
  assert.equal(status.activeRunId, null);
  assert.equal(status.bot.id, completed.bot.id);
  assert.ok(status.runs.some((run) => run.id === completed.id && run.status === "completed"));
  assert.ok(Array.isArray(completed.tools) && Array.isArray(completed.requests));
  const messages = await control("get_bot_messages", { bot_id: completed.bot.id, task_id: completed.threadId, limit: 200 });
  assert.ok(messages.messages.some((message) => message.role === "user" && JSON.stringify(message).includes(prompt)));
  assert.ok(messages.messages.some((message) => message.role === "bot" && JSON.stringify(message).includes(prompt)));
  for (let index = 0; index < originalBots.length; index++) {
    const current = await control("get_bot_messages", { bot_id: originalBots[index].id, task_id: originalBots[index].activeTaskId, limit: 200 });
    assert.deepEqual(current.messages, originalMessages[index].messages);
  }
  checks.push("dedicated Bot, untouched original conversations, normal fixture engine completion, observed timings");
  await rm(gate);
  const second = (await json("/v1/runs", { method: "POST", body: { text: "Isolated pending stop" } })).run;
  const pending = await until(() => getRun(second.id), (run) => run.threadId && run.status === "running", "pending task");
  assert.equal(pending.bot.id, completed.bot.id);
  assert.notEqual(pending.threadId, completed.threadId);
  await json(`/v1/runs/${second.id}/stop`, { method: "POST" });
  const stopped = await until(() => getRun(second.id), (run) => run.status === "stopped", "stopped task");
  assert.ok(stopped.completedAt);
  const settled = await control("wait_for_conversation", { target_type: "bot", target_id: pending.bot.id, task_id: pending.threadId, timeout_seconds: 15 });
  assert.equal(settled.target.busy, false);
  checks.push("fresh task per run and scoped pending stop");
  const third = (await json("/v1/runs", { method: "POST", body: { text: "Close cancels this pending task" } })).run;
  const closing = await until(() => getRun(third.id), (run) => run.threadId && run.status === "running", "account-close pending task");
  await api.close();
  await assert.rejects(stat(descriptorPath), { code: "ENOENT" });
  await assert.rejects(call("/v1/status"));
  const closedTask = await control("wait_for_conversation", { target_type: "bot", target_id: closing.bot.id, task_id: closing.threadId, timeout_seconds: 15 });
  assert.equal(closedTask.target.busy, false);
  replacement = createBotTestApi({ request, descriptorPath });
  const nextDescriptor = await replacement.start();
  assert.notEqual(nextDescriptor.token, descriptor.token);
  assert.equal((await fetch(`${nextDescriptor.url}/v1/status`, { headers: { Authorization: `Bearer ${descriptor.token}` } })).status, 401);
  assert.equal((await fetch(`${nextDescriptor.url}/v1/status`, { headers: { Authorization: `Bearer ${nextDescriptor.token}` } }).then((response) => response.json())).bot, null);
  await replacement.close();
  await assert.rejects(stat(descriptorPath), { code: "ENOENT" });
  checks.push("account close cancels work, removes descriptor, invalidates old token, isolates new runtime");
  console.log(JSON.stringify({ passed: true, proof: "Isolated fake-engine wiring only; not a real AI or browser task acceptance result", checks }, null, 2));
} finally {
  await replacement?.close();
  await api?.close();
  await fixture?.close();
  await rm(scratch, { recursive: true, force: true });
}
