import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { desktopUiAccessAllowed } from "./desktop-ui-access.ts";

const ownerToken = "desktop-owner-secret";
const cookieName = "omb_session_test";
const owner = { "x-hezuo-desktop-owner": ownerToken };
const browser = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" };
function allowed(path: string, headers: IncomingHttpHeaders = {}, method = "GET", token: string | null = ownerToken): boolean {
  return desktopUiAccessAllowed({ method, headers: { host: "127.0.0.1:8799", ...headers } } as IncomingMessage, {
    ownerToken: token ?? undefined, cookieName, url: new URL(path, "http://127.0.0.1:8799"), oauthCallbackPath: "/mcp-oauth/callback",
  });
}

describe("managed desktop UI access", () => {
  it("requires the actual owner header for every static page, SPA path and asset, for every method", () => {
    for (const path of ["/", "/settings", "/pair", "/rail", "/assets/app.js", "/favicon.ico", "/api"]) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        for (const headers of [{}, browser, { "user-agent": "Hezuo Electron" }, { cookie: `${cookieName}=valid-session` }, { "x-hezuo-desktop-owner": "wrong" }]) {
          expect(allowed(path, headers, method), `${method} ${path}`).toBe(false);
        }
        expect(allowed(path, owner, method), `${method} ${path}`).toBe(true);
      }
    }
  });

  it("denies before bootstrap and rejects malformed or nonmatching owner headers", () => {
    expect(allowed("/", {}, "GET", "")).toBe(false);
    expect(allowed("/", { "x-hezuo-desktop-owner": "" }, "GET", "")).toBe(false);
    expect(allowed("/", owner, "GET", "")).toBe(false);
    for (const value of ["desktop-owner-secreu", "desktop-owner-secret-extra", [ownerToken, ownerToken]]) {
      expect(allowed("/", { "x-hezuo-desktop-owner": value })).toBe(false);
    }
  });

  it("does not let another page use an owner header attached by the desktop session", () => {
    expect(allowed("/", { ...owner, ...browser })).toBe(true);
    expect(allowed("/", { ...owner, "sec-fetch-site": "none", "sec-fetch-dest": "document" })).toBe(true);
    expect(allowed("/", { ...owner, ...browser, origin: "https://outside.example" })).toBe(false);
    expect(allowed("/", { ...owner, "sec-fetch-site": "cross-site" })).toBe(false);
  });

  it("closes browser API, cookie and stream-ticket access before ordinary session authentication", () => {
    for (const path of ["/api/bots", "/api/auth/pair", "/api/auth/email/start", "/api/events"]) {
      for (const headers of [browser, { cookie: `${cookieName}=valid-session` }, { ...browser, authorization: "Bearer omb_sess_valid" }]) {
        expect(allowed(path, headers)).toBe(false);
        expect(allowed(path, { ...headers, ...owner })).toBe(true);
      }
    }
    expect(allowed("/api/events?ticket=valid")).toBe(false);
    expect(allowed("/api/events?ticket=")).toBe(false);
    expect(allowed("/api/events?ticket=valid", owner)).toBe(true);
    expect(allowed("/api/bots", { upgrade: "websocket", origin: "http://127.0.0.1:8799" })).toBe(false);
  });

  it("preserves native APIs, bearer clients, companion traffic and capability endpoints", () => {
    for (const headers of [{}, { authorization: "Bearer omb_sess_native" }, { "x-hezuo-companion-auth": "relay", "x-hezuo-companion": "1" }, { "sec-fetch-mode": "cors" }]) {
      expect(allowed("/api/bots", headers)).toBe(true);
    }
    expect(allowed("/api/internal/browser/mcp", browser, "POST")).toBe(true);
    expect(allowed("/api/internal/computer-control", browser, "POST")).toBe(true);
    expect(allowed("/api/internal-not-real", browser)).toBe(false);
  });

  it("preserves explicit discovery and state-authenticated callback routes", () => {
    for (const path of ["/api/health", "/api/brand", "/.well-known/hezuo/environment", "/mcp-oauth/callback?state=one-time"]) {
      expect(allowed(path, browser)).toBe(true);
    }
    expect(allowed("/api/health", browser, "POST")).toBe(false);
    expect(allowed("/api/brand", browser, "POST")).toBe(false);
    expect(allowed("/mcp-oauth/callback/extra", browser)).toBe(false);
  });

  it("leaves non-desktop deployments unchanged", () => {
    for (const path of ["/", "/assets/app.js", "/api/bots", "/api/events?ticket=valid"]) {
      expect(allowed(path, { ...browser, cookie: `${cookieName}=valid-session` }, "GET", null)).toBe(true);
    }
  });
});
