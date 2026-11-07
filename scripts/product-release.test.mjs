// The bundled trust anchor: a product package either pins its origin alone
// (version 1, system trust store) or adds that origin's one public certificate
// (version 2), which is then the only reason a self-signed deployment verifies.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  operatorOrigin,
  productServiceDocument,
  readProductServiceResource,
} from "./product-release.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A throwaway certificate for 127.0.0.1, or null where openssl is absent. */
async function certificate() {
  const directory = await mkdtemp(path.join(tmpdir(), "omb-product-release-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"),
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
  if (made.status !== 0) return null;
  return { directory, pem: await readFile(path.join(directory, "cert.pem"), "utf8") };
}

describe("the bundled product resource", () => {
  it("pins only the origin unless a certificate is supplied", async () => {
    expect(productServiceDocument("https://ai.acme-ai.net")).toEqual({ version: 1, origin: "https://ai.acme-ai.net" });
    // A certificate that does not cover the origin is refused, never written.
    const certs = await certificate();
    if (!certs) return;
    expect(() => productServiceDocument("https://ai.acme-ai.net", certs.pem)).toThrow(/product_ca_invalid/);
    const document = productServiceDocument("https://127.0.0.1:18487", certs.pem);
    expect(document).toEqual({ version: 2, origin: "https://127.0.0.1:18487", ca: `${certs.pem.trim()}\n` });
  });

  it("reads both versions and rejects a certificate bound to another origin", async () => {
    const certs = await certificate();
    if (!certs) return;
    const dir = certs.directory;
    const write = (value) => writeFile(path.join(dir, "product-service.json"), JSON.stringify(value));
    await write({ version: 1, origin: "https://ai.acme-ai.net" });
    expect(await readProductServiceResource(dir)).toMatchObject({ origin: "https://ai.acme-ai.net", ca: null });
    await write({ version: 2, origin: "https://127.0.0.1:18487", ca: certs.pem });
    expect(await readProductServiceResource(dir)).toMatchObject({ origin: "https://127.0.0.1:18487", ca: `${certs.pem.trim()}\n` });
    await write({ version: 2, origin: "https://ai.acme-ai.net", ca: certs.pem });
    await expect(readProductServiceResource(dir)).rejects.toThrow(/product_service_resource_invalid_ca/);
    await write({ version: 2, origin: "https://127.0.0.1:18487" });
    await expect(readProductServiceResource(dir)).rejects.toThrow(/product_service_resource_invalid/);
    await write({ version: 1, origin: "https://127.0.0.1:18487", ca: certs.pem });
    await expect(readProductServiceResource(dir)).rejects.toThrow(/product_service_resource_invalid/);
  });

  it("keeps a loopback origin a deliberate, explicit build input", () => {
    expect(operatorOrigin("https://127.0.0.1:18487", { allowLoopback: true })).toBe("https://127.0.0.1:18487");
    expect(() => operatorOrigin("https://127.0.0.1:18487")).toThrow(/product_origin_loopback/);
  });
});
