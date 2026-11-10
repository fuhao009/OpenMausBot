// Shared release identity helpers for the managed product build: the values
// that must agree between the wrapper that writes electron-builder's config,
// the bundled resource the desktop pins, and the after-pack gate that fails
// the build before signing.
import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeProductCa, productCaBindsOrigin } from "../electron/product-ca.mjs";
import { validateProductOrigin } from "../electron/product-service.mjs";

export const PRODUCT_NAME = "Hezuo";
export const PRODUCT_APP_ID = "com.hezuo.product";
export const PRODUCT_PROTOCOL = "hezuo-product";
export const PRODUCT_ARTIFACT_PREFIX = "Hezuo";
export const PRODUCT_SERVICE_RESOURCE = "product-service.json";

/** Domains owned by the upstream open-source project. A product build must
 * never point at them: its operator owns a different service. */
export const AUTHOR_DOMAINS = ["openmausbot.com", "hezuo.si"];

/** Names that can never identify the operator's service: the RFC 2606/6761
 * reserved names (`.invalid`, `.test`, `.example`, `.local`, `localhost`) and
 * the reserved `example.com/net/org` domains. A real build refuses them so a
 * documentation placeholder or synthetic fixture origin can never be baked
 * into a shipped app; only the compile-only dry run accepts them. */
const RESERVED_SUFFIXES = ["invalid", "test", "example", "localhost", "local"];
const RESERVED_HOSTS = new Set(["example.com", "example.net", "example.org"]);

