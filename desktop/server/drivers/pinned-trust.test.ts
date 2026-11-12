// The account engine verifies its own deployment with the public certificate
// the parent pinned, and nothing else: a real TLS server, no NODE_EXTRA_CA_CERTS,
// no global trust change, hostname checks on, redirects refused.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pinnedTransport } from "./pinned-trust.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.NODE_EXTRA_CA_CERTS;
});

interface Certificates { key: string; pem: string; otherPem: string }

/** A throwaway leaf for 127.0.0.1, or null where openssl is unavailable. */
function certificates(): Certificates | null {
  const directory = mkdtempSync(join(tmpdir(), "omb-pinned-trust-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const make = (name: string, extra: string[]) => {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(directory, `${name}-key.pem`), "-out", join(directory, `${name}.pem`), ...extra], { stdio: "pipe" });
    return made.status === 0 ? join(directory, `${name}.pem`) : null;
  };
  const leaf = make("leaf", ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const other = make("other", ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  if (!leaf || !other) return null;
  return {
    key: readFileSync(join(directory, "leaf-key.pem"), "utf8"),
    pem: readFileSync(leaf, "utf8"),
    otherPem: readFileSync(other, "utf8"),
  };
}

async function serveTls(certs: Certificates): Promise<{ origin: string; calls: string[] }> {
  const calls: string[] = [];
  const server: Server = createServer({ key: certs.key, cert: certs.pem }, async (request, response) => {
    calls.push(request.url ?? "");
    if (request.url === "/v1/redirect") {
      response.writeHead(302, { location: "/v1/elsewhere" });
      response.end();
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    for await (const _part of request) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "verified" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  return { origin: `https://127.0.0.1:${address.port}`, calls };
}

async function managed(url: string, trust: { origin: string; ca: string }) {
  const instance = await OpenAICompatDriver.create({
    instanceId: "product-ai", displayName: "Product", enabled: true,
    environment: {},
    config: OpenAICompatDriver.decodeConfig({ url, apiKeyEnv: "HEZUO_PRODUCT_AI_TOKEN", provider: "", model: "product-model" }),
    requestCredential: () => ({ apiKey: `omb_product_ai_${"a".repeat(22)}.${"b".repeat(43)}`, expiresAt: Date.now() + 60_000 }),
    requestTrust: trust,
  });
  cleanups.push(async () => { await instance.dispose(); });
  return instance;
}

describe("a pinned deployment certificate", () => {
  it("verifies the engine's own origin and refuses another or a redirect", async () => {
    const certs = certificates();
    if (!certs) return;
    const { origin, calls } = await serveTls(certs);
    const instance = await managed(`${origin}/v1`, { origin, ca: certs.pem });
    await expect(instance.generateText!("hello", { model: "product-model" })).resolves.toBe("verified");
    expect(calls).toContain("/v1/chat/completions");

    // A certificate that only the pinned file names still has to pass the
    // hostname and chain checks: another self-signed leaf fails closed.
    const wrong = pinnedTransport({ origin, ca: certs.otherPem }, `${origin}/v1`);
    await expect(wrong!(`${origin}/v1/models`)).rejects.toThrow();
    // And the transport is bound to that origin: no other host, no redirect.
    const pinned = pinnedTransport({ origin, ca: certs.pem }, `${origin}/v1`);
    await expect(pinned!(`${origin}/v1/redirect`)).rejects.toThrow(/redirected/);
    await expect(pinned!(`${origin.replace("127.0.0.1", "localhost")}/v1/models`)).rejects.toThrow(/pinned product origin/);
  });

  it("refuses a certificate the parent bound to another origin", async () => {
    const certs = certificates();
    if (!certs) return;
    const { origin } = await serveTls(certs);
    expect(() => pinnedTransport({ origin: "https://operator.example", ca: certs.pem }, `${origin}/v1`)).toThrow(/not the origin/);
    expect(() => pinnedTransport({ origin, ca: certs.pem }, "https://operator.example/v1")).toThrow(/not the origin/);
  });

  it("does not depend on an environment CA, and never widens trust for an unpinned instance", async () => {
    const certs = certificates();
    if (!certs) return;
    const { origin } = await serveTls(certs);
    // A stray environment variable changes nothing: the pin is the only
    // reason this throwaway certificate is trusted.
    process.env.NODE_EXTRA_CA_CERTS = "/nonexistent/should-not-be-read.pem";
    const pinned = await managed(`${origin}/v1`, { origin, ca: certs.pem });
    await expect(pinned.generateText!("hello", { model: "product-model" })).resolves.toBe("verified");

    // An instance given no trust keeps the process fetch, which cannot verify
    // this self-signed certificate: trust never leaks between instances.
    const unpinned = await OpenAICompatDriver.create({
      instanceId: "other", displayName: "Other", enabled: true, environment: {},
      config: OpenAICompatDriver.decodeConfig({ url: `${origin}/v1`, apiKeyEnv: "FIXTURE_KEY", provider: "", model: "product-model" }),
    });
    cleanups.push(async () => { await unpinned.dispose(); });
    await expect(unpinned.generateText!("hello", { model: "product-model" })).rejects.toThrow();
  }, 20_000);
});
