// Desktop side of the local-gateway companion relay: one WebSocket back to
// the account gateway, with each multiplexed stream copied onto the private
// companion origin (the same socket cloudflared used to target). No Cloudflare
// token, no Tailscale name, and no credential in argv or the environment.
import net from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createPinnedHttpsFetch, normalizeProductTrust } from "./product-ca.mjs";
import {
  FRAME,
  COMPANION_RELAY_PATH,
  createFrameDecoder,
  encodeFrame,
} from "../scripts/local-gateway/companion-relay.mjs";
import { validCompanionOriginTarget } from "./companion-origin-gateway.mjs";

const DEFAULT_MAX_RETRY_MS = 30_000;

export function companionUrlFor(origin, installationId) {
  const base = new URL(origin);
  return new URL(`/v1/companion/${installationId}`, base).origin + `/v1/companion/${installationId}`;
}

function originConnect(target) {
  if (!validCompanionOriginTarget(target)) {
    throw new Error("The companion origin target is invalid");
  }
  return net.connect({ path: target.socketPath });
}

function writeFrame(socket, streamId, type, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeFrame(streamId, type, payload));
}

function attachStream(socket, streamId, target) {
  const upstream = originConnect(target);
  let closed = false;
  const close = (reset = false) => {
    if (closed) return;
    closed = true;
    if (reset) writeFrame(socket, streamId, FRAME.RESET);
    else writeFrame(socket, streamId, FRAME.END);
    upstream.destroy();
  };
  upstream.on("data", (chunk) => writeFrame(socket, streamId, FRAME.DATA, chunk));
  upstream.on("end", () => close(false));
  upstream.on("error", () => close(true));
  upstream.on("close", () => {
    if (!closed) close(false);
  });
  return {
    write(chunk) {
      if (!closed) upstream.write(chunk);
    },
    end() {
      if (!closed) upstream.end();
    },
    reset() {
      close(true);
    },
  };
}

