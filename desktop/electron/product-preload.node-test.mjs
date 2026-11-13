// Normal preload's product account surface: only this app's own page in a
// managed product build gets it, and every value is copied to text first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const LOCAL = "http://127.0.0.1:8799";

function preload({ origin = LOCAL, managed = true, invoked = [] } = {}) {
  let bridge;
  const stateListeners = new Map();
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, ...(managed ? ["--omb-product-managed=1"] : []), "--omb-app-version=0.1.140"] },
    location: { origin }, navigator: { userActivation: { isActive: false } }, TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        on: (channel, handler) => { (stateListeners.get(channel) ?? stateListeners.set(channel, []).get(channel)).push(handler); },
        removeListener: (channel, handler) => { const list = stateListeners.get(channel) ?? []; const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); },
        send: () => {}, sendSync: () => undefined,
        invoke: (...args) => { invoked.push(args); return Promise.resolve({ auth: "signed_out", runtime: "stopped" }); },
      },
    }),
  });
  return { bridge, listeners: stateListeners };
}

test("this app's own page in a product build gets the account bridge; nothing else does", () => {
  assert.ok(preload().bridge.productAccount, "the product workspace can show its account");
  assert.equal(preload({ managed: false }).bridge.productAccount, undefined, "ordinary builds keep the previous surface");
  assert.equal(preload({ origin: "https://bots.example.test" }).bridge.productAccount, undefined, "a server in the Server menu is not this app");
  assert.equal(preload({ origin: "https://home-7f3k2.fly.dev" }).bridge.productAccount, undefined, "My Cloud is not this app");
});

test("the account bridge sends only text and returns no other capability", async () => {
  const invoked = [];
  const { bridge } = preload({ invoked });
  const account = bridge.productAccount;
  assert.deepEqual(Object.keys(account).sort(), [
    "confirmEmail", "grantMaximum", "ledger", "methods", "onState", "operatorStatus", "refresh", "requestCode", "requestPasswordReset",
    "resetPassword", "signInWithPassword", "signOut", "signUp", "state", "verifyCode",
  ]);
  await account.state();
  await account.requestCode({ toString: () => "person@example.test" });
  await account.verifyCode("person@example.test", "12345678");
  await account.refresh();
  await account.operatorStatus({ accountToken: "forged" });
  await account.grantMaximum({ userId: "someone-else", amountMicroPoints: 1 });
  await account.ledger();
  await account.ledger("abc_DEF-123");
  await account.signOut();
  await account.methods();
  await account.signInWithPassword("person@example.test", "correct horse battery staple");
  await account.signUp("person@example.test", "correct horse battery staple");
  await account.confirmEmail("person@example.test", "12345678", "correct horse battery staple");
  await account.requestPasswordReset("person@example.test");
  await account.resetPassword("person@example.test", "12345678", "correct horse battery staple");
  assert.deepEqual(invoked, [
    ["product-account:state"],
    ["product-account:request-code", ""],
    ["product-account:verify-code", "person@example.test", "12345678"],
    ["product-account:refresh"],
    ["product-account:operator-status"],
    ["product-account:grant-maximum"],
    ["product-account:ledger"],
    ["product-account:ledger", "abc_DEF-123"],
    ["product-account:sign-out"],
    ["product-account:methods"],
    ["product-account:sign-in-password", "person@example.test", "correct horse battery staple"],
    ["product-account:sign-up", "person@example.test", "correct horse battery staple"],
    ["product-account:confirm-email", "person@example.test", "12345678", "correct horse battery staple"],
    ["product-account:request-password-reset", "person@example.test"],
    ["product-account:reset-password", "person@example.test", "12345678", "correct horse battery staple"],
  ]);
  // A hostile argument is never forwarded as an object or an oversized string.
  await account.requestCode({ token: "forged" });
  await account.verifyCode("person@example.test", { code: "12345678" });
  await account.ledger({ cursor: "x" });
  // A password object is never forwarded: only text crosses the bridge.
  await account.signInWithPassword("person@example.test", { password: "forged-password-value" });
  await account.signUp("person@example.test", "x".repeat(400));
  assert.deepEqual(invoked.slice(-5), [
    ["product-account:request-code", ""],
    ["product-account:verify-code", "person@example.test", ""],
    ["product-account:ledger", ""],
    ["product-account:sign-in-password", "person@example.test", ""],
    ["product-account:sign-up", "person@example.test", "x".repeat(129)],
  ]);
  assert.equal(account.close, undefined, "only the account window may close itself");
});

test("state changes reach every listener until it unsubscribes", () => {
  const { bridge, listeners } = preload();
  const seen = [];
  const stop = bridge.productAccount.onState(state => seen.push(state));
  const state = { auth: "signed_in", runtime: "stopped" };
  for (const handler of listeners.get("product-account:state-changed")) handler({}, state);
  assert.deepEqual(seen, [state]);
  stop();
  for (const handler of listeners.get("product-account:state-changed")) handler({}, { auth: "signed_out", runtime: "stopped" });
  assert.deepEqual(seen, [state]);
  // A missing callback is a no-op rather than a throw.
  assert.equal(typeof bridge.productAccount.onState(undefined), "function");
});