export function isAuthorDomain(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  return AUTHOR_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// The reserved registrable domains cover their subdomains too; the suffix list
// is matched per DNS label so `example.internal` stays a legitimate host.
export function isReservedHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (RESERVED_HOSTS.has(host) || [...RESERVED_HOSTS].some((domain) => host.endsWith(`.${domain}`))) return true;
  return RESERVED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** A loopback host: the local gateway's own deployment, never a public name. */
export function isLoopbackHost(hostname) {
  // A URL keeps an IPv6 host in brackets and may keep a trailing dot in a name.
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * A pinnable origin.
 *
 * Strict (the default): one exact HTTPS origin on a public DNS host the
 * operator owns, default port, no path, credentials, query, or fragment. With
 * `allowReserved` (compile-only dry runs), reserved names such as
 * `product.invalid` are accepted so the config can be checked before the
 * operator's DNS exists.
 *
 * `allowLoopback` is the explicit local-gateway deployment: the origin may be
 * `https://127.0.0.1:<port>`, `https://localhost:<port>`, or
 * `https://[::1]:<port>`. Only the caller's own `--local-origin` flag turns it
 * on, so no build can drift to loopback by accident and the packaged app still
 * reads exactly one pinned origin from its resource.
 *
 * Throws a stable reason code for the caller's message.
 */
export function operatorOrigin(value, { allowReserved = false, allowLoopback = false } = {}) {
  const origin = validateProductOrigin(String(value ?? "").trim());
  const url = new URL(origin);
  if (isLoopbackHost(url.hostname)) {
    if (!allowLoopback) throw new Error("product_origin_loopback");
    return origin;
  }
  if (!url.hostname.includes(".") || /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(":")) {
    throw new Error("product_origin_public_host");
  }
  if (isAuthorDomain(url.hostname)) throw new Error("product_origin_author_domain");
  if (!allowReserved && isReservedHost(url.hostname)) throw new Error("product_origin_reserved_host");
  if (url.port && url.port !== "443") throw new Error("product_origin_port");
  return origin;
}

/** The resource pins one origin; a deployment whose certificate no system
 * trusts (the local gateway) also ships that public certificate, so verification
 * needs no OS trust-store import. */
export function productServiceDocument(origin, ca = null) {
  if (ca === null) return { version: 1, origin };
  const normalized = normalizeProductCa(ca);
  if (!normalized || !productCaBindsOrigin(normalized, origin)) throw new Error("product_ca_invalid");
  return { version: 2, origin, ca: normalized };
}

export async function readProductServiceResource(resourcesDir) {
  const file = path.join(resourcesDir, PRODUCT_SERVICE_RESOURCE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`product_service_resource_missing: ${file}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`product_service_resource_invalid: ${file}`);
  }
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : null;
  if (value?.version === 1 && keys === "origin,version") {
    try {
      validateProductOrigin(value.origin);
    } catch {
      throw new Error(`product_service_resource_invalid_origin: ${file}`);
    }
    return { file, origin: value.origin, ca: null };
  }
  if (value?.version === 2 && keys === "ca,origin,version") {
    let origin;
    try {
      origin = validateProductOrigin(value.origin);
    } catch {
      throw new Error(`product_service_resource_invalid_origin: ${file}`);
    }
    const ca = normalizeProductCa(value.ca);
    if (!ca || !productCaBindsOrigin(ca, origin)) throw new Error(`product_service_resource_invalid_ca: ${file}`);
    return { file, origin, ca };
  }
  throw new Error(`product_service_resource_invalid: ${file}`);
}

const ASAR_HEADER_LIMIT = 64 * 1024 * 1024;

/**
 * Read the `package.json` electron-builder packed into app.asar — the file the
 * main process actually reads at startup, not the build-tree copy. Layout:
 * 8-byte size pickle (payload size, header-string size), the header string
 * pickle, then the concatenated file contents at 8 + headerSize + offset.
 */
export async function readAsarPackageJson(asarFile) {
  const handle = await open(asarFile, "r");
  try {
    const sizeBuffer = Buffer.alloc(8);
    if ((await handle.read(sizeBuffer, 0, 8, 0)).bytesRead !== 8) throw new Error(`not an asar archive: ${asarFile}`);
    const headerSize = sizeBuffer.readUInt32LE(4);
    if (headerSize < 8 || headerSize > ASAR_HEADER_LIMIT) throw new Error(`invalid asar header: ${asarFile}`);
    const headerBuffer = Buffer.alloc(headerSize);
    if ((await handle.read(headerBuffer, 0, headerSize, 8)).bytesRead !== headerSize) {
      throw new Error(`truncated asar header: ${asarFile}`);
    }
    const jsonSize = headerBuffer.readUInt32LE(4);
    if (jsonSize <= 0 || jsonSize + 8 > headerSize) throw new Error(`invalid asar header string: ${asarFile}`);
    const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonSize).toString("utf8"));
    const entry = header?.files?.["package.json"];
    if (!entry || typeof entry.size !== "number" || entry.offset === undefined) {
      throw new Error(`app.asar has no package.json: ${asarFile}`);
    }
    if (entry.unpack) throw new Error(`app.asar keeps package.json unpacked: ${asarFile}`);
    const content = Buffer.alloc(entry.size);
    const offset = 8 + headerSize + Number(entry.offset);
    if ((await handle.read(content, 0, content.length, offset)).bytesRead !== content.length) {
      throw new Error(`truncated app.asar package.json: ${asarFile}`);
    }
    return JSON.parse(content.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function bundleIdentifier(appDir) {
  const plistFile = path.join(appDir, "Contents", "Info.plist");
  if (!(await exists(plistFile))) return null;
  const plist = await readFile(plistFile, "utf8");
  return plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
}

/**
 * Fail-closed check of a packaged product app. Runs before signing (afterPack)
 * and again over the finished output directory (package wrapper).
 *
 * The upstream release bakes a GitHub update feed into app-update.yml. A
 * product app must carry none — starting electron-updater from it would pull
 * the upstream build over this one — so the hook deletes it before signing and
 * this check refuses any bundle that still has one.
 */
export async function verifyProductApp({ appDir, resourcesDir, removeFeed = false, expectOrigin = null }) {
  const asarFile = path.join(resourcesDir, "app.asar");
  if (!(await exists(asarFile))) throw new Error(`product_app_missing_asar: ${asarFile}`);
  const metadata = await readAsarPackageJson(asarFile);
  if (metadata.ombProductManaged !== true) throw new Error(`product_app_not_managed: ${appDir}`);
  if (metadata.main !== "electron/main.mjs") throw new Error(`product_app_unexpected_main: ${String(metadata.main)}`);
  if (typeof metadata.productName === "string" && metadata.productName !== PRODUCT_NAME) {
    throw new Error(`product_app_product_name: ${metadata.productName}`);
  }
  const resource = await readProductServiceResource(resourcesDir);
  if (expectOrigin !== null && resource.origin !== expectOrigin) {
    throw new Error(`product_app_origin_mismatch: ${resource.origin}`);
  }
  const feed = path.join(resourcesDir, "app-update.yml");
  if (removeFeed) await rm(feed, { force: true });
  if (await exists(feed)) throw new Error(`product_app_update_feed_present: ${feed}`);
  const bundleId = await bundleIdentifier(appDir);
  if (bundleId !== null && bundleId !== PRODUCT_APP_ID) throw new Error(`product_app_bundle_id: ${bundleId}`);
  return {
    appDir,
    resourcesDir,
    origin: resource.origin,
    /** True when the bundle pins a certificate, so no OS trust-store import is needed. */
    pinned: resource.ca !== null,
    main: metadata.main,
    productName: metadata.productName ?? null,
  };
}

/** True when this resource tree is a product build. Non-product packaging
 * flows never ship product-service.json, so they stay byte-for-byte unchanged. */
export async function isProductResourceTree(resourcesDir) {
  return exists(path.join(resourcesDir, PRODUCT_SERVICE_RESOURCE));
}
