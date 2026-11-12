// The pinned certificate is the deployment's own: one public PEM, bound to the
// exact origin the app was built for. These tests use real TLS servers so a
// handshake, a streamed body and a refused redirect are the ones a gateway
// would actually see. No environment variable, no global trust change.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPinnedHttpsFetch,
  normalizeProductCa,
  normalizeProductTrust,
  productCaBindsOrigin,
} from "./product-ca.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A throwaway self-signed leaf and a throwaway CA root, or null where no
 * openssl runs (the platform tests that need one skip). */
async function certificates() {
  const directory = await mkdtemp(path.join(tmpdir(), "omb-product-ca-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const make = (name, args) => {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", path.join(directory, `${name}-key.pem`), "-out", path.join(directory, `${name}.pem`), ...args],
    { stdio: "pipe", timeout: 30_000 });
    return made.error || made.status !== 0 ? null : path.join(directory, `${name}.pem`);
  };
  const leaf = make("leaf", ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const wrongLeaf = make("wrong", ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const otherLeaf = make("other", ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:10.0.0.1"]);
  const ca = make("root", ["-subj", "/CN=Hezuo fixture root", "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,digitalSignature,keyCertSign", "-addext", "subjectAltName=DNS:gateway.example"]);
  if (!leaf || !wrongLeaf || !otherLeaf || !ca) return null;
  const read = async (file) => await readFile(file, "utf8");
  return {
    directory,
    leafPem: await read(leaf),
    leafKey: await read(path.join(directory, "leaf-key.pem")),
    wrongPem: await read(wrongLeaf),
    otherPem: await read(otherLeaf),
    rootPem: await read(ca),
  };
}

async function serveTls(certs, handler) {
  const server = createServer({ key: certs.leafKey, cert: certs.leafPem }, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `https://127.0.0.1:${server.address().port}`;
}

describe("the bundled certificate", () => {
  it("is one public PEM certificate and never a key", async () => {
    const certs = await certificates();
    if (!certs) return;
    expect(normalizeProductCa(certs.leafPem)).toBe(`${certs.leafPem.trim()}\n`);
    expect(normalizeProductCa(`${certs.leafPem}${certs.rootPem}`)).toBeNull();
    expect(normalizeProductCa(`${certs.leafPem}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`)).toBeNull();
    expect(normalizeProductCa(certs.leafKey)).toBeNull();
    expect(normalizeProductCa("not a certificate")).toBeNull();
    expect(normalizeProductCa(certs.leafPem, { now: Date.parse("2000-01-01T00:00:00Z") })).toBeNull();
  });

  it("covers exactly one host, so it cannot be re-pointed at another", async () => {
    const certs = await certificates();
    if (!certs) return;
    const ca = normalizeProductCa(certs.leafPem);
    expect(productCaBindsOrigin(ca, "https://127.0.0.1:18487")).toBe(true);
    expect(productCaBindsOrigin(ca, "https://localhost:18487")).toBe(false);
    expect(productCaBindsOrigin(normalizeProductCa(certs.otherPem), "https://127.0.0.1:18487")).toBe(false);
    // A CA root is a trust anchor; the handshake's own name check decides.
    expect(productCaBindsOrigin(normalizeProductCa(certs.rootPem), "https://gateway.example")).toBe(true);
    expect(normalizeProductTrust({ origin: "https://127.0.0.1:18487", ca })).toEqual({ origin: "https://127.0.0.1:18487", ca });
    expect(normalizeProductTrust({ origin: "https://elsewhere.example", ca })).toBeNull();
    expect(normalizeProductTrust({ origin: "http://127.0.0.1:18487", ca })).toBeNull();
  });
});

describe("a pinned transport", () => {
  it("verifies, streams and refuses every other origin", async () => {
    const certs = await certificates();
    if (!certs) return;
    const origin = await serveTls(certs, (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      }
      if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        // Never ended here: the reader must see the first chunk before the end.
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url }));
    });
    const transport = createPinnedHttpsFetch({ origin, ca: certs.leafPem });
    cleanups.push(() => transport.close());

    const answered = await transport(`${origin}/healthz`);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ path: "/healthz" });

    const controller = new AbortController();
    const streaming = await transport(`${origin}/stream`, { signal: controller.signal });
    const reader = streaming.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();

    await expect(transport(`${origin}/redirect`)).rejects.toThrow(/redirected/);
    await expect(transport(`${origin.replace("127.0.0.1", "localhost")}/healthz`)).rejects.toThrow(/pinned product origin/);
    await expect(transport("https://elsewhere.example/healthz")).rejects.toThrow(/pinned product origin/);

    const aborted = new AbortController();
    aborted.abort();
    await expect(transport(`${origin}/healthz`, { signal: aborted.signal })).rejects.toThrow(/aborted/i);
  });

  it("refuses a certificate that does not cover the origin, and a wrong certificate fails closed", async () => {
    const certs = await certificates();
    if (!certs) return;
    expect(() => createPinnedHttpsFetch({ origin: "https://localhost:18487", ca: certs.leafPem })).toThrow(/product_trust_invalid/);
    expect(() => createPinnedHttpsFetch({ origin: "http://127.0.0.1:18487", ca: certs.leafPem })).toThrow(/product_trust_invalid/);

    const origin = await serveTls(certs, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const transport = createPinnedHttpsFetch({ origin, ca: certs.wrongPem });
    cleanups.push(() => transport.close());
    await expect(transport(`${origin}/healthz`)).rejects.toThrow();
  });
});
