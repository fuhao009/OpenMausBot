// The account's model capability crosses to the runtime only through the one
// private message, and only the exact process that was asked may answer it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedDesktopRelay } from "./managed-desktop.mjs";

const ORIGIN = "https://operator.example";
const token = `omb_product_ai_${"a".repeat(22)}.${"b".repeat(43)}`;
const model = () => ({ id: "maus-default", label: "MausBot", protocol: "chat", pricingVersion: "v1",
  inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1000, maxOutputTokens: 100 });
const connection = () => ({ origin: ORIGIN, userId: "user-1", tokenId: "token-1", token, expiresAt: Date.now() + 15 * 60_000,
  defaultModel: "maus-default", models: [model()] });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A throwaway certificate for the fixture origin, or null without openssl. */
function certificateForOperator() {
  const directory = mkdtempSync(join(tmpdir(), "omb-relay-ca-"));
  try {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-subj", "/CN=operator.example", "-addext", "subjectAltName=DNS:operator.example"], { stdio: "pipe" });
    return made.status === 0 ? readFileSync(join(directory, "cert.pem"), "utf8") : null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function proc() {
  const sent = [];
  return { sent, postMessage: message => sent.push(message) };
}

test("a ready capability is sent as one private message and acknowledged by the exact process", async () => {
  const relay = createManagedDesktopRelay(), proc1 = proc(), other = proc();
  const operation = relay.sendProductAi(proc1, { state: "ready", connection: connection() });
  assert.equal(proc1.sent.length, 1);
  const [message] = proc1.sent;
  assert.equal(message.type, "openmausbot:product-ai");
  assert.equal(typeof message.requestId, "string");
  assert.equal(message.state, "ready");
  assert.equal(message.connection.token, token, "the runtime is the one place the token goes");
  // A different process, a different type for the same id, and a non-boolean
  // outcome each leave the operation waiting.
  assert.equal(relay.receive(other, { type: "openmausbot:product-ai-result", requestId: message.requestId, ok: true }), true);
  assert.equal(relay.receive(proc1, { type: "openmausbot:managed-desktop-result", requestId: message.requestId, ok: true }), true);
  assert.equal(relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: message.requestId, ok: "yes" }), true);
  await settle();
  let settled = false;
  void operation.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, "only the runtime's own ack settles it");
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: message.requestId, ok: true });
  await operation;
});

test("an unready state sends no capability; a rejected runtime answers with its own error", async () => {
  const relay = createManagedDesktopRelay(), proc1 = proc();
  const idle = relay.sendProductAi(proc1, { state: "pending", connection: null });
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: true });
  await idle;
  assert.deepEqual(proc1.sent.at(-1).connection, null);
  assert.equal(proc1.sent.at(-1).state, "pending");
  // No runtime at all: nothing to send, and a capability is never kept here.
  await relay.sendProductAi(null, { state: "suspended", connection: null });
  await assert.rejects(relay.sendProductAi(null, { state: "ready", connection: connection() }), /not available/);
  // Accepted work may finish on a live credential: a balance-empty account keeps one.
  const held = relay.sendProductAi(proc1, { state: "insufficient_balance", connection: connection() });
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: true });
  await held;
  assert.equal(proc1.sent.at(-1).state, "insufficient_balance");
  assert.equal(proc1.sent.at(-1).connection.token, token);
  // Without a live credential it holds none, and that is still a valid state.
  relay.sendProductAi(proc1, { state: "insufficient_balance", connection: null });
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: true });
  await new Promise(resolve => setImmediate(resolve));
  const refused = relay.sendProductAi(proc1, { state: "ready", connection: connection() });
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: false });
  await assert.rejects(refused, /AI could not be connected/);
  // A balance-empty account without any live credential holds none.
  const unprovisioned = relay.sendProductAi(proc1, { state: "insufficient_balance", connection: null });
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: true });
  await unprovisioned;
});

test("a malformed update is refused before anything reaches the runtime", async () => {
  const relay = createManagedDesktopRelay(), proc1 = proc();
  const bad = [
    { state: "ready" },
    { state: "ready", connection: null },
    { state: "ready", connection: { ...connection(), origin: "http://operator.example" } },
    { state: "ready", connection: { ...connection(), token: "omd_" + "a".repeat(43) } },
    { state: "ready", connection: { ...connection(), models: [] } },
    { state: "ready", connection: { ...connection(), defaultModel: "not-there" } },
    { state: "ready", connection: { ...connection(), expiresAt: 0 } },
    { state: "ready", connection: { ...connection(), models: [{ ...model(), protocol: "audio" }] } },
    // A certificate is one public PEM bound to this origin, or it is refused.
    { state: "ready", connection: { ...connection(), ca: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" } },
    { state: "running", connection: null },
    { state: "pending", connection: connection() },
    { state: "suspended", connection: connection() },
    { state: "unavailable", connection: connection() },
    { connection: null },
    null,
  ];
  for (const update of bad) await assert.rejects(relay.sendProductAi(proc1, update), /invalid_product_ai/);
  assert.deepEqual(proc1.sent, []);
});

test("a bundled certificate rides the private message, beside the credential", async () => {
  const pem = certificateForOperator();
  if (!pem) return;
  const relay = createManagedDesktopRelay(), proc1 = proc();
  const operation = relay.sendProductAi(proc1, { state: "ready", connection: { ...connection(), ca: pem } });
  const [message] = proc1.sent;
  assert.equal(message.connection.ca, `${pem.trim()}\n`);
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: message.requestId, ok: true });
  await operation;
});

test("company messages keep their own result type and wording, unchanged", async () => {
  const relay = createManagedDesktopRelay(), proc1 = proc();
  // Observed once, as a value, so the probe below never reports an unhandled rejection.
  const outcome = relay.send(proc1, { fixture: true }).then(() => "resolved", error => error.message);
  assert.equal(proc1.sent.at(-1).type, "openmausbot:managed-desktop");
  // A product-AI ack with the company request's id is not this operation's answer.
  relay.receive(proc1, { type: "openmausbot:product-ai-result", requestId: proc1.sent.at(-1).requestId, ok: true });
  let answered = false;
  void outcome.then(() => { answered = true; });
  await settle();
  assert.equal(answered, false, "the product-AI result did not answer the company message");
  relay.receive(proc1, { type: "openmausbot:managed-desktop-result", requestId: proc1.sent.at(-1).requestId, ok: false });
  assert.match(await outcome, /Company models could not be connected/);
  assert.equal(relay.receive(proc1, { type: "unrelated" }), false);
});
