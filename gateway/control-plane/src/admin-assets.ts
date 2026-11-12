import { adminHTML } from "./admin-html";
import { adminScript } from "./admin-script";
import { adminStyle } from "./admin-style";

const assets: Record<string, [string, string]> = {
  "/admin": [adminHTML, "text/html; charset=utf-8"],
  "/admin/": [adminHTML, "text/html; charset=utf-8"],
  "/admin/app.js": [adminScript, "text/javascript; charset=utf-8"],
  "/admin/style.css": [adminStyle, "text/css; charset=utf-8"],
};

/** Public shell only; every data route independently enforces operator access. */
export function routeAdminAssets(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  const asset = assets[path];
  if (!asset) return null;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": asset[1],
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  return new Response(request.method === "HEAD" ? null : asset[0], { headers });
}
