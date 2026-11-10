import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import bridgeModule from "./computer-use-policy.cjs";

function processDouble() {
  const proc = new EventEmitter();
  proc.messages = [];
  proc.postMessage = message => proc.messages.push(message);
  return proc;
}

test("policy request only resolves its own private process response", async () => {
  const proc = processDouble();
  const bridge = bridgeModule.createComputerUsePolicyBridge({ randomId: () => "request" });
  const pending = bridge.request(proc, "allow");
  assert.deepEqual(proc.messages, [{ type: "computer-use-policy-set", requestId: "request", policy: "allow" }]);
  proc.emit("message", { type: "computer-use-policy-result", requestId: "unknown", ok: true, policy: "deny" });
  proc.emit("message", { type: "computer-use-policy-result", requestId: "request", ok: true, policy: "allow" });
  assert.equal(await pending, "allow");
  assert.equal(proc.listenerCount("message"), 0);
  assert.equal(proc.listenerCount("exit"), 0);
});

test("workspace process exit rejects an in-flight setting", async () => {
  const proc = processDouble();
  const bridge = bridgeModule.createComputerUsePolicyBridge({ randomId: () => "request" });
  const pending = bridge.request(proc, "allow");
  proc.emit("exit");
  await assert.rejects(pending, /workspace changed/);
  assert.equal(proc.listenerCount("message"), 0);
});

test("invalid policy never reaches the private process; reads use get", async () => {
  const proc = processDouble();
  const bridge = bridgeModule.createComputerUsePolicyBridge({ randomId: () => "request" });
  await assert.rejects(bridge.request(proc, "full"), /Invalid/);
  assert.equal(proc.messages.length, 0);
  const pending = bridge.request(proc);
  assert.equal(proc.messages[0].type, "computer-use-policy-get");
  proc.emit("message", { type: "computer-use-policy-result", requestId: "request", ok: true, policy: "ask" });
  assert.equal(await pending, "ask");
});
