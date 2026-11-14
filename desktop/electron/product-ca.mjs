// The product service's trust anchor: one public certificate, bound to the
// exact origin the app was packaged for. It travels only in the bundled
// resource (and, for the account capability, in main's private message to the
// runtime); it is never a renderer value, an environment variable, or a
// process-wide TLS setting.
//
// This module is plain Node: the Electron main process, the server child's
// provider code and the packaging scripts all import it.
import { X509Certificate } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import tls from "node:tls";

/** A leaf certificate is about 1.2 KiB; a root about 2 KiB. Anything larger is
 * not a certificate this product ships. */
const MAX_CA_BYTES = 16 * 1024;
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const originOf = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "");

const isIPHost = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");

const namesHost = (certificate, url) => {
  const host = hostOf(url);
  try {
    return isIPHost(host) ? Boolean(certificate.checkIP(host)) : Boolean(certificate.checkHost(host));
  } catch {
    return false;
  }
};

/** True for a certificate that may stand as a trust anchor beside the host it
 * is pinned to: it must name exactly that origin's host, and be either a CA
 * (the handshake's own chain check decides the rest) or the self-signed leaf a
 * local gateway generates. */
function bindsOrigin(certificate, url) {
  if (certificate.ca) return namesHost(certificate, url);
  let selfSigned = false;
  try {
    selfSigned = certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey);
  } catch {
    return false;
  }
  return selfSigned && namesHost(certificate, url);
}

const validNow = (certificate, now) => {
  const from = certificate.validFromDate instanceof Date ? certificate.validFromDate.getTime() : Date.parse(certificate.validFrom);
  const to = certificate.validToDate instanceof Date ? certificate.validToDate.getTime() : Date.parse(certificate.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= now && now < to;
};

/**
 * One canonical PEM certificate, or null. A private key anywhere, several
 * blocks, surrounding text, a malformed or expired certificate, or one bound
 * to another host is refused — never repaired.
 */
export function normalizeProductCa(value, { now = Date.now() } = {}) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < 64 || text.length > MAX_CA_BYTES) return null;
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return null;
  const blocks = text.match(CERTIFICATE_BLOCK);
  if (!blocks || blocks.length !== 1 || text.replace(blocks[0], "").trim() !== "") return null;
  let certificate;
  try {
    certificate = new X509Certificate(blocks[0]);
  } catch {
    return null;
  }
  if (!validNow(certificate, now)) return null;
  return `${blocks[0].trim()}\n`;
}

/** Does this (already normalized) certificate cover exactly this origin? */
export function productCaBindsOrigin(ca, origin) {
  if (typeof ca !== "string" || !ca) return false;
  const url = originOf(origin);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  let certificate;
  try {
    certificate = new X509Certificate(ca);
  } catch {
    return false;
  }
  return bindsOrigin(certificate, url);
}

/** `{ origin, ca }` for a bundled resource, or null when either is wrong. */
export function normalizeProductTrust({ origin, ca, now } = {}) {
  const normalized = normalizeProductCa(ca, now === undefined ? {} : { now });
  if (!normalized || !productCaBindsOrigin(normalized, origin)) return null;
  return { origin, ca: normalized };
}

const defaultRoots = () => {
  // Node 24 (Electron 43) exposes the store; older runtimes fall back to the
  // pinned certificate alone, which is stricter, never looser.
  try {
    return typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : [];
  } catch {
    return [];
  }
};

/**
 * A fetch for one exact HTTPS origin that trusts the pinned certificate *in
 * addition to* the platform roots. Hostname and chain checks stay on, redirects
 * are refused (a 3xx throws, as `redirect: "error"` does), the body streams
 * unchanged, and no other origin is reachable through it. Connections are
 * pooled per transport; nothing global is changed.
 */
export function createPinnedHttpsFetch({ origin, ca } = {}) {
  const url = originOf(origin);
  const certificate = normalizeProductCa(ca);
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || !certificate || !productCaBindsOrigin(certificate, url.origin)) {
    throw new Error("product_trust_invalid");
  }
  const prefix = url.origin;
  const agent = new https.Agent({
    ca: [...defaultRoots(), certificate],
    rejectUnauthorized: true,
    keepAlive: true,
  });
  const pinnedFetch = (input, init = {}) => {
    let target;
    try {
      target = new URL(String(input));
    } catch {
      return Promise.reject(new TypeError("refusing a request outside the pinned product origin"));
    }
    if (target.origin !== prefix || target.username || target.password) {
      return Promise.reject(new TypeError("refusing a request outside the pinned product origin"));
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(abortError());
    const headers = new Headers(init.headers ?? {});
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
      headers.set("content-length", String(Buffer.byteLength(body)));
    }
    return new Promise((resolve, reject) => {
      const request = https.request({
        host: hostOf(target),
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        agent,
      });
      // The signal governs the whole exchange, body included: aborting after
      // the headers still ends a live model stream.
      const onAbort = () => request.destroy(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      const release = () => signal?.removeEventListener("abort", onAbort);
      request.once("error", (error) => {
        release();
        reject(error instanceof Error ? error : new TypeError(String(error)));
      });
      request.once("response", (response) => {
        response.once("close", release);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          release();
          reject(new TypeError("product origin redirected"));
          return;
        }
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const entry of value) replyHeaders.append(name, entry);
          else replyHeaders.set(name, value);
        }
        // The body stays a stream: a model reply is read as SSE, and buffering
        // it would delay every token to the end of the turn.
        if (status === 204 || status === 304) response.resume();
        const bodyStream = status === 204 || status === 304 ? null : Readable.toWeb(response);
        resolve(new Response(bodyStream, { status, headers: replyHeaders }));
      });
      if (body !== undefined) request.write(body);
      request.end();
    });
  };
  pinnedFetch.close = () => {
    agent.destroy();
  };
  return pinnedFetch;
}

const abortError = () => {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};
