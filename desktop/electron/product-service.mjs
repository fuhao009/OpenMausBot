import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeProductTrust } from "./product-ca.mjs";

export function validateProductOrigin(value, { allowLoopback = false } = {}) {
  if (typeof value !== "string" || !value) throw new Error("product_service_invalid");
  let url;
  try { url = new URL(value); } catch { throw new Error("product_service_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))) {
    throw new Error("product_service_invalid");
  }
  return url.origin;
}

/**
 * The bundled resource. Version 1 pins the origin alone and relies on the
 * operating system's trust store; version 2 adds the public certificate of
 * that exact origin, so a deployment whose certificate no system trusts (the
 * local gateway) is verified without importing anything. The certificate must
 * cover the origin's own host, and the keys are exact: a copied or hand-edited
 * resource can never apply one deployment's certificate to another origin.
 */
function readResource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product_service_invalid");
  if (value.version === 1) {
    if (Object.keys(value).some((key) => !["version", "origin"].includes(key))) throw new Error("product_service_invalid");
    return { origin: validateProductOrigin(value.origin), ca: null };
  }
  if (value.version === 2) {
    if (Object.keys(value).some((key) => !["version", "origin", "ca"].includes(key))) throw new Error("product_service_invalid");
    const origin = validateProductOrigin(value.origin);
    const trust = normalizeProductTrust({ origin, ca: value.ca });
    if (!trust) throw new Error("product_service_invalid_ca");
    return trust;
  }
  throw new Error("product_service_invalid");
}

export async function resolveProductService({ isPackaged, appPath, resourcesPath, environment = process.env, fixtureOrigin }) {
  if (isPackaged) {
    const metadata = JSON.parse(await readFile(path.join(appPath, "package.json"), "utf8"));
    if (metadata.ombProductManaged !== true) return null;
    let resource;
    try { resource = JSON.parse(await readFile(path.join(resourcesPath, "product-service.json"), "utf8")); }
    catch { throw new Error("product_service_missing"); }
    let bundled;
    try { bundled = readResource(resource); }
    catch (error) { throw new Error(error?.message === "product_service_invalid_ca" ? "product_service_invalid_ca" : "product_service_invalid"); }
    // The isolated fixture may name a disposable Worker on loopback. Its
    // pinned certificate applies only to the exact origin it was bundled for;
    // a different origin gets the system trust store and nothing borrowed.
    if (fixtureOrigin) {
      const origin = validateProductOrigin(fixtureOrigin, { allowLoopback: true });
      return origin === bundled.origin
        ? { origin, ca: bundled.ca, managed: true }
        : { origin, ca: null, managed: true };
    }
    return { origin: bundled.origin, ca: bundled.ca, managed: true };
  }
  if (!environment.OMB_PRODUCT_SERVICE_URL) return null;
  return { origin: validateProductOrigin(environment.OMB_PRODUCT_SERVICE_URL, { allowLoopback: true }), ca: null, managed: true };
}
