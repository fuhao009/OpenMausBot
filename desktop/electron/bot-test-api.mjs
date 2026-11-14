import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const BODY_LIMIT = 64 * 1024;
const terminal = new Set(["completed", "failed", "stopped"]);
const idPattern = /^[\w-]+$/;
const epoch = value => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const elapsed = (start, end) => start === null || end === null ? null : Math.max(0, end - start);
const fault = (status, message) => Object.assign(new Error(message), { status });

export function createBotTestApi({ request, descriptorPath, ready = () => true }) {
  if (typeof request !== "function" || !descriptorPath) throw new TypeError("request and descriptorPath are required");
  let server, token, started, closing, closed = false, bot = null, active = null;
  let descriptorOwned = false;
  const runs = new Map();
  const pending = new Set();
  const track = promise => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const current = run => !closed && active === run && run.status !== "stopping" && !terminal.has(run.status);
  const view = run => ({ ...run.data, status: run.status, elapsedMs: (run.endedTick ?? performance.now()) - run.startedTick });
  const finish = (run, status, error = null, at = Date.now()) => {
    if (terminal.has(run.status)) return;
    run.status = status;
    run.data.completedAt = at;
    run.endedTick = performance.now();
    run.data.error = error;
    clearInterval(run.poll);
    run.controller.abort();
    if (active === run) active = null;
  };
  async function json(route, method = "GET", body, signal) {
    const response = await request(route, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const code = typeof payload?.code === "string" && /^[a-z0-9_]{1,80}$/.test(payload.code) ? payload.code : null;
      throw Object.assign(fault(502, `Project API ${method} ${route.split("?")[0]} failed (${response.status})${code ? `: ${code}` : ""}`), { projectFailure: true });
    }
    return response.json();
  }
  async function interrupt(run) {
    if (!run.data.threadId || !run.data.bot) return;
    await json(`/api/bots/${run.data.bot.id}/interrupt`, "POST", { threadId: run.data.threadId });
  }
  function message(run, row) {
    if (!row || typeof row.id !== "string") return;
    if (row.card?.requestId) {
      const card = row.card;
      const entry = run.requests.get(card.requestId) ?? { id: card.requestId, type: card.requestType ?? "question", tool: card.tool ?? null, summary: row.text ?? null, openedAt: epoch(row.at), resolvedAt: null, behavior: null };
      if (card.answered || card.dismissed || card.expired) Object.assign(entry, { resolved: true, behavior: card.answered ?? (card.dismissed ? "dismissed" : "expired") });
      run.requests.set(card.requestId, entry);
    }
    run.messages.set(row.id, row);
    if (row.role === "user" && row.sendId === run.data.id) run.data.requestMessageId = row.id;
    if (row.tool) {
      const key = row.tool.itemId ? `${row.turnId ?? ""}:${row.tool.itemId}` : `message:${row.id}`;
      const tool = run.tools.get(key) ?? { id: key, startedAt: null, completedAt: null, elapsedMs: null };
      Object.assign(tool, { name: row.tool.name, input: row.tool.input ?? tool.input ?? null, output: row.tool.output ?? tool.output ?? null, ok: row.tool.ok ?? tool.ok ?? null, summary: row.tool.summary ?? tool.summary ?? null });
      run.tools.set(key, tool);
    }
  }
  function refresh(run) {
    run.data.tools = [...run.tools.values()];
    run.data.requests = [...run.requests.values()];
    const owned = [...run.messages.values()].filter(row => row.requestMessageId === run.data.requestMessageId);
    const replies = owned.filter(row => row.role === "bot" && row.kind === "text");
    run.data.finalText = replies.filter(row => row.turnTerminal).map(row => row.text ?? "").join("\n") || null;
    const origin = run.messages.get(run.data.requestMessageId);
    if (origin?.requestCancelled) return finish(run, "stopped");
    if (origin?.requestPending === false) {
      const failed = owned.some(row => row.turnSucceeded === false || row.tool?.terminal === true && row.tool.ok === false);
      const end = owned.map(row => epoch(row.turnCompletedAt)).filter(value => value !== null);
      return finish(run, failed ? "failed" : "completed", failed ? "The project Bot turn failed" : null, end.length ? Math.max(...end) : Date.now());
    }
    if (origin && owned.some(row => row.turnSucceeded === false || row.tool?.terminal === true && row.tool.ok === false)) return finish(run, "failed", "The project Bot turn failed");
    if (current(run)) run.status = [...run.requests.values()].some(row => !row.resolved) || [...run.messages.values()].some(row => (row.connector && !row.connector.dismissed && !row.connector.resumed && row.connector.status !== "connected") || (row.secret && !row.secret.provided && !row.secret.dismissed && !row.secret.superseded) || (row.signIn && !row.signIn.done && !row.signIn.cancelled && !row.signIn.superseded && !row.signIn.answeredInChat)) ? "needs-user" : "running";
  }
  function frame(run, frame) {
    if (!current(run)) return;
    if ((frame.kind === "message" || frame.kind === "message.patch") && frame.threadId === run.data.threadId) message(run, frame.message);
    if (frame.kind === "bot" && frame.bot?.id === run.data.bot?.id) {
      run.data.bot = { id: frame.bot.id, name: frame.bot.name };
      const task = frame.bot.tasks?.find(task => task.threadId === run.data.threadId);
      if (task?.modelSelection) run.data.configuredModel = task.modelSelection;
    }
    if (frame.kind === "runtime" && frame.event?.threadId === run.data.threadId) {
      const event = frame.event;
      const at = epoch(event.createdAt);
      if (run.data.timings.firstModelEventMs === null && !event.synthetic) run.data.timings.firstModelEventMs = elapsed(run.data.startedAt, at);
      if (event.type === "session.started" && event.model) run.data.actualModel = { instanceId: event.providerInstanceId ?? null, model: event.model, provider: event.provider ?? null };
      if ((event.type === "content.delta" && event.streamKind === "assistant_text" || event.type === "item.completed" && event.itemType === "assistant_text") && !event.synthetic && run.data.timings.firstTextMs === null) run.data.timings.firstTextMs = elapsed(run.data.startedAt, at);
      if (event.itemType === "tool" && event.itemId && (event.type === "item.started" || event.type === "item.completed")) {
        const key = `${event.turnId ?? ""}:${event.itemId}`;
        const tool = run.tools.get(key) ?? { id: key, name: null, input: null, output: null, ok: null, startedAt: null, completedAt: null, elapsedMs: null };
        if (event.type === "item.started") Object.assign(tool, { startedAt: at, name: event.title ?? null, input: event.input ?? null, summary: event.summary ?? null });
        else Object.assign(tool, { completedAt: at, output: event.output ?? null, ok: event.ok });
        tool.elapsedMs = elapsed(tool.startedAt, tool.completedAt);
        run.tools.set(key, tool);
      }
      if (event.requestId && event.type === "request.opened") run.requests.set(event.requestId, { id: event.requestId, type: event.requestType, tool: event.tool, summary: event.summary, openedAt: at, resolvedAt: null, behavior: null });
      if (event.requestId && event.type === "request.resolved") {
        const entry = run.requests.get(event.requestId);
        if (entry) Object.assign(entry, { resolvedAt: at, resolved: true, behavior: event.behavior, source: event.source });
      }
    }
    refresh(run);
  }
  async function consume(run, response) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      if (!current(run)) return;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Event frame exceeded limit");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) frame(run, JSON.parse(data));
      }
    }
    if (current(run)) throw new Error("Project event stream closed");
  }
  async function reconcile(run) {
    if (!current(run) || run.polling || !run.data.threadId) return;
    run.polling = true;
    try {
      let before;
      do {
        const page = await json(`/api/threads/${run.data.threadId}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`, "GET", undefined, run.controller.signal);
        if (!current(run)) return;
        for (const row of page.messages) message(run, row);
        const next = page.hasMore && page.messages[0]?.id;
        if (next === before) throw new Error("Invalid message pagination");
        before = next;
      } while (before);
      refresh(run);
    } finally { run.polling = false; }
  }
  async function fail(run, error) {
    if (!current(run) || run.status === "stopping") return;
    run.status = "stopping";
    try { await interrupt(run); } catch {}
    finish(run, "failed", error?.projectFailure ? error.message : "Project execution or observation failed");
  }
  async function execute(run) {
    try {
      if (!bot) {
        const created = await json("/api/bots", "POST", { name: "Desktop API Test Bot" }, run.controller.signal);
        if (!created.bot || !idPattern.test(created.bot.id)) throw new Error("Invalid Bot response");
        bot = created.bot;
      }
      if (!current(run)) return;
      run.data.bot = { id: bot.id, name: bot.name };
      const created = await json(`/api/bots/${bot.id}/tasks`, "POST", { title: "Desktop API test", select: true }, run.controller.signal);
      if (!created.task || !idPattern.test(created.task.threadId)) throw new Error("Invalid task response");
      run.data.threadId = created.task.threadId;
      run.data.configuredModel = created.task.modelSelection ?? bot.modelSelection ?? null;
      if (!current(run)) return;
      const events = await request("/api/events", { signal: run.controller.signal, headers: { accept: "text/event-stream" } });
      if (!events.ok || !events.body) throw new Error("Project events unavailable");
      track(consume(run, events).catch(() => fail(run)));
      if (!current(run)) return;
      run.sent = true;
      const receipt = await json(`/api/bots/${bot.id}/messages`, "POST", { threadId: run.data.threadId, text: run.data.prompt, sendId: run.data.id }, run.controller.signal);
      if (!current(run)) return;
      if (!receipt.message || receipt.queued) throw new Error("Unexpected queued test request");
      message(run, receipt.message);
      run.data.requestMessageId = receipt.message.id;
      run.data.timings.dispatchMs = performance.now() - run.startedTick;
      refresh(run);
      if (current(run)) {
        run.poll = setInterval(() => track(reconcile(run).catch(() => fail(run))), 500);
        run.poll.unref();
        await reconcile(run);
      }
    } catch (error) { await fail(run, error); }
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw fault(415, "Expected application/json");
    if (Number(req.headers["content-length"]) > BODY_LIMIT) { req.resume(); throw fault(413, "Request body too large"); }
    return new Promise((resolve, reject) => {
      let size = 0, exceeded = false;
      const chunks = [];
      req.on("data", chunk => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          if (!exceeded) reject(fault(413, "Request body too large"));
          exceeded = true;
          chunks.length = 0;
        } else if (!exceeded) chunks.push(chunk);
      });
      req.once("error", reject);
      req.once("aborted", () => reject(fault(400, "Request aborted")));
      req.once("end", () => {
        if (exceeded) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(fault(400, "Invalid JSON")); }
      });
    });
  }
  async function handle(req, res) {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    try {
      if (closed) throw fault(503, "Test API closed");
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) throw fault(403, "Browser requests are not allowed");
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw fault(401, "Unauthorized");
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) throw fault(403, "Invalid host");
      const path = req.url;
      if (req.method === "GET" && path === "/v1/status") return send(200, { status: ready() ? "ready" : "starting", bot: bot ? { id: bot.id, name: bot.name } : null, activeRunId: active?.data.id ?? null, runs: [...runs.values()].map(view) });
      if (req.method === "POST" && path === "/v1/runs") {
        if (!ready()) throw fault(503, "The account model capability is not ready");
        const input = await body(req);
        if (closed) throw fault(503, "Test API closed");
        if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.text !== "string" || !input.text.trim()) throw fault(400, "Only a nonempty text field is accepted");
        if (active) throw fault(409, "A test run is already active");
        if (runs.size >= 50) runs.delete(runs.keys().next().value);
        const run = { status: "starting", controller: new AbortController(), messages: new Map(), tools: new Map(), requests: new Map(), data: { id: randomUUID(), prompt: input.text, bot: null, threadId: null, configuredModel: null, actualModel: null, requestMessageId: null, finalText: null, startedAt: Date.now(), completedAt: null, timings: { dispatchMs: null, firstModelEventMs: null, firstTextMs: null }, tools: [], requests: [], error: null } };
        run.startedTick = performance.now();
        active = run;
        runs.set(run.data.id, run);
        track(execute(run));
        return send(202, { run: view(run) });
      }
      const match = path?.match(/^\/v1\/runs\/([\w-]+)(\/stop)?$/);
      const run = match && runs.get(match[1]);
      if (run && !match[2] && req.method === "GET") return send(200, { run: view(run) });
      if (run && match[2] && req.method === "POST") {
        if (!terminal.has(run.status)) {
          run.status = "stopping";
          run.controller.abort();
          await Promise.allSettled([...pending]);
          await interrupt(run);
          finish(run, "stopped");
        }
        return send(200, { run: view(run) });
      }
      throw fault(404, "Not found");
    } catch (error) { if (!res.headersSent) send(error.status ?? 502, { error: error.status ? error.message : "Project API unavailable" }); }
  }
  async function start() {
    if (closed) throw new Error("Test API closed");
    if (started) return started;
    started = (async () => {
      token = randomBytes(32).toString("hex");
      server = http.createServer((req, res) => { void handle(req, res); });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.maxRequestsPerSocket = 100;
      try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        if (closed) throw new Error("Test API closed");
        const descriptor = { url: `http://127.0.0.1:${server.address().port}`, token };
        await mkdir(dirname(descriptorPath), { recursive: true });
        const file = await open(descriptorPath, "wx", 0o600);
        descriptorOwned = true;
        try { await file.writeFile(`${JSON.stringify(descriptor)}\n`); } finally { await file.close(); }
        if (closed) throw new Error("Test API closed");
        return descriptor;
      } catch (error) {
        closed = true;
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
        if (descriptorOwned) await unlink(descriptorPath).catch(() => {});
        token = null;
        throw error;
      }
    })();
    return started;
  }
  function close() {
    if (closing) return closing;
    closed = true;
    token = null;
    const run = active;
    if (run) { run.status = "stopping"; run.controller.abort(); clearInterval(run.poll); }
    closing = (async () => {
      if (started) await started.catch(() => {});
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
      }
      if (descriptorOwned) { await unlink(descriptorPath).catch(error => { if (error.code !== "ENOENT") throw error; }); descriptorOwned = false; }
      await Promise.allSettled([...pending]);
      if (run) {
        try { await interrupt(run); } finally { finish(run, "stopped"); }
      }
    })();
    return closing;
  }
  return { start, close };
}
