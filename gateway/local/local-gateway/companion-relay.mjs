// The local gateway's companion data plane: a phone that has signed in with
// the same Hezuo account as a desktop talks to this process, which forwards
// the raw HTTP (including SSE and WebSocket upgrades) to that desktop over a
// desktop-initiated WebSocket tunnel. Nothing here talks to Cloudflare or
// Tailscale. Account and installation checks reuse the Worker's own routes.
import { createServer as createHttpsServer } from "node:https";
import { Readable } from "node:stream";
import tls from "node:tls";
import { WebSocketServer, WebSocket } from "ws";
import { COMPANION_RELAY_PATH, FRAME, createFrameDecoder, encodeFrame } from "../../../desktop/electron/companion-relay-frames.mjs";

export { COMPANION_RELAY_PATH, FRAME, createFrameDecoder, encodeFrame };

export const COMPANION_PREFIX = "/v1/companion/";
export const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESKTOP_PLATFORMS = new Set(["darwin", "windows", "linux"]);

export function companionPathFor(installationId) {
  if (!INSTALLATION_ID.test(installationId)) return null;
  return `${COMPANION_PREFIX}${installationId.toLowerCase()}`;
}

export function parseCompanionRequestPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith(COMPANION_PREFIX)) return null;
  const rest = pathname.slice(COMPANION_PREFIX.length);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  if (!INSTALLATION_ID.test(id)) return null;
  const suffix = slash === -1 ? "/" : rest.slice(slash);
  if (!suffix.startsWith("/") || suffix.includes("\\") || suffix.includes("\0")) return null;
  return { installationId: id.toLowerCase(), path: suffix || "/" };
}

export function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function accountDeviceId(userId) {
  if (typeof userId !== "string" || !userId) return null;
  const compact = userId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 110);
  if (!compact) return null;
  return `account-${compact}`;
}


