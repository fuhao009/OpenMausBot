import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveProductService, validateProductOrigin } from "./product-service.mjs";

/** A throwaway certificate for 127.0.0.1, or null where openssl is missing. */
async function certificate(directory) {
  const key = path.join(directory, "fixture-key.pem");
  const cert = path.join(directory, "fixture-cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
  return made.status === 0 ? await readFile(cert, "utf8") : null;
}

test("packaged identity requires its resource and ignores environment overrides", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-product-service-"));
  try {
    const options = { isPackaged: true, appPath: dir, resourcesPath: dir, environment: { OMB_PRODUCT_SERVICE_URL: "https://override.example" } };
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ ombProductManaged: true }));
    await assert.rejects(resolveProductService(options), /product_service_missing/);
    await writeFile(path.join(dir, "product-service.json"), JSON.stringify({ version: 1, origin: "https://operator.example" }));
    assert.deepEqual(await resolveProductService(options), { managed: true, origin: "https://operator.example", ca: null });
    await writeFile(path.join(dir, "product-service.json"), JSON.stringify({ version: 1, origin: "http://127.0.0.1:1234" }));
    await assert.rejects(resolveProductService(options), /product_service_invalid/);
    await writeFile(path.join(dir, "package.json"), "{}");
    assert.equal(await resolveProductService(options), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a version 2 resource pins a certificate bound to its own origin", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-product-service-ca-"));
  try {
    const pem = await certificate(dir);
    if (!pem) return;
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ ombProductManaged: true }));
    const resource = (value) => writeFile(path.join(dir, "product-service.json"), JSON.stringify(value));
    const resolve = (fixtureOrigin) => resolveProductService({ isPackaged: true, appPath: dir, resourcesPath: dir, ...(fixtureOrigin ? { fixtureOrigin } : {}) });

    await resource({ version: 2, origin: "https://127.0.0.1:18487", ca: pem });
    assert.deepEqual(await resolve(), { managed: true, origin: "https://127.0.0.1:18487", ca: `${pem.trim()}\n` });
    // The fixture may name its own Worker; the bundled certificate travels only to the origin it was built for.
    assert.deepEqual(await resolve("https://127.0.0.1:18487"), { managed: true, origin: "https://127.0.0.1:18487", ca: `${pem.trim()}\n` });
    assert.deepEqual(await resolve("https://127.0.0.1:19999"), { managed: true, origin: "https://127.0.0.1:19999", ca: null });

    // A certificate for another host can never be applied to this origin.
    await resource({ version: 2, origin: "https://localhost:18487", ca: pem });
    await assert.rejects(resolve(), /product_service_invalid_ca/);
    // Nor can a key, a second certificate, or an unknown key.
    await resource({ version: 2, origin: "https://127.0.0.1:18487", ca: `${pem}${pem}` });
    await assert.rejects(resolve(), /product_service_invalid_ca/);
    await resource({ version: 2, origin: "https://127.0.0.1:18487" });
    await assert.rejects(resolve(), /product_service_invalid/);
    await resource({ version: 2, origin: "https://127.0.0.1:18487", ca: pem, extra: true });
    await assert.rejects(resolve(), /product_service_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a version 2 resource for a private-network origin is read, and only with a certificate naming that address", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-product-service-lan-"));
  try {
    const key = path.join(dir, "lan-key.pem");
    const cert = path.join(dir, "lan-cert.pem");
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert,
      "-subj", "/CN=192.168.66.193", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "subjectAltName=IP:192.168.66.193"], { stdio: "pipe" });
    if (made.status !== 0) return;
    const pem = await readFile(cert, "utf8");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ ombProductManaged: true }));
    const resource = (value) => writeFile(path.join(dir, "product-service.json"), JSON.stringify(value));
    const resolve = () => resolveProductService({ isPackaged: true, appPath: dir, resourcesPath: dir });
    await resource({ version: 2, origin: "https://192.168.66.193:18487", ca: pem });
    assert.deepEqual(await resolve(), { managed: true, origin: "https://192.168.66.193:18487", ca: `${pem.trim()}\n` });
    await resource({ version: 2, origin: "https://192.168.66.194:18487", ca: pem });
    await assert.rejects(resolve(), /product_service_invalid_ca/);
    await resource({ version: 2, origin: "https://127.0.0.1:18487", ca: pem });
    await assert.rejects(resolve(), /product_service_invalid_ca/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("development is explicit and origin boundaries exclude secrets and paths", async () => {
  assert.equal(await resolveProductService({ isPackaged: false, environment: {} }), null);
  assert.deepEqual(await resolveProductService({ isPackaged: false, environment: { OMB_PRODUCT_SERVICE_URL: "http://127.0.0.1:1234" } }), { managed: true, origin: "http://127.0.0.1:1234", ca: null });
  for (const origin of ["http://operator.example", "https://user:secret@operator.example", "https://operator.example/path", "https://operator.example?key=x", "https://operator.example#fragment"]) {
    assert.throws(() => validateProductOrigin(origin), /product_service_invalid/);
  }
});
