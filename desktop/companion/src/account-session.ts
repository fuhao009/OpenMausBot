// A Hezuo account session presented by a phone is enough to use this
// companion: the desktop already signed into the same account on the local
// gateway. The trust file names that account; tokens are verified with /v1/me.
// Cloud-desktop and browser-control grants stay off — those are still explicit.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

import type { DeviceRecord } from "./devices.ts";

export interface ProductAccountTrust {
  origin: string;
  ca: string;
  userId: string;
}

const MAX_CACHE = 64;
const CACHE_TTL_MS = 30_000;

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readProductAccountTrust(file: string | undefined): ProductAccountTrust | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProductAccountTrust>;
    const origin = new URL(String(parsed.origin ?? ""));
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) return null;
    const ca = String(parsed.ca ?? "").trim();
    const userId = String(parsed.userId ?? "").trim();
    if (!ca || !userId || userId.length > 256) return null;
    new X509Certificate(ca);
    return { origin: origin.origin, ca, userId };
  } catch {
    return null;
  }
}

export function accountDeviceId(userId: string): string {
  const compact = userId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 110);
  return `account-${compact || "user"}`;
}

function pinnedGet(trust: ProductAccountTrust, path: string, token: string): Promise<{ status: number; body: unknown }> {
  const target = new URL(path, trust.origin);
  const ca = [...(typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : []), trust.ca];
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      ca,
      servername: target.hostname.replace(/^\[|\]$/g, ""),
      rejectUnauthorized: true,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export function createAccountAuthenticator(options: {
  trust: () => ProductAccountTrust | null;
  now?: () => number;
  fetchMe?: (trust: ProductAccountTrust, token: string) => Promise<{ status: number; body: unknown }>;
}): (token: string | undefined) => Promise<DeviceRecord | null> {
  const cache = new Map<string, { device: DeviceRecord; expiresAt: number }>();
  const now = options.now ?? Date.now;
  const fetchMe = options.fetchMe ?? ((trust, token) => pinnedGet(trust, "/v1/me", token));

  return async (token) => {
    if (!token) return null;
    const trust = options.trust();
    if (!trust) return null;
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.device;
    let response: { status: number; body: unknown };
    try {
      response = await fetchMe(trust, token);
    } catch {
      return cached?.device ?? null;
    }
    if (response.status === 401 || response.status === 403) {
      cache.delete(key);
      return null;
    }
    if (response.status < 200 || response.status >= 300) return cached?.device ?? null;
    const user = (response.body as { user?: { id?: string; email?: string } } | null)?.user;
    if (!user?.id || !same(String(user.id), trust.userId)) return null;
    const stamp = now();
    const device: DeviceRecord = {
      id: accountDeviceId(user.id),
      name: "Signed-in phone",
      tokenHash: key,
      createdAt: stamp,
      lastSeenAt: stamp,
      cloudDesktopAccess: false,
      browserControlAccess: false,
    };
    cache.set(key, { device, expiresAt: stamp + CACHE_TTL_MS });
    if (cache.size > MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return device;
  };
}
