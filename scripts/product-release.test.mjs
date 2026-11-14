// The bundled trust anchor: a product package either pins its origin alone
// (version 1, system trust store) or adds that origin's one public certificate
// (version 2), which is then the only reason a self-signed deployment verifies.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPrivateLanHost,
  operatorOrigin,
  productServiceDocument,
  readProductServiceResource,
} from "./product-release.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A throwaway certificate for 127.0.0.1, or null where openssl is absent. */
async function certificate(address = "127.0.0.1") {
  const directory = await mkdtemp(path.join(tmpdir(), "omb-product-release-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"),
    "-subj", `/CN=${address}`, "-addext", `subjectAltName=IP:${address}`], { stdio: "pipe" });
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

  it("accepts a private-network IPv4 origin only when asked, and a public address never", () => {
    for (const host of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.66.193"]) {
      expect(operatorOrigin(`https://${host}:18487`, { allowPrivateLan: true })).toBe(`https://${host}:18487`);
      expect(() => operatorOrigin(`https://${host}:18487`)).toThrow(/product_origin_public_host/);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "11.0.0.1", "100.64.0.1"]) {
      expect(() => operatorOrigin(`https://${host}:18487`, { allowPrivateLan: true })).toThrow(/product_origin_public_host/);
    }
    expect(() => operatorOrigin("https://127.0.0.1:18487", { allowPrivateLan: true })).toThrow(/product_origin_loopback/);
    expect(isPrivateLanHost("192.168.1.256")).toBe(false);
    expect(isPrivateLanHost("ai.acme-ai.net")).toBe(false);
  });

  it("reads a version 2 resource for a private-network origin, and refuses a certificate for another address", async () => {
    const certs = await certificate("192.168.66.193");
    if (!certs) return;
    const write = (value) => writeFile(path.join(certs.directory, "product-service.json"), JSON.stringify(value));
    await write({ version: 2, origin: "https://192.168.66.193:18487", ca: certs.pem });
    expect(await readProductServiceResource(certs.directory)).toMatchObject({ origin: "https://192.168.66.193:18487" });
    await write({ version: 2, origin: "https://192.168.66.194:18487", ca: certs.pem });
    await expect(readProductServiceResource(certs.directory)).rejects.toThrow(/product_service_resource_invalid_ca/);
  });

  it("keeps a loopback origin a deliberate, explicit build input", () => {
    expect(operatorOrigin("https://127.0.0.1:18487", { allowLoopback: true })).toBe("https://127.0.0.1:18487");
    expect(() => operatorOrigin("https://127.0.0.1:18487")).toThrow(/product_origin_loopback/);
  });
});
