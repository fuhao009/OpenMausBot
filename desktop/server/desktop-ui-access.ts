import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { fromBrowser, fromOwnPage, parseCookies } from "./request-auth.ts";

export function desktopUiAccessAllowed(req: IncomingMessage, options: {
  ownerToken: string | undefined;
  cookieName: string;
  url: URL;
  oauthCallbackPath: string;
}): boolean {
  if (options.ownerToken === undefined) return true;
  const path = options.url.pathname;
  const method = req.method ?? "GET";
  if (path === options.oauthCallbackPath || path.startsWith("/api/internal/") || path.startsWith("/.well-known/")) return true;
  if (method === "GET" && (path === "/api/health" || path === "/api/brand")) return true;

  const api = path.startsWith("/api/");
  const browserSession = parseCookies(req.headers.cookie).has(options.cookieName) ||
    (path === "/api/events" && options.url.searchParams.has("ticket"));
  if (api && !fromBrowser(req) && !browserSession) return true;

  // Static UI never inherits loopback or session trust, including before the desktop bootstrap.
  const actual = req.headers["x-hezuo-desktop-owner"];
  if (typeof actual !== "string" || !actual || !options.ownerToken || !fromOwnPage(req)) return false;
  const presented = Buffer.from(actual);
  const expected = Buffer.from(options.ownerToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