async function readJSON(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function installationFromCredential(workerFetch, token) {
  if (!token) return null;
  const response = await workerFetch("/v1/installations/self", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`installation lookup failed (${response.status})`);
  const payload = await readJSON(response);
  const installation = payload?.installation;
  if (!installation || !INSTALLATION_ID.test(installation.id)) return null;
  if (!DESKTOP_PLATFORMS.has(installation.platform)) return null;
  return {
    id: String(installation.id).toLowerCase(),
    platform: installation.platform,
    name: typeof installation.name === "string" ? installation.name : "",
  };
}

export async function accountOwnsDesktop(workerFetch, token, installationId) {
  if (!token || !INSTALLATION_ID.test(installationId)) return null;
  const [meResponse, listResponse] = await Promise.all([
    workerFetch("/v1/me", { headers: { authorization: `Bearer ${token}` } }),
    workerFetch("/v1/installations", { headers: { authorization: `Bearer ${token}` } }),
  ]);
  if (meResponse.status === 401 || meResponse.status === 403) return null;
  if (listResponse.status === 401 || listResponse.status === 403) return null;
  if (!meResponse.ok || !listResponse.ok) throw new Error("account lookup failed");
  const me = await readJSON(meResponse);
  const list = await readJSON(listResponse);
  const userId = me?.user?.id;
  const email = me?.user?.email;
  if (typeof userId !== "string" || !userId) return null;
  const wanted = installationId.toLowerCase();
  const match = (list?.installations ?? []).find((item) =>
    item && String(item.id).toLowerCase() === wanted && DESKTOP_PLATFORMS.has(item.platform)
  );
  if (!match) return null;
  return { userId, email: typeof email === "string" ? email : "", installationId: wanted };
}

/** In-memory map of live desktop tunnels. One process, one isolate. */
export function createRelayRegistry() {
  const desktops = new Map();
  let nextStream = 1;

  const forget = (installationId, socket) => {
    const current = desktops.get(installationId);
    if (current?.socket === socket) desktops.delete(installationId);
  };

  return {
    attach(installationId, socket) {
      const previous = desktops.get(installationId);
      if (previous && previous.socket !== socket) {
        try { previous.socket.close(4000, "replaced"); } catch { /* already gone */ }
      }
      const session = { socket, streams: new Map() };
      desktops.set(installationId, session);
      socket.once("close", () => forget(installationId, socket));
      socket.once("error", () => forget(installationId, socket));
      return session;
    },
    has(installationId) {
      const session = desktops.get(installationId);
      return Boolean(session && session.socket.readyState === WebSocket.OPEN);
    },
    list() {
      return [...desktops.keys()].filter((id) => this.has(id));
    },
    session(installationId) {
      const session = desktops.get(installationId);
      if (!session || session.socket.readyState !== WebSocket.OPEN) return null;
      return session;
    },
    allocateStreamId() {
      const id = nextStream;
      nextStream = nextStream + 1 > 0xffffffff ? 1 : nextStream + 1;
      return id;
    },
    closeAll() {
      for (const [id, session] of desktops) {
        try { session.socket.close(1001, "gateway stopping"); } catch { /* already gone */ }
        desktops.delete(id);
      }
    },
  };
}

function writeSocket(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("desktop relay is not connected");
  socket.send(frame);
}

/**
 * Pipe one incoming HTTP request through a live desktop tunnel and write the
 * raw upstream response (status line, headers, body, or an upgraded stream)
 * back to the phone.
 */
export function openRelayStream(session) {
  const id = session.streamId ?? session.registry.allocateStreamId();
  const desktop = session.socket;
  const decoder = createFrameDecoder();
  const listeners = new Set();
  const queued = [];
  let closed = false;

  const emit = (type, payload) => {
    if (listeners.size === 0) {
      queued.push([type, payload]);
      return;
    }
    for (const listener of listeners) listener(type, payload);
  };

  const onMessage = (data) => {
    try {
      for (const frame of decoder.push(data)) {
        if (frame.streamId !== id) continue;
        if (frame.type === FRAME.DATA) emit("data", frame.payload);
        else if (frame.type === FRAME.END) { closed = true; emit("end"); cleanup(); }
        else if (frame.type === FRAME.RESET) { closed = true; emit("reset"); cleanup(); }
      }
    } catch (error) {
      closed = true;
      emit("error", error);
      cleanup();
    }
  };

  const cleanup = () => {
    desktop.off("message", onMessage);
    desktop.off("close", onClose);
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    emit("reset");
    cleanup();
  };
  desktop.on("message", onMessage);
  desktop.once("close", onClose);

  writeSocket(desktop, encodeFrame(id, FRAME.OPEN));

  return {
    streamId: id,
    write(chunk) {
      if (closed) return;
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (body.length) writeSocket(desktop, encodeFrame(id, FRAME.DATA, body));
    },
    end() {
      if (closed) return;
      closed = true;
      try { writeSocket(desktop, encodeFrame(id, FRAME.END)); } catch { /* desktop gone */ }
    },
    reset() {
      if (closed) return;
      closed = true;
      try { writeSocket(desktop, encodeFrame(id, FRAME.RESET)); } catch { /* desktop gone */ }
      cleanup();
    },
    on(listener) {
      listeners.add(listener);
      const pending = queued.splice(0);
      for (const event of pending) listener(...event);
      return () => listeners.delete(listener);
    },
  };
}

/** Collect the first HTTP response head from a relay stream, then leave the
 * remainder of the body for the caller. */
export function waitForHttpHead(stream, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => finish(new Error("desktop response timed out")), timeoutMs);
    const off = stream.on((type, payload) => {
      if (type === "data") {
        chunks.push(payload);
        const buffered = Buffer.concat(chunks);
        const split = buffered.indexOf("\r\n\r\n");
        if (split !== -1) {
          chunks.length = 0;
          finish(null, { header: buffered.subarray(0, split + 4), rest: buffered.subarray(split + 4) });
        }
      } else if (type === "end") {
        finish(null, chunks.length ? { header: Buffer.concat(chunks), rest: Buffer.alloc(0), incomplete: true } : null);
      } else if (type === "reset" || type === "error") {
        finish(payload instanceof Error ? payload : new Error("desktop relay reset"));
      }
    });
    function finish(error, value) {
      clearTimeout(timer);
      off();
      if (error) reject(error);
      else resolve(value);
    }
  });
}

