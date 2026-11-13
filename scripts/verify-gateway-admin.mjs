// Run with Node >=24: node scripts/verify-gateway-admin.mjs
// Add --smoke for isolated publication, probe, inference and restart verification.
// Opens no browser and never reads an existing gateway config or database.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createControlPlaneClient } from "../desktop/electron/control-plane-client.mjs";
import { createPinnedHttpsFetch } from "../desktop/electron/product-ca.mjs";
import { ROOT } from "./product-fixture/runtime.mjs";
import { MODELS } from "./product-fixture/worker-fixture.mjs";

const CLI = join(ROOT, "gateway", "local", "local-gateway.mjs");
const HOST = "127.0.0.1";
const STARTUP_MS = 90_000;
const model = MODELS[0];
const smoke = process.argv.includes("--smoke");
const taskBilling = process.argv.includes("--task-billing");
const taskModels = [
  { id: "task-economy", label: "Task Economy", upstreamModel: "gpt-6-luna", capacity: "simple" },
  { id: "task-expert", label: "Task Expert", upstreamModel: "gpt-6-astra", capacity: "complex" },
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function credential(role) {
  return { email: `${role}@fixture.test`, password: randomBytes(18).toString("base64url") };
}

function startCommand(command, args, env) {
  // Isolate the CLI and its workerd/esbuild descendants so timeouts cannot
  // leave a listener or an open database behind (nor signal a live gateway).
  const child = spawn(process.execPath, [CLI, command, ...args], {
    cwd: ROOT, env, detached: true, stdio: ["ignore", "ignore", "inherit"],
  });
  let result;
  const exited = new Promise(resolve => {
    child.once("error", error => { result = error.message; resolve(result); });
    child.once("exit", (code, signal) => {
      result = code === 0 ? "ok" : String(signal ?? `exit ${code}`);
      resolve(result);
    });
  });
  return { child, exited, get result() { return result; } };
}

async function stopCommand(command) {
  const { child, exited, result } = command;
  if (!child.pid) return;
  // Give the actual gateway CLI a chance to flush D1 and dispose Miniflare.
  if (result === undefined) {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
  }
  if (command.result !== undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  await exited;
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
}

async function run() {
  if (process.platform === "win32") throw new Error("This fixture needs POSIX process groups (macOS or Linux).");
  // Keep workerd's temporary socket paths short, even on macOS.
  const root = mkdtempSync("/tmp/hezuo-admin-");
  const home = join(root, "home");
  const dataDir = join(root, "gateway");
  const configPath = join(dataDir, "gateway.json");
  const runtimePath = join(dataDir, "gateway-runtime.json");
  const certificate = join(root, "certificate.pem");
  const keyPath = join(root, "certificate-key.pem");
  const upstreamKey = randomBytes(24).toString("base64url");
  // Do not inherit gateway, mail, upstream, Node options, or any proxy settings.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, NO_PROXY: HOST, NODE_EXTRA_CA_CERTS: certificate };
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const startup = AbortSignal.any([shutdown.signal, AbortSignal.timeout(STARTUP_MS)]);
  const startupAborted = waitForAbort(startup);
  let command;
  let upstream;

  async function cli(name, ...args) {
    startup.throwIfAborted();
    command = startCommand(name, ["--config", configPath, ...args], env);
    const result = await Promise.race([command.exited, startupAborted]);
    startup.throwIfAborted();
    if (result !== "ok") throw new Error(`Gateway ${name} failed (${result})`);
    command = undefined;
  }

  async function startGateway(origin) {
    startup.throwIfAborted();
    rmSync(runtimePath, { force: true });
    command = startCommand("start", ["--config", configPath], env);
    // Written only after migrations, listener, health probe and scheduled task.
    while (command.result === undefined) {
      startup.throwIfAborted();
      let runtime;
      try { runtime = JSON.parse(readFileSync(runtimePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (runtime) {
        if (runtime.pid !== command.child.pid || runtime.configPath !== configPath
            || runtime.origin !== origin || runtime.certificate !== certificate) {
          throw new Error("Gateway runtime does not match the isolated fixture");
        }
        return;
      }
      await delay(100, undefined, { signal: startup });
    }
    throw new Error(`Gateway start exited before readiness (${command.result})`);
  }

  try {
    mkdirSync(home, { mode: 0o700 });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", keyPath, "-out", certificate, "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=IP:${HOST}`],
    { timeout: 10_000, stdio: "ignore" });
    const ca = readFileSync(certificate, "utf8");
    upstream = createServer({ key: readFileSync(keyPath), cert: ca }, async (request, response) => {
      if (request.headers.authorization !== `Bearer ${upstreamKey}`) {
        request.resume();
        response.writeHead(401).end();
        return;
      }
      const path = request.url?.replace(/^\/browser/, "");
      if (request.method === "GET" && path === "/v1/models") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          data: [{ id: model.upstreamModel }, { id: "fixture-browser-model" }, ...taskModels.map(value => ({ id: value.upstreamModel }))],
        }));
        return;
      }
      if (request.method !== "POST" || path !== "/v1/chat/completions") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (![model.upstreamModel, "fixture-browser-model", ...taskModels.map(value => value.upstreamModel)].includes(body.model)) {
        response.writeHead(400).end();
        return;
      }
      // Keep one held reservation for the existing review UI; all subsequent
      // browser and smoke requests have real usage and settle normally.
      const review = body.messages?.some(message => message.content === "Seed one request for operator review.");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        model: body.model, choices: [{ message: { role: "assistant", content: "Disposable fixture reply" } }],
        ...(review ? {} : { usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0, cache_write_1h_tokens: 0 } } }),
      }));
    });
    const upstreamPort = await listen(upstream);
    const portReservation = createTcpServer();
    const port = await listen(portReservation);
    await closeServer(portReservation);
    const origin = `https://${HOST}:${port}`;
    // Start without any legacy AI configuration: operator bootstrap and admin
    // access must work before a model exists, not only after publication.
    await cli("init", "--data-dir", dataDir, "--host", HOST, "--port", String(port),
      "--cert", certificate, "--key", keyPath, "--email-verification", "off");
    await startGateway(origin);
    const transport = createPinnedHttpsFetch({ origin, ca });
    const requestSignal = ms => AbortSignal.any([startup, AbortSignal.timeout(ms)]);
    const client = createControlPlaneClient({ baseURL: origin, fetchImpl: transport, timeoutSignal: requestSignal });
    const operator = credential("operator");
    const ordinary = credential("ordinary");
    await client.signUpWithPassword(operator.email, operator.password);
    await client.signUpWithPassword(ordinary.email, ordinary.password);
    await stopCommand(command);
    command = undefined;
    // The real operator bootstrap permits only the registered fixture account.
    await cli("operator", "--operator-email", operator.email);
    await startGateway(origin);

    const operatorSession = await client.signInWithPassword(operator.email, operator.password);
    const ordinarySession = await client.signInWithPassword(ordinary.email, ordinary.password);
    async function request(path, status, token, body) {
      const response = await transport(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { origin }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal(10_000),
      });
      if (response.status !== status) throw new Error(`${path.split("?", 1)[0]} returned ${response.status}, expected ${status}`);
      return response;
    }
    const operatorToken = operatorSession.accountToken;
    await (await request("/v1/operator/me", 401)).json();
    await (await request("/v1/operator/me", 403, ordinarySession.accountToken)).json();
    const me = await (await request("/v1/operator/me", 200, operatorToken)).json();
    if (me.user.id !== operatorSession.user.id || me.capabilities.ai) throw new Error("Empty gateway operator bootstrap failed");
    const empty = await (await request("/v1/operator/channels", 200, operatorToken)).json();
    if (empty.revision !== 0 || empty.channels.length || empty.models.length) throw new Error("Expected a fresh empty catalog");
    const initialPublication = {
      revision: 0, reason: "Publish disposable admin fixture",
      channels: [{ id: "fixture", name: "Disposable fixture", baseURL: `https://${HOST}:${upstreamPort}/v1`, enabled: true, apiKey: upstreamKey }],
      models: [...MODELS.map(value => ({ ...value, channelId: "fixture" })), ...(taskBilling ? taskModels.map(({ capacity, ...value }) => ({ ...model, ...value, maxContextTokens: 2048, maxOutputTokens: 128, channelId: "fixture" })) : [])], defaultModel: model.id,
    };
    await (await request("/v1/operator/channels", 200, operatorToken, initialPublication)).json();
    const discovery = await (await request("/v1/operator/channels/fixture/probe", 200, operatorToken, {})).json();
    if (!discovery.models.includes("fixture-browser-model")) throw new Error("Disposable upstream discovery failed");
    await stopCommand(command);
    command = undefined;
    await startGateway(origin);
    const persisted = await (await request("/v1/operator/channels", 200, operatorToken)).json();
    if (persisted.revision !== 1 || !persisted.channels[0]?.hasKey || persisted.models[0]?.channelId !== "fixture") {
      throw new Error("Channel publication did not survive gateway restart");
    }

    const userId = ordinarySession.user.id;
    const adjust = async (path, payload) => (await request(path, 200, operatorToken, {
      userId, operationId: randomUUID(), reason: "Seed disposable admin fixture", ...payload,
    })).json();
    await adjust("/v1/operator/ai/account", { enabled: true });
    await adjust("/v1/operator/ai/balance", { amountMicroPoints: taskBilling ? 1_000_000_000 : 5_000_000 });
    const { token } = await (await request("/v1/account/ai/tokens", 201, ordinarySession.accountToken, { deviceId: randomUUID() })).json();
    await (await request("/v1/ai/chat/completions", 502, token, {
      model: model.id, messages: [{ role: "user", content: "Seed one request for operator review." }],
    })).json();
    const { requests } = await (await request(`/v1/operator/ai/requests?userId=${encodeURIComponent(userId)}`, 200, operatorToken)).json();
    const reviewed = requests.find(row => row.state === "review" && row.settlementReason === "usage_missing");
    if (!reviewed) throw new Error("The fixture inference did not create the expected held reservation");
    const admin = await request("/admin", 200);
    await admin.text();
    if (!admin.headers.get("content-type")?.startsWith("text/html")) throw new Error("The gateway did not serve the admin page");

    const browserChannel = { id: "browser", name: "Browser disposable upstream", baseURL: `https://${HOST}:${upstreamPort}/browser/v1`, enabled: true, apiKey: upstreamKey };
    const browserModel = { ...model, id: "browser-model", label: "Browser published model", upstreamModel: "fixture-browser-model", channelId: "browser" };
    if (taskBilling) {
      const initial = await (await request("/v1/operator/billing", 200, operatorToken)).json();
      await (await request("/v1/operator/billing", 200, operatorToken, {
        revision: initial.revision, reason: "Enable isolated task pricing", policy: { ...initial.policy, enabled: true,
          profiles: taskModels.map(value => ({ modelId: value.id, capacity: value.capacity, tools: true, vision: true })) },
      })).json();
      const inference = { model: "auto-chat", messages: [{ role: "user", content: "hello" }], max_tokens: 10 };
      const quote = await (await request("/v1/ai/quote", 200, token, { endpoint: "chat", request: inference })).json();
      if (quote.selectedModel !== "task-economy") throw new Error("Task routing did not select the economy profile");
      await (await request("/v1/ai/chat/completions", 200, token, inference)).json();
      const complex = { ...inference, messages: [{ role: "user", content: "Audit architecture and prove correctness" }], reasoning_effort: "high" };
      const complexQuote = await (await request("/v1/ai/quote", 200, token, { endpoint: "chat", request: complex })).json();
      if (complexQuote.selectedModel !== "task-expert") throw new Error("Complex routing did not enforce capacity");
      await (await request("/v1/ai/chat/completions", 200, token, complex)).json();
      const metrics = await (await request("/v1/operator/billing/metrics", 200, operatorToken)).json();
      if (metrics.sampleCount !== 2 || metrics.unknownCostCount !== 0 || metrics.estimatedCostMicroCurrency <= 0) throw new Error("Cost metrics did not reflect actual fixture settlement");
      await stopCommand(command); command = undefined; await startGateway(origin);
      const restored = await (await request("/v1/operator/billing", 200, operatorToken)).json();
      if (!restored.policy.enabled || restored.revision !== 1) throw new Error("Task pricing policy did not persist");
      if (smoke) {
        console.log(JSON.stringify({ smoke: "passed", taskBilling: true, simpleModel: quote.selectedModel, complexModel: complexQuote.selectedModel, metricsSamples: metrics.sampleCount, url: `${origin}/admin` }));
        return;
      }
    }
    if (smoke) {
      const published = await (await request("/v1/operator/channels", 200, operatorToken, {
        revision: persisted.revision, reason: "Smoke browser channel publication",
        channels: [...persisted.channels, browserChannel], models: [...persisted.models, browserModel], defaultModel: browserModel.id,
      })).json();
      if (JSON.stringify(published).includes(upstreamKey)) throw new Error("Catalog exposed a disposable upstream credential");
      const probe = await (await request("/v1/operator/channels/browser/probe", 200, operatorToken, {})).json();
      if (!probe.models.includes(browserModel.upstreamModel)) throw new Error("Browser channel probe failed");
      const reply = await (await request("/v1/ai/chat/completions", 200, token, {
        model: browserModel.id, messages: [{ role: "user", content: "Verify published browser channel" }], max_tokens: 10,
      })).json();
      if (reply.choices?.[0]?.message?.content !== "Disposable fixture reply") throw new Error("Published channel inference failed");
      await stopCommand(command);
      command = undefined;
      await startGateway(origin);
      const restarted = await (await request("/v1/operator/channels", 200, operatorToken)).json();
      if (restarted.revision !== published.revision || restarted.defaultModel !== browserModel.id) throw new Error("Browser publication lost after restart");
      await (await request("/v1/ai/chat/completions", 200, token, {
        model: browserModel.id, messages: [{ role: "user", content: "Verify persisted encrypted credential" }], max_tokens: 10,
      })).json();
      console.log(JSON.stringify({ smoke: "passed", url: `${origin}/admin`, disposableUpstreamURL: browserChannel.baseURL }));
      return;
    }
    console.log(JSON.stringify({
      url: `${origin}/admin`, certificate, operator, ordinary,
      review: { accountEmail: ordinary.email, requestId: reviewed.id, reservedMicroPoints: reviewed.reservedMicroPoints },
      channel: { baseURL: browserChannel.baseURL, apiKey: upstreamKey, upstreamModel: browserModel.upstreamModel,
        suggestedPublicId: browserModel.id, accountAiToken: token, inferenceURL: `${origin}/v1/ai/chat/completions` },
      note: "All credentials below are disposable, generated for this fixture only. Add a channel using channel.baseURL/apiKey, save it with a reason, probe it, publish a chat model with explicit prices and a default, then call channel.inferenceURL using channel.accountAiToken. Existing requests include one held reservation for review. Ctrl-C stops and deletes everything. --smoke runs publication, probe, inference and restart checks then exits.",
    }, null, 2));
    const exited = await Promise.race([command.exited, waitForAbort(shutdown.signal)]);
    if (!shutdown.signal.aborted) throw new Error(`Fixture gateway exited (${exited})`);
  } catch (error) {
    if (!shutdown.signal.aborted) {
      throw startup.aborted ? new Error(`Gateway fixture did not start within ${STARTUP_MS / 1000}s`, { cause: error }) : error;
    }
  } finally {
    try {
      if (command) await stopCommand(command);
    } finally {
      if (upstream) await closeServer(upstream);
      rmSync(root, { recursive: true, force: true });
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

run().catch(error => {
  console.error(`[verify-gateway-admin] ${error.message}`);
  process.exitCode = 1;
});
