import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  COMPANION_RELAY_PATH,
  FRAME,
  accountDeviceId,
  accountOwnsDesktop,
  bearerToken,
  companionPathFor,
  createCompanionRelay,
  createFrameDecoder,
  encodeFrame,
  installationFromCredential,
  parseCompanionRequestPath,
} from "./companion-relay.mjs";

const INSTALLATION = "2c1b5c4e-7a0a-4d3f-9c11-0b5a6d8e9f10";
const ACCOUNT = "user_alice";

function workerFetchFor({ token, installationId = INSTALLATION, platform = "darwin", userId = ACCOUNT, installations } = {}) {
  const hosts = installations ?? [{ id: installationId, platform, name: "Desk" }];
  return async (path, init = {}) => {
    const presented = bearerToken(init.headers?.authorization ?? "");
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const deny = (status = 401) => new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status });
    if (path === "/v1/installations/self") {
      if (presented !== token) return deny();
      return ok({ installation: { id: installationId, platform, name: "Desk" } });
    }
    if (path === "/v1/me") {
      if (presented !== token) return deny();
      return ok({ user: { id: userId, email: "a@example.test" } });
    }
    if (path === "/v1/installations") {
      if (presented !== token) return deny();
      return ok({ installations: hosts });
    }
    return deny(404);
  };
}

test("frame codec round-trips and rejects an oversized frame", () => {
  const decoder = createFrameDecoder();
  const first = encodeFrame(7, FRAME.DATA, Buffer.from("hello"));
  const second = encodeFrame(7, FRAME.END);
  const frames = decoder.push(Buffer.concat([first, second.subarray(0, 4)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].streamId, 7);
  assert.equal(frames[0].payload.toString(), "hello");
  const rest = decoder.push(second.subarray(4));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].type, FRAME.END);
  assert.throws(() => encodeFrame(1, FRAME.DATA, Buffer.alloc(64 * 1024 + 1)));
});

test("companion request paths only accept a desktop installation UUID", () => {
  assert.equal(companionPathFor("not-a-uuid"), null);
  assert.equal(parseCompanionRequestPath("/v1/companion/"), null);
  assert.equal(parseCompanionRequestPath(`/v1/companion/${INSTALLATION}`)?.path, "/");
  assert.equal(parseCompanionRequestPath(`/v1/companion/${INSTALLATION}/api/events`)?.path, "/api/events");
    assert.deepEqual(parseCompanionRequestPath(`/V1/COMPANION/${INSTALLATION}/api/ok`), null);
  assert.equal(accountDeviceId("user/../x"), "account-user----x");
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
});

test("an account session may only reach a desktop installation it owns", async () => {
  const fetchImpl = workerFetchFor({ token: "sess" });
  assert.equal(await installationFromCredential(fetchImpl, "wrong"), null);
  assert.equal((await installationFromCredential(fetchImpl, "sess")).id, INSTALLATION);
  assert.ok(await accountOwnsDesktop(fetchImpl, "sess", INSTALLATION));
  assert.equal(await accountOwnsDesktop(fetchImpl, "sess", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), null);
  const phoneOnly = workerFetchFor({
    token: "sess",
    installations: [{ id: INSTALLATION, platform: "android", name: "Phone" }],
  });
  assert.equal(await accountOwnsDesktop(phoneOnly, "sess", INSTALLATION), null);
  const asPhone = workerFetchFor({ token: "cred", platform: "linux" });
  // installationFromCredential uses /self and accepts linux.
  assert.equal((await installationFromCredential(asPhone, "cred")).platform, "linux");
});

test("a signed-in phone reaches the desktop through the relay and a stranger does not", async () => {
  const origin = await listenHello();
  const desktopSide = await listenDesktop(origin);
  const relay = createCompanionRelay({
    workerFetch: workerFetchFor({ token: "sess", installationId: INSTALLATION }),
  });
  const gateway = createServer((req, res) => {
    void relay.handleRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  gateway.on("upgrade", (req, socket, head) => {
    void relay.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  const base = `http://127.0.0.1:${address.port}`;

  const ws = new WebSocket(`${base}${COMPANION_RELAY_PATH}`, {
    headers: { Authorization: "Bearer sess" },
  });
  desktopSide.attach(ws);
  await Promise.race([
    once(ws, "open"),
    once(ws, "error").then((args) => { throw args[0] ?? new Error("websocket failed"); }),
  ]);
  await waitUntil(() => relay.registry.has(INSTALLATION));

  try {
    const ok = await fetch(`${base}/v1/companion/${INSTALLATION}/hello`, {
      headers: { Authorization: "Bearer sess" },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "hello from the desk");

    const stranger = await fetch(`${base}/v1/companion/${INSTALLATION}/hello`, {
      headers: { Authorization: "Bearer other" },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(stranger.status, 401);

    ws.close();
    await Promise.race([
      once(ws, "close"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("websocket close timed out")), 2_000)),
    ]).catch(() => {});
    relay.close();
    await waitUntil(() => !relay.registry.has(INSTALLATION));
    const offline = await fetch(`${base}/v1/companion/${INSTALLATION}/hello`, {
      headers: { Authorization: "Bearer sess" },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(offline.status, 503);
  } finally {
    try { ws.terminate(); } catch { /* already closed */ }
    relay.close();
    await new Promise((resolve) => gateway.close(resolve));
    desktopSide.close();
    await new Promise((resolve) => origin.close(resolve));
  }
});

function listenHello() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": 19 });
    res.end("hello from the desk");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function listenDesktop(originServer) {
  const originPort = originServer.address().port;
  const attach = (ws) => {
    const decoder = createFrameDecoder();
    const streams = new Map();
    ws.on("message", (data) => {
      for (const frame of decoder.push(data)) {
        if (frame.type === FRAME.OPEN) {
          const upstream = connectLocal(originPort);
          const pending = [];
          let connected = false;
          let ended = false;
          const stream = {
            write(chunk) {
              if (connected) upstream.write(chunk);
              else pending.push(chunk);
            },
            end() {
              if (connected) upstream.end();
              else ended = true;
            },
            destroy() { upstream.destroy(); },
          };
          streams.set(frame.streamId, stream);
          upstream.on("connect", () => {
            connected = true;
            for (const chunk of pending) upstream.write(chunk);
            pending.length = 0;
            if (ended) upstream.end();
          });
          upstream.on("data", (chunk) => ws.readyState === WebSocket.OPEN && ws.send(encodeFrame(frame.streamId, FRAME.DATA, chunk)));
          upstream.on("end", () => ws.readyState === WebSocket.OPEN && ws.send(encodeFrame(frame.streamId, FRAME.END)));
          upstream.on("error", () => ws.readyState === WebSocket.OPEN && ws.send(encodeFrame(frame.streamId, FRAME.RESET)));
        } else if (frame.type === FRAME.DATA) {
          streams.get(frame.streamId)?.write(frame.payload);
        } else if (frame.type === FRAME.END) {
          streams.get(frame.streamId)?.end();
        } else if (frame.type === FRAME.RESET) {
          streams.get(frame.streamId)?.destroy();
          streams.delete(frame.streamId);
        }
      }
    });
  };
  return { attach, close() {} };
}

function connectLocal(port) {
  return net.connect({ host: "127.0.0.1", port });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