function requestHead(req, pathWithQuery) {
  const headers = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    // The desktop sees a direct companion request; hop-by-hop and the
    // gateway's own host must not travel.
    if (key === "host" || key === "connection" || key === "upgrade" ||
        key === "proxy-connection" || key === "keep-alive" ||
        key === "transfer-encoding" || key === "te" || key === "trailer") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) headers.push(`${name}: ${entry}`);
    } else {
      headers.push(`${name}: ${value}`);
    }
  }
  const host = req.headers.host ? String(req.headers.host) : "companion";
  headers.unshift(`Host: ${host}`);
  if (req.headers.upgrade) headers.push(`Upgrade: ${req.headers.upgrade}`);
  if (req.headers.connection) headers.push(`Connection: ${req.headers.connection}`);
  return Buffer.from(
    `${req.method ?? "GET"} ${pathWithQuery} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
  );
}

function parseRawHttpHead(buffer) {
  const text = buffer.toString("latin1");
  const match = /^HTTP\/\d+\.\d+ (\d{3})[^\r\n]*\r\n/.exec(text);
  if (!match) return null;
  const headerEnd = buffer.indexOf("\r\n\r\n");
  const rawHeaders = headerEnd === -1 ? text : buffer.subarray(0, headerEnd).toString("latin1");
  const lines = rawHeaders.split("\r\n").slice(1);
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    if (headers[name] === undefined) headers[name] = value;
    else if (Array.isArray(headers[name])) headers[name].push(value);
    else headers[name] = [headers[name], value];
  }
  return { status: Number(match[1]), headers };
}

export function createCompanionRelay({ workerFetch, registry = createRelayRegistry() } = {}) {
  if (typeof workerFetch !== "function") throw new Error("workerFetch is required");

  const handleDesktop = async (req, socket, head) => {
    const token = bearerToken(String(req.headers.authorization ?? ""));
    let installation;
    try {
      installation = await installationFromCredential(workerFetch, token);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!installation) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.attach(installation.id, ws);
    });
  };

  const reject = (res, status, code) => {
    const body = JSON.stringify({ error: { code, message: code } });
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  const readRequestBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  const handlePhone = async (req, res, parsed) => {
    const token = bearerToken(String(req.headers.authorization ?? ""));
    let owner;
    try {
      owner = await accountOwnsDesktop(workerFetch, token, parsed.installationId);
    } catch {
      reject(res, 502, "gateway_unavailable");
      return;
    }
    if (!owner) {
      reject(res, 401, "unauthorized");
      return;
    }
    const session = registry.session(parsed.installationId);
    if (!session) {
      reject(res, 503, "desktop_offline");
      return;
    }
    const url = new URL(req.url ?? "/", "https://companion.invalid");
    const pathWithQuery = `${parsed.path}${url.search}`;
    let body;
    try {
      body = await readRequestBody(req);
    } catch {
      reject(res, 413, "request_too_large");
      return;
    }
    const stream = openRelayStream({ socket: session.socket, registry });
    try {
      stream.write(Buffer.concat([requestHead(req, pathWithQuery), body]));
      stream.end();
      const first = await waitForHttpHead(stream);
      if (!first || first.incomplete) {
        if (!res.headersSent) reject(res, 502, "desktop_unavailable");
        stream.reset();
        return;
      }
      const parsedHead = parseRawHttpHead(first.header);
      if (!parsedHead) {
        if (!res.headersSent) reject(res, 502, "desktop_unavailable");
        stream.reset();
        return;
      }
      const headers = { ...parsedHead.headers };
      delete headers.connection;
      delete headers["transfer-encoding"];
      delete headers["keep-alive"];
      delete headers.upgrade;
      res.writeHead(parsedHead.status, headers);
      let written = 0;
      const expected = Number(headers["content-length"]);
      const writeBody = (chunk) => {
        if (!chunk?.length || res.writableEnded) return;
        res.write(chunk);
        written += chunk.length;
        if (Number.isFinite(expected) && written >= expected && !res.writableEnded) res.end();
      };
      writeBody(first.rest);
      if (!res.writableEnded) {
        await new Promise((resolve, rejectWrite) => {
          const off = stream.on((type, payload) => {
            if (type === "data") writeBody(payload);
            if (type === "end" || type === "reset" || type === "error") {
              off();
              if (!res.writableEnded) res.end();
              resolve();
            }
            if (res.writableEnded) {
              off();
              resolve();
            }
          });
          if (res.writableEnded) {
            off();
            resolve();
            return;
          }
          res.on("error", (error) => {
            off();
            stream.reset();
            rejectWrite(error);
          });
        });
      }
    } catch {
      stream.reset();
      if (!res.headersSent) reject(res, 502, "desktop_unavailable");
    }
  };

  return {
    registry,
    isRelayUpgrade(pathname) {
      return pathname === COMPANION_RELAY_PATH;
    },
    parse: parseCompanionRequestPath,
    async handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "https://companion.invalid");
      if (url.pathname === COMPANION_RELAY_PATH) {
        await handleDesktop(req, socket, head);
        return true;
      }
      const parsed = parseCompanionRequestPath(url.pathname);
      if (!parsed) return false;
      // A phone WebSocket upgrade is just HTTP on the same tunnel.
      const token = bearerToken(String(req.headers.authorization ?? ""));
      let owner;
      try {
        owner = await accountOwnsDesktop(workerFetch, token, parsed.installationId);
      } catch {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      if (!owner) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      const session = registry.session(parsed.installationId);
      if (!session) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      const pathWithQuery = `${parsed.path}${url.search}`;
      const stream = openRelayStream({ socket: session.socket, registry });
      const prelude = Buffer.concat([
        requestHead(req, pathWithQuery),
        Buffer.isBuffer(head) ? head : Buffer.from(head ?? []),
      ]);
      stream.write(prelude);
      socket.on("data", (chunk) => stream.write(chunk));
      socket.on("end", () => stream.end());
      socket.on("close", () => stream.reset());
      try {
        const first = await waitForHttpHead(stream);
        if (!first) {
          socket.destroy();
          return true;
        }
        socket.write(Buffer.concat([first.header, first.rest]));
        stream.on((type, payload) => {
          if (type === "data") {
            if (!socket.destroyed) socket.write(payload);
          } else if (type === "end") {
            if (!socket.destroyed) socket.end();
          } else if (type === "reset" || type === "error") {
            if (!socket.destroyed) socket.destroy();
          }
        });
      } catch {
        stream.reset();
        socket.destroy();
      }
      return true;
    },
    async handleRequest(req, res) {
      const url = new URL(req.url ?? "/", "https://companion.invalid");
      const parsed = parseCompanionRequestPath(url.pathname);
      if (!parsed) return false;
      await handlePhone(req, res, parsed);
      return true;
    },
    close() {
      registry.closeAll();
    },
  };
}

function appendHeader(headers, name, value) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) headers.append(name, entry);
  } else {
    headers.set(name, String(value));
  }
}

export async function dispatchIncoming(dispatchFetch, origin, req) {
  const target = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === "host") {
      headers.set("host", new URL(origin).host);
      continue;
    }
    appendHeader(headers, name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  // Miniflare's dispatchFetch builds its own undici Request and rejects a Request from Node's global fetch.
  return dispatchFetch(target.href, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });
}

export async function writeFetchResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name === "transfer-encoding") return;
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let disconnected = res.destroyed;
  const closed = () => { disconnected = true; };
  res.once("close", closed);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!disconnected && !res.write(value)) {
        await new Promise((resolve) => {
          const resume = () => { res.off("drain", resume); res.off("close", resume); resolve(); };
          res.once("drain", resume);
          res.once("close", resume);
        });
      }
    }
    if (!disconnected) res.end();
  } finally {
    res.off("close", closed);
    reader.releaseLock();
  }
}

/**
 * HTTPS front for the public origin: companion relay first, everything else
 * goes to the Worker through dispatchFetch. The Worker's TLS listener can
 * stay on loopback.
 */
export function createGatewayFront({
  origin,
  host,
  port,
  cert,
  key,
  dispatchFetch,
  relay,
}) {
  if (typeof dispatchFetch !== "function") throw new Error("dispatchFetch is required");
  const server = createHttpsServer({
    cert,
    key,
    minVersion: "TLSv1.2",
  }, (req, res) => {
    void (async () => {
      try {
        if (await relay.handleRequest(req, res)) return;
        const response = await dispatchIncoming(dispatchFetch, origin, req);
        await writeFetchResponse(res, response);
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: { code: "gateway_unavailable", message: "gateway_unavailable" } }));
      }
    })();
  });
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        if (await relay.handleUpgrade(req, socket, head)) return;
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
      } catch {
        socket.destroy();
      }
    })();
  });
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen({ host, port, exclusive: true }, () => {
          server.off("error", onError);
          resolve(server);
        });
      });
    },
    close() {
      relay.close();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export { createHttpsServer, tls };
