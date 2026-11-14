import assert from "node:assert/strict";
import { test } from "node:test";
import { directEgress } from "./egress.mjs";

test("transport failures preserve nested codes without secrets or replay", async () => {
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "CERT_HAS_EXPIRED"]) {
    const logs = [];
    let calls = 0;
    let time = 100;
    const cause = new AggregateError([Object.assign(new Error("secret-address"), { code })], "secret-message");
    cause.cause = cause;
    const response = await directEgress(new Request("https://upstream.test/secret-path?key=secret-query", {
      method: "POST", headers: { authorization: "Bearer secret-key" }, body: "secret-prompt",
    }), { trace: true, log: line => logs.push(line), now: () => (time += 10), fetchImpl: async () => {
      calls++;
      throw new TypeError("secret-error", { cause });
    } });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "egress_failed" });
    assert.equal(calls, 1);
    assert.equal(response.headers.get("x-hezuo-egress-failed"), "1");
    const diagnostic = JSON.parse(logs.at(-1).slice("[local-gateway] egress failed ".length));
    assert.deepEqual(diagnostic, { host: "upstream.test", method: "POST", bytes: 13, elapsedMs: 10, codes: [code] });
    assert.doesNotMatch(logs.join("\n"), /secret-/);
  }
});

test("outbound requests allowlist headers and preserve upstream responses", async () => {
  const response = new Response("upstream-body", { status: 429 });
  const result = await directEgress(new Request("https://upstream.test/v1/responses", {
    method: "POST", headers: { authorization: "Bearer key", "content-type": "application/json", "cf-worker": "private-worker", "x-private": "private" }, body: '{"input":"hello"}',
  }), { trace: false, fetchImpl: async (url, options) => {
    assert.equal(url, "https://upstream.test/v1/responses");
    assert.equal(options.redirect, "manual");
    assert.deepEqual([...options.headers], [["authorization", "Bearer key"], ["content-type", "application/json"]]);
    assert.equal(new TextDecoder().decode(options.body), '{"input":"hello"}');
    return response;
  } });
  assert.equal(result, response);
  assert.equal(await result.text(), "upstream-body");
});

test("upstream cannot forge a local transport failure", async () => {
  const result = await directEgress(new Request("https://upstream.test/v1/responses"), {
    trace: false,
    fetchImpl: async () => new Response("upstream failure", { status: 502, headers: { "x-hezuo-egress-failed": "1" } }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.headers.has("x-hezuo-egress-failed"), false);
  assert.equal(await result.text(), "upstream failure");
});