export function createGatewayCompanionTunnel({
  origin,
  ca,
  installationId,
  credential,
  originTarget,
  WebSocketImpl = WebSocket,
  connectOrigin = originConnect,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
  onChange = () => {},
  log = () => {},
} = {}) {
  const trust = normalizeProductTrust({ origin, ca });
  if (!trust) throw new Error("product_trust_invalid");
  if (!credential) throw new Error("installation credential required");
  const endpoint = companionUrlFor(trust.origin, installationId);
  const relayURL = new URL(COMPANION_RELAY_PATH, trust.origin).href;

  let desired = false;
  let generation = 0;
  let socket = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let state = Object.freeze({ status: "stopped", ready: false, configured: true, endpoint });
  let transition = Promise.resolve();
  const streams = new Map();

  const publish = (next) => {
    state = Object.freeze({
      configured: true,
      endpoint,
      ready: next.status === "ready",
      ...next,
    });
    onChange(state);
    return state;
  };

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(() => {}, () => {});
    return next;
  };

  const dropStreams = () => {
    for (const stream of streams.values()) {
      try { stream.reset(); } catch { /* already closed */ }
    }
    streams.clear();
  };

  const disconnect = () => {
    const current = socket;
    socket = null;
    dropStreams();
    if (current) {
      try { current.close(); } catch { /* already closed */ }
      current.terminate?.();
    }
  };

  const scheduleRetry = (reason, ownedGeneration) => {
    if (!desired || ownedGeneration !== generation || retryTimer) return;
    const delay = Math.min(1_000 * 2 ** retryAttempt, maxRetryMs);
    retryAttempt += 1;
    publish({ status: "retrying", ready: false, error: reason, retryInMs: delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!desired || ownedGeneration !== generation) return;
      void serialize(() => connect(ownedGeneration));
    }, delay);
    retryTimer.unref?.();
  };

  const connect = async (ownedGeneration) => {
    if (!desired || ownedGeneration !== generation) return state;
    if (!validCompanionOriginTarget(originTarget)) {
      return publish({
        status: "unavailable",
        ready: false,
        error: "The companion origin is missing from this launch.",
      });
    }
    publish({ status: "starting", ready: false });
    disconnect();
    const headers = { Authorization: `Bearer ${credential}` };
    const pinned = createPinnedHttpsFetch({ origin: trust.origin, ca: trust.ca });
    // ws does not take a fetch hook; pin the gateway certificate through
    // the custom TLS options used for this origin only.
    const ws = new WebSocketImpl(relayURL, {
      headers,
      rejectUnauthorized: true,
      ca: [trust.ca],
      servername: new URL(trust.origin).hostname.replace(/^\[|\]$/g, ""),
    });
    socket = ws;
    const decoder = createFrameDecoder();
    const opened = new Promise((resolve, reject) => {
      const fail = (error) => {
        ws.off("open", onOpen);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onOpen = () => {
        ws.off("error", fail);
        resolve();
      };
      ws.once("open", onOpen);
      ws.once("error", fail);
    });
    try {
      await opened;
    } catch (error) {
      pinned.close?.();
      if (!desired || ownedGeneration !== generation) return state;
      scheduleRetry(error instanceof Error ? error.message : "The secure connection could not start.", ownedGeneration);
      return state;
    }
    pinned.close?.();
    if (!desired || ownedGeneration !== generation) {
      disconnect();
      return state;
    }
    retryAttempt = 0;
    ws.on("message", (data) => {
      let frames;
      try { frames = decoder.push(data); }
      catch (error) {
        log("gateway companion tunnel: frame error");
        ws.close();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME.OPEN) {
          if (streams.has(frame.streamId)) {
            streams.get(frame.streamId).reset();
          }
          try {
            streams.set(frame.streamId, attachStreamWith(connectOrigin, ws, frame.streamId, originTarget));
          } catch {
            writeFrame(ws, frame.streamId, FRAME.RESET);
          }
        } else if (frame.type === FRAME.DATA) {
          streams.get(frame.streamId)?.write(frame.payload);
        } else if (frame.type === FRAME.END) {
          const stream = streams.get(frame.streamId);
          streams.delete(frame.streamId);
          stream?.end();
        } else if (frame.type === FRAME.RESET) {
          const stream = streams.get(frame.streamId);
          streams.delete(frame.streamId);
          stream?.reset();
        }
      }
    });
    ws.on("close", () => {
      if (socket === ws) socket = null;
      dropStreams();
      if (desired && ownedGeneration === generation) {
        scheduleRetry("The secure connection stopped unexpectedly.", ownedGeneration);
      }
    });
    ws.on("error", () => {});
    return publish({ status: "ready", ready: true });
  };

  return {
    getStatus() {
      return state;
    },
    start(nextTarget) {
      if (nextTarget) originTarget = nextTarget.originTarget ?? nextTarget;
      desired = true;
      generation += 1;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const owned = generation;
      return serialize(() => connect(owned));
    },
    async stop() {
      desired = false;
      generation += 1;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      return serialize(async () => {
        disconnect();
        return publish({ status: "stopped", ready: false });
      });
    },
  };
}

function attachStreamWith(connectOrigin, socket, streamId, target) {
  const upstream = connectOrigin(target);
  let closed = false;
  let connected = false;
  const queue = [];
  let endAfterConnect = false;
  const close = (reset = false) => {
    if (closed) return;
    closed = true;
    if (reset) writeFrame(socket, streamId, FRAME.RESET);
    else writeFrame(socket, streamId, FRAME.END);
    upstream.destroy();
  };
  upstream.on("connect", () => {
    connected = true;
    for (const chunk of queue) upstream.write(chunk);
    queue.length = 0;
    if (endAfterConnect && !closed) upstream.end();
  });
  upstream.on("data", (chunk) => writeFrame(socket, streamId, FRAME.DATA, chunk));
  upstream.on("end", () => close(false));
  upstream.on("error", () => close(true));
  upstream.on("close", () => {
    if (!closed) close(false);
  });
  return {
    write(chunk) {
      if (closed) return;
      if (connected) upstream.write(chunk);
      else queue.push(chunk);
    },
    end() {
      if (closed) return;
      if (connected) upstream.end();
      else endAfterConnect = true;
    },
    reset() {
      close(true);
    },
  };
}

export { randomUUID };
