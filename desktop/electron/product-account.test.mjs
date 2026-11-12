import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProductAccountService,
  productAccountKey,
  productAccountPartition,
} from "./product-account.mjs";
import { ControlPlaneError } from "./control-plane-client.mjs";

/** A throwaway certificate for the fixture service host, or null without openssl. */
function certificate(altName = "DNS:operator.example", commonName = "operator.example") {
  const directory = mkdtempSync(join(tmpdir(), "omb-account-ca-"));
  try {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-subj", `/CN=${commonName}`, "-addext", `subjectAltName=${altName}`], { stdio: "pipe" });
    return made.status === 0 ? readFileSync(join(directory, "cert.pem"), "utf8") : null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const ORIGIN = "https://operator.example";
const ACCOUNT = `signed.${"a".repeat(40)}`;
const DEVICE = "11111111-1111-4111-8111-111111111111";
const PASSWORD = "correct horse battery staple";
const MODEL = {
  id: "fixture-model",
  label: "Fixture model",
  protocol: "chat",
  pricingVersion: "2026-11-01",
  inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000,
  outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
};
const readyStatus = (overrides = {}) => ({
  state: "ready",
  unit: "points",
  availableMicroPoints: 1_000_000,
  reservedMicroPoints: 0,
  defaultModel: MODEL.id,
  models: [MODEL],
  ...overrides,
});
const pendingStatus = (overrides = {}) => readyStatus({ state: "pending", defaultModel: null, models: [], ...overrides });
const user = { id: "user-1", email: "ada@example.com" };

const token = (suffix) => ({
  id: `22222222-2222-4222-8222-22222222222${suffix}`,
  token: `omb_product_ai_${String(suffix).repeat(22).slice(0, 22)}.${"c".repeat(43)}`,
  expiresAt: 1_000_000,
});

function fixture({ saved = null, status = readyStatus(), readError, start, stop, apply, writeError, verification = true, beforeSignIn, ca = null } = {}) {
  let now = 10_000;
  const events = [];
  const record = { value: saved === null ? null : structuredClone(saved) };
  const writes = [];
  const states = [];
  const timers = new Map();
  let timerId = 0;
  let currentStatus = status;
  let issued = 0;
  let readCalls = 0;
  const people = new Map([["ada@example.com", user]]);
  let identity = saved?.user ?? user;
  const confirmed = new Set();
  let methods = {
    password: { enabled: true, minLength: 10, maxLength: 128 },
    emailCode: { enabled: true },
    emailVerification: "required",
  };
  let requireEmailVerification = verification;

  const client = {
    async requestOTP(email) {
      events.push({ type: "requestOTP", email });
      return { email };
    },
    async verifyOTP(email, otp) {
      events.push({ type: "verifyOTP", email, otp });
      identity = people.get(email) ?? { id: `user-${email}`, email };
      return { accountToken: ACCOUNT, user: identity };
    },
    async authMethods() {
      events.push({ type: "authMethods" });
      if (methods instanceof Error) throw methods;
      return methods;
    },
    async signUpWithPassword(email, password) {
      events.push({ type: "signUpWithPassword", email, password });
      identity = people.get(email) ?? { id: `user-${email}`, email };
      // A deployment that requires confirmation answers without a session.
      return requireEmailVerification ? { accountToken: null, user: identity } : { accountToken: ACCOUNT, user: identity };
    },
    async signInWithPassword(email, password) {
      events.push({ type: "signInWithPassword", email, password });
      if (beforeSignIn) await beforeSignIn();
      if (password !== PASSWORD) throw new ControlPlaneError("invalid_credentials", 401);
      identity = people.get(email) ?? { id: `user-${email}`, email };
      return { accountToken: ACCOUNT, user: identity };
    },
    async verifyEmailOTP(email, otp) {
      events.push({ type: "verifyEmailOTP", email, otp });
      confirmed.add(email);
      return { email };
    },
    async requestPasswordResetOTP(email) {
      events.push({ type: "requestPasswordResetOTP", email });
      return { email };
    },
    async resetPasswordWithOTP(email, otp, password) {
      events.push({ type: "resetPasswordWithOTP", email, otp, password });
      return { email };
    },
    async me(accountToken) {
      events.push({ type: "me", accountToken });
      if (accountToken !== ACCOUNT) throw new ControlPlaneError("unauthorized", 401);
      return identity;
    },
    async signOut(accountToken) {
      events.push({ type: "signOut", accountToken });
    },
    async aiStatus(accountToken) {
      events.push({ type: "aiStatus", accountToken });
      if (currentStatus instanceof Error) throw currentStatus;
      return structuredClone(currentStatus);
    },
    async createAiToken(accountToken, deviceId) {
      issued += 1;
      events.push({ type: "createAiToken", accountToken, deviceId, issued });
      const next = token(issued % 10);
      next.expiresAt = now + 15 * 60_000;
      return next;
    },
    async revokeAiToken(accountToken, tokenId) {
      events.push({ type: "revokeAiToken", accountToken, tokenId });
    },
    async aiLedger(accountToken, cursor) {
      events.push({ type: "aiLedger", accountToken, cursor });
      return { items: [{ id: "grant-1", kind: "grant", createdAt: 5, amountMicroPoints: 1_000_000 }], nextCursor: null };
    },
  };

  const store = {
    async read() {
      readCalls += 1;
      if (readError) throw readError;
      return record.value === null ? null : structuredClone(record.value);
    },
    async write(value) {
      writes.push(value);
      if (writeError) throw writeError;
      record.value = value === null ? null : structuredClone(value);
    },
  };

  const service = createProductAccountService({
    client,
    store,
    origin: ORIGIN,
    ca,
    now: () => now,
    statusPollMs: 60_000,
    renewLeadMs: 60_000,
    newDeviceId: () => DEVICE,
    setTimer: (callback, milliseconds) => {
      timerId += 1;
      timers.set(timerId, { callback, milliseconds });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    startRuntime: async (input) => {
      events.push({ type: "startRuntime", input });
      await start?.(input);
    },
    stopRuntime: async (input) => {
      events.push({ type: "stopRuntime", input });
      await stop?.(input);
    },
    applyCapability: async (update) => {
      events.push({ type: "applyCapability", update });
      await apply?.(update);
    },
    onState: (state) => { states.push(state); events.push({ type: "state", state }); },
  });

  const pendingTimers = () => [...timers.values()];
  const runTimers = async () => {
    // Run only the timers pending at this call: a poll may schedule the next.
    for (const [id, entry] of Array.from(timers)) {
      timers.delete(id);
      entry.callback();
      await settle();
    }
  };

  return {
    service,
    client,
    events,
    record,
    writes,
    states,
    timers,
    pendingTimers,
    runTimers,
    setStatus: (next) => { currentStatus = next; },
    setMethods: (next) => { methods = next; },
    setNow: (next) => { now = next; },
    get now() { return now; },
    get readCalls() { return readCalls; },
    types: () => events.map((event) => event.type),
  };
}

/** Lets every queued promise/microtask finish without touching fake timers. */
async function settle() {
  for (let index = 0; index < 25; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fixtureClientStub() {
  const noop = async () => ({});
  return {
    requestOTP: noop, verifyOTP: noop, me: noop, signOut: noop,
    authMethods: async () => ({ password: { enabled: true, minLength: 10, maxLength: 128 }, emailCode: { enabled: true }, emailVerification: "required" }),
    signUpWithPassword: noop, signInWithPassword: noop, verifyEmailOTP: noop,
    requestPasswordResetOTP: noop, resetPasswordWithOTP: noop,
    aiStatus: async () => pendingStatus(), createAiToken: async () => token(1),
    revokeAiToken: noop, aiLedger: async () => ({ items: [], nextCursor: null }),
  };
}

const savedRecord = () => ({
  version: 1,
  origin: ORIGIN,
  accountToken: ACCOUNT,
  user,
  deviceId: DEVICE,
});

describe("product account identity", () => {
  it("derives a stable account key and partition from the service origin and user id", () => {
    const key = productAccountKey(ORIGIN, "user-1");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(productAccountKey(ORIGIN, "user-1"));
    expect(key).not.toBe(productAccountKey("https://other.example", "user-1"));
    expect(key).not.toBe(productAccountKey(ORIGIN, "user-2"));
    expect(productAccountPartition(key)).toBe(`persist:product-${key}`);
    expect(() => productAccountKey("", "user-1")).toThrow("product_account_identity_invalid");
    expect(() => productAccountPartition("../escape")).toThrow("product_account_identity_invalid");
  });
});

describe("product account sign-in", () => {
  it("starts the account workspace for a pending account without a capability", async () => {
    const f = fixture({ status: pendingStatus() });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready", user, ai: { state: "pending" } });
    expect(state).not.toHaveProperty("accountToken");
    const started = f.events.find((event) => event.type === "startRuntime");
    expect(started.input).toMatchObject({
      user,
      accountKey: productAccountKey(ORIGIN, user.id),
      partition: `persist:product-${productAccountKey(ORIGIN, user.id)}`,
    });
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(0);
    const applied = f.events.filter((event) => event.type === "applyCapability");
    expect(applied.at(-1).update).toMatchObject({ state: "pending", connection: null });
    expect(f.record.value).toEqual({ version: 1, origin: ORIGIN, accountToken: ACCOUNT, user, deviceId: DEVICE });
    expect(JSON.stringify(state)).not.toContain(ACCOUNT);
  });

  it("reaches capability-ready only after main acknowledges the issued token", async () => {
    const f = fixture();
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready", ai: { state: "ready" } });
    const applied = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    expect(applied.state).toBe("ready");
    expect(applied.connection).toMatchObject({
      origin: ORIGIN,
      userId: user.id,
      tokenId: token(1).id,
      defaultModel: MODEL.id,
      models: [MODEL],
    });
    expect(applied.connection.token).toBe(token(1).token);
    // The raw model token never reaches a renderer snapshot.
    expect(JSON.stringify(f.states)).not.toContain(token(1).token);
  });

  it("carries a bundled certificate on the capability only, never in the record or a renderer state", async () => {
    const pem = certificate();
    if (!pem) return;
    const f = fixture({ ca: pem });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");
    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready" });
    const applied = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    // The origin the fixture service talks to is https://operator.example, so
    // the certificate has to name that host for it to be allowed.
    expect(applied.connection.ca).toBe(`${pem.trim()}\n`);
    expect(f.record.value).toEqual({ version: 1, origin: ORIGIN, accountToken: ACCOUNT, user, deviceId: DEVICE });
    expect(JSON.stringify(f.states)).not.toContain("CERTIFICATE");
  });

  it("refuses a certificate that does not cover the service origin", () => {
    const pem = certificate("DNS:elsewhere.example", "elsewhere.example");
    if (!pem) return;
    expect(() => fixture({ ca: pem })).toThrow(/product_ca_origin_mismatch/);
  });

  it("reports a failing workspace start without inventing a capability", async () => {
    const f = fixture({ status: readyStatus(), start: async () => { throw new Error("child died"); } });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");

    expect(state).toMatchObject({ auth: "signed_in", runtime: "error", errorCode: "workspace_start_failed" });
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(0);
  });

  it("keeps a failed capability ack as an error and retries without extending the old token", async () => {
    let fail = true;
    const f = fixture({ apply: async () => { if (fail) throw new Error("runtime refused"); } });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");
    expect(state).toMatchObject({ auth: "signed_in", runtime: "error", errorCode: "capability_unavailable" });
    expect(f.events.filter((event) => event.type === "revokeAiToken")).toHaveLength(0);

    fail = false;
    const refreshed = await f.service.refresh();
    expect(refreshed).toMatchObject({ auth: "signed_in", runtime: "ready" });
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(1);
  });

  it("keeps the workspace starting until the capability is acknowledged", async () => {
    let release;
    const ack = new Promise((resolve) => { release = resolve; });
    const f = fixture({ apply: async () => { await ack; } });
    const verifying = f.service.verifyCode("ada@example.com", "12345678");
    await settle();

    const during = await f.service.state();
    expect(during).toMatchObject({ auth: "signed_in", runtime: "starting", ai: { state: "ready" } });
    release();
    expect(await verifying).toMatchObject({ auth: "signed_in", runtime: "ready" });
  });

  it("refuses to sign in invalid input without touching a workspace", async () => {
    const f = fixture();
    expect(await f.service.verifyCode("ada@example.com", "12-34")).toMatchObject({
      auth: "signed_out",
      errorCode: "invalid_otp",
    });
    expect(await f.service.verifyCode("ada", "12345678")).toMatchObject({
      auth: "signed_out",
      errorCode: "invalid_email",
    });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(0);
    expect(f.record.value).toBeNull();
  });

  it("drops a verification that finishes after sign-out", async () => {
    const f = fixture();
    const original = f.service.verifyCode("ada@example.com", "12345678");
    // Nothing awaited yet: the verification is queued but has not resolved.
    void original;
    await settle();
    const signingIn = f.states.some((state) => state.auth === "signing_in");
    expect(signingIn).toBe(true);

    const out = await f.service.signOut();
    expect(out).toMatchObject({ auth: "signed_out", runtime: "stopped" });
    await settle();
    expect(f.events.filter((event) => event.type === "startRuntime").length).toBeLessThanOrEqual(1);
    expect(await f.service.state()).toMatchObject({ auth: "signed_out" });
  });
});

describe("product account restore", () => {
  it("restores a saved sign-in and the same device id", async () => {
    const f = fixture({ saved: savedRecord() });
    const state = await f.service.restore();

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready", user });
    expect(f.events.filter((event) => event.type === "createAiToken")[0].deviceId).toBe(DEVICE);
    expect(f.record.value).toEqual(savedRecord());
  });

  it("leaves an unreadable record exactly as it is", async () => {
    const error = Object.assign(new Error("The saved record is not JSON."), { code: "unreadable_record" });
    const f = fixture({ readError: error });
    const state = await f.service.restore();

    expect(state).toMatchObject({ auth: "signed_out", runtime: "stopped", errorCode: "login_unreadable" });
    expect(f.writes).toHaveLength(0);
    expect(f.types()).toEqual(["state"]);
  });

  it("reports a locked keychain as unavailable and keeps the record", async () => {
    const f = fixture({ readError: new Error("Unlock your system keychain before saving this record.") });
    const state = await f.service.restore();

    expect(state).toMatchObject({ auth: "unavailable", runtime: "stopped", errorCode: "login_locked" });
    expect(f.writes).toHaveLength(0);
  });

  it("reports an expired session as signed out and keeps the device record", async () => {
    const f = fixture({ saved: { ...savedRecord(), accountToken: `signed.${"z".repeat(40)}` } });
    const state = await f.service.restore();

    expect(state).toMatchObject({ auth: "signed_out", runtime: "stopped", errorCode: "session_expired" });
    expect(f.record.value).toEqual({ ...savedRecord(), accountToken: `signed.${"z".repeat(40)}` });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(0);

    // Signing in again reuses the device and replaces the stale token.
    const signedIn = await f.service.verifyCode(" ada@example.com ", "1234 5678");
    expect(signedIn).toMatchObject({ auth: "signed_in" });
    expect(f.events.filter((event) => event.type === "createAiToken")[0].deviceId).toBe(DEVICE);
    expect(f.record.value).toEqual(savedRecord());
  });

  it("never starts a workspace for a record bound to another origin", async () => {
    const f = fixture({ saved: { ...savedRecord(), origin: "https://stale.example" } });
    const state = await f.service.restore();

    expect(state).toMatchObject({ auth: "signed_out", errorCode: "login_invalid" });
    expect(f.types()).toEqual(["state"]);
    expect(f.writes).toHaveLength(0);
  });
});

describe("product account capability renewal", () => {
  it("issues before expiring, applies the new token, then revokes the old one", async () => {
    const f = fixture({ saved: savedRecord() });
    const service = f.service;
    await service.restore();
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(1);

    f.setNow(10_000 + 15 * 60_000 - 30_000); // inside the renewal window
    await settle();
    await f.runTimers();
    const issued = f.events.filter((event) => event.type === "createAiToken");
    expect(issued).toHaveLength(2);
    const applied = f.events.filter((event) => event.type === "applyCapability");
    const appliedOrder = applied.at(-1).update;
    expect(appliedOrder.state).toBe("ready");
    expect(appliedOrder.connection.tokenId).toBe(token(2).id);
    const revokes = f.events.filter((event) => event.type === "revokeAiToken");
    expect(revokes.map((event) => event.tokenId)).toEqual([token(1).id]);
    expect(await service.state()).toMatchObject({ runtime: "ready" });
  });

  it("clears the capability for a suspended account and refuses new tokens", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    f.setStatus(pendingStatus({ state: "suspended" }));
    await f.runTimers();

    const applied = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    expect(applied).toMatchObject({ state: "suspended", connection: null });
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(1);
    const revoke = f.events.filter((event) => event.type === "revokeAiToken");
    expect(revoke.map((event) => event.tokenId)).toEqual([token(1).id]);
    expect(await f.service.state()).toMatchObject({ auth: "signed_in", runtime: "ready", ai: { state: "suspended" } });
  });

  it("keeps an installed capability while the balance is exhausted", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    f.setStatus(readyStatus({ state: "insufficient_balance" }));
    await f.runTimers();

    const applied = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    expect(applied.state).toBe("insufficient_balance");
    expect(applied.connection.tokenId).toBe(token(1).id);
    expect(f.events.filter((event) => event.type === "revokeAiToken")).toHaveLength(0);
    expect(await f.service.state()).toMatchObject({ auth: "signed_in", runtime: "ready" });
  });
});

describe("product account sign-out", () => {
  it("stops a workspace whose start finished after sign-out", async () => {
    let releaseStart;
    const started = new Promise((resolve) => { releaseStart = resolve; });
    const f = fixture({ start: async () => { await started; } });
    const verifying = f.service.verifyCode("ada@example.com", "12345678");
    await settle();

    const signingOut = f.service.signOut();
    await settle();
    releaseStart();
    await Promise.all([verifying, signingOut]);
    await settle();

    const startIndex = f.types().indexOf("startRuntime");
    const stopIndex = f.types().indexOf("stopRuntime");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(startIndex);
    expect(await f.service.state()).toMatchObject({ auth: "signed_out", runtime: "stopped" });
    expect(f.record.value).toBeNull();
    expect(f.events.some((event) => event.type === "signOut")).toBe(true);
  });

  it("blocks a further sign-in when the workspace will not stop", async () => {
    const f = fixture({ saved: savedRecord(), stop: async () => { throw new Error("child still running"); } });
    await f.service.restore();
    const state = await f.service.signOut();

    expect(state).toMatchObject({ auth: "signed_out", runtime: "error", errorCode: "sign_out_blocked" });
    // A blocked sign-out must not quietly start the next identity.
    const before = f.events.filter((event) => event.type === "startRuntime").length;
    const next = await f.service.verifyCode("ada@example.com", "12345678").catch(() => null);
    expect(next ?? (await f.service.state())).toMatchObject({ auth: "signed_out" });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(before);
  });

  it("retries a blocked sign-out once the runtime can stop", async () => {
    let failing = true;
    const f = fixture({ saved: savedRecord(), stop: async () => { if (failing) throw new Error("still running"); } });
    await f.service.restore();
    expect(await f.service.signOut()).toMatchObject({ errorCode: "sign_out_blocked" });
    failing = false;
    expect(await f.service.signOut()).toMatchObject({ auth: "signed_out", runtime: "stopped" });
    expect(f.record.value).toBeNull();
  });

  it("ends the session when the server revokes it", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    f.setStatus(new ControlPlaneError("unauthorized", 401));
    await f.runTimers();

    expect(await f.service.state()).toMatchObject({ auth: "signed_out", errorCode: "session_expired" });
    expect(f.record.value).toEqual(savedRecord());
    expect(f.events.filter((event) => event.type === "stopRuntime")).toHaveLength(1);
  });
});

describe("product account isolation", () => {
  it("requires every runtime callback", () => {
    const base = {
      client: {}, store: { read: async () => null, write: async () => {} }, origin: ORIGIN,
      startRuntime: async () => {}, stopRuntime: async () => {}, applyCapability: async () => {},
    };
    expect(() => createProductAccountService({ ...base, client: fixtureClientStub() })).not.toThrow();
    for (const key of ["startRuntime", "stopRuntime", "applyCapability"]) {
      expect(() => createProductAccountService({ ...base, client: fixtureClientStub(), [key]: undefined }))
        .toThrow("The account runtime callbacks are required.");
    }
  });

  it("gives two accounts different workspaces and never carries a token across", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const firstStart = f.events.find((event) => event.type === "startRuntime").input;
    const firstToken = f.events.filter((event) => event.type === "applyCapability").at(-1).update.connection;
    await f.service.signOut();

    // Sign in as a different account on the same service.
    const otherUser = { id: "user-grace@example.com", email: "grace@example.com" };
    f.events.length = 0;
    const second = await f.service.verifyCode("grace@example.com", "12345678");
    expect(second).toMatchObject({ auth: "signed_in", runtime: "ready" });
    const secondStart = f.events.find((event) => event.type === "startRuntime").input;
    expect(secondStart.accountKey).not.toBe(firstStart.accountKey);
    expect(secondStart.partition).not.toBe(firstStart.partition);
    const applied = f.events.filter((event) => event.type === "applyCapability" && event.update.connection);
    expect(applied.at(-1).update.connection.userId).toBe(otherUser.id);
    expect(JSON.stringify(f.events)).not.toContain(firstToken.token);
  });

  it("names the runtime it owns when a late start is stopped", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const f = fixture({ start: async () => { await gate; } });
    const verifying = f.service.verifyCode("ada@example.com", "12345678");
    await settle();
    const signingOut = f.service.signOut();
    await settle();
    release();
    await Promise.all([verifying, signingOut]);
    await settle();

    const started = f.events.find((event) => event.type === "startRuntime").input;
    const stopped = f.events.find((event) => event.type === "stopRuntime").input;
    expect(stopped).toEqual({ generation: started.generation, accountKey: started.accountKey });
  });
});

describe("product account sign-out details", () => {
  it("requires an explicit sign-out before another account can sign in", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const other = await f.service.verifyCode("grace@example.com", "12345678");
    expect(other).toMatchObject({ auth: "signed_in", errorCode: "sign_out_required", user });
    expect(f.events.filter((event) => event.type === "verifyOTP")).toHaveLength(0);
  });

  it("forgets a login record it cannot read when the person signs out", async () => {
    const error = Object.assign(new Error("The saved record is not JSON."), { code: "unreadable_record" });
    const f = fixture({ readError: error });
    const state = await f.service.signOut();
    expect(state).toMatchObject({ auth: "signed_out", runtime: "stopped" });
    expect(f.writes).toEqual([null]);
  });

  it("releases a workspace whose start died partway", async () => {
    const f = fixture({ start: async () => { throw new Error("child died"); } });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");
    expect(state).toMatchObject({ runtime: "error", errorCode: "workspace_start_failed" });
    expect(f.events.filter((event) => event.type === "stopRuntime")).toHaveLength(1);
    const started = await f.service.refresh();
    expect(started).toMatchObject({ runtime: "error" });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(2);
  });
});

describe("product account lapsed capability", () => {
  it("reports an error instead of a ready workspace once the credential lapsed unrenewed", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    // The renewal window passes while the service is unreachable.
    f.setNow(10_000 + 15 * 60_000 + 1);
    f.setStatus(new Error("offline"));
    await f.runTimers();

    expect(await f.service.state()).toMatchObject({
      auth: "signed_in",
      runtime: "error",
      errorCode: "control_plane_unavailable",
      ai: { state: "ready" },
    });
    // The runtime must not keep presenting a credential the gateway refuses.
    const applied = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    expect(applied).toMatchObject({ state: "unavailable", connection: null });
  });
});

describe("product account restore mismatch", () => {
  it("never deletes a record whose identity the server contradicts", async () => {
    const f = fixture({ saved: savedRecord() });
    // The saved user no longer matches who the token belongs to.
    f.setStatus(pendingStatus());
    const original = f.record.value;
    const state = await (async () => {
      f.record.value = { ...original, user: { id: "user-other", email: "other@example.com" } };
      return f.service.restore();
    })();
    expect(state).toMatchObject({ auth: "signed_out", errorCode: "login_mismatch" });
    expect(f.writes).toHaveLength(0);
  });
});

describe("product account restore while busy", () => {
  it("does not restart or replace a session that is already signed in", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const starts = f.events.filter((event) => event.type === "startRuntime").length;
    const statuses = f.events.filter((event) => event.type === "aiStatus").length;
    await f.service.restore();
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(starts);
    expect(f.events.filter((event) => event.type === "aiStatus")).toHaveLength(statuses);
  });
});

describe("product account catalog changes", () => {
  it("re-applies the capability when prices change without a new credential", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const before = f.events.filter((event) => event.type === "applyCapability").length;

    f.setStatus(readyStatus({
      models: [{ ...MODEL, outputMicroPointsPerMillion: 5_000_000, pricingVersion: "2026-12-01" }],
    }));
    await f.runTimers();

    const applied = f.events.filter((event) => event.type === "applyCapability");
    expect(applied.length).toBeGreaterThan(before);
    expect(applied.at(-1).update.connection.models[0].outputMicroPointsPerMillion).toBe(5_000_000);
    expect(f.events.filter((event) => event.type === "createAiToken")).toHaveLength(1);
  });
});

describe("product account slow start", () => {
  it("stops a workspace that appears after the sign-out wait expired", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const f = fixture({ start: async () => { await gate; } });
    const verifying = f.service.verifyCode("ada@example.com", "12345678");
    await settle();

    const signingOut = f.service.signOut();
    await settle();
    // The start is still hanging: sign-out reports blocked, not a leak.
    const blocked = await Promise.race([signingOut, settle().then(() => null)]);
    release();
    await Promise.all([verifying, signingOut]);
    await settle();

    const starts = f.events.filter((event) => event.type === "startRuntime");
    const stops = f.events.filter((event) => event.type === "stopRuntime");
    expect(starts.length).toBeGreaterThan(0);
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(await f.service.state()).toMatchObject({ auth: "signed_out" });
    expect(blocked === null || blocked.auth === "signed_out").toBe(true);
  });
});

describe("product account stop ordering", () => {
  it("invokes stopRuntime before publishing signed_out", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const stopsBefore = f.events.filter((event) => event.type === "stopRuntime").length;
    await f.service.signOut();

    const sequence = f.events.slice();
    const stopAt = sequence.findIndex((event, index) => event.type === "stopRuntime"
      && sequence.slice(0, index).filter((prior) => prior.type === "stopRuntime").length === stopsBefore);
    const signedOutAt = sequence.findIndex((event, index) => event.type === "state"
      && event.state.auth === "signed_out" && index > stopAt);
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(signedOutAt).toBeGreaterThan(stopAt);
    const firstSignedOut = sequence[signedOutAt].state;
    expect(firstSignedOut.runtime).not.toBe("ready");
  });

  it("stops the owned runtime even when its start is still running", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const f = fixture({ saved: savedRecord(), start: async () => { await gate; } });
    const restoring = f.service.restore();
    await settle();

    const signingOut = f.service.signOut();
    await settle();
    // Sign-out must not wait for the start to finish before pausing the workspace.
    expect(f.events.filter((event) => event.type === "stopRuntime")).toHaveLength(1);
    release();
    await Promise.all([restoring, signingOut]);
    await settle();
    expect(f.events.filter((event) => event.type === "stopRuntime").length).toBeGreaterThanOrEqual(2);
    expect(await f.service.state()).toMatchObject({ auth: "signed_out", runtime: "stopped" });
  });

  it("does not recreate a workspace while a sign-out is blocked", async () => {
    const f = fixture({ saved: savedRecord(), stop: async () => { throw new Error("still running"); } });
    await f.service.restore();
    expect(await f.service.signOut()).toMatchObject({ errorCode: "sign_out_blocked" });
    const starts = f.events.filter((event) => event.type === "startRuntime").length;

    expect(await f.service.refresh()).toMatchObject({ auth: "signed_out", errorCode: "sign_out_blocked" });
    expect(await f.service.verifyCode("ada@example.com", "12345678")).toMatchObject({ auth: "signed_out" });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(starts);
  });

  it("uses the owned runtime generation for clears and stops, not the session fence", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    const started = f.events.find((event) => event.type === "startRuntime").input.generation;
    await f.service.signOut();

    const clear = f.events.filter((event) => event.type === "applyCapability").at(-1).update;
    expect(clear.generation).toBe(started);
    const stop = f.events.find((event) => event.type === "stopRuntime").input;
    expect(stop.generation).toBe(started);
  });
});

describe("product account ledger", () => {
  it("passes the opaque cursor through and requires a signed-in account", async () => {
    const f = fixture({ saved: savedRecord() });
    await expect(f.service.ledger()).rejects.toMatchObject({ code: "signed_out" });
    await f.service.restore();
    const page = await f.service.ledger("abc-_123");
    expect(page).toEqual({
      items: [{ id: "grant-1", kind: "grant", createdAt: 5, amountMicroPoints: 1_000_000 }],
      nextCursor: null,
    });
    expect(f.events.find((event) => event.type === "aiLedger")).toMatchObject({ cursor: "abc-_123" });
    await expect(f.service.ledger("not a cursor")).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

describe("product account state publication", () => {
  it("publishes copies, so a listener cannot mutate the session", async () => {
    const f = fixture({ saved: savedRecord(), status: pendingStatus() });
    const seen = [];
    const stop = f.service.onState((state) => {
      state.auth = "tampered";
      seen.push(state);
    });
    await f.service.restore();
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(await f.service.state()).toMatchObject({ auth: "signed_in" });
  });

  it("stops scheduling after dispose", async () => {
    const f = fixture({ saved: savedRecord() });
    await f.service.restore();
    expect(f.timers.size).toBe(1);
    f.service.dispose();
    expect(f.timers.size).toBe(0);
  });
});

describe("product account password sign-in", () => {
  it("signs in with a password, never publishing it, and starts the workspace", async () => {
    const f = fixture({ verification: false });
    const state = await f.service.signInWithPassword(" ada@example.com ", PASSWORD);

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready", user });
    expect(JSON.stringify(f.states)).not.toContain(PASSWORD);
    expect(JSON.stringify(f.writes)).not.toContain(PASSWORD);
    expect(f.events.find((event) => event.type === "signInWithPassword")).toMatchObject({
      email: "ada@example.com", password: PASSWORD,
    });
    expect(f.record.value).toMatchObject({ version: 1, origin: ORIGIN, user });
  });

  it("keeps a wrong password on the signed-out form with a reason", async () => {
    const f = fixture({ verification: false });
    const state = await f.service.signInWithPassword("ada@example.com", "not the right password");

    expect(state).toMatchObject({ auth: "signed_out", errorCode: "invalid_credentials" });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(0);
    expect(f.record.value).toBeNull();
  });

  it("refuses a password outside the range without calling the service", async () => {
    const f = fixture({ verification: false });
    expect(await f.service.signInWithPassword("ada@example.com", "short")).toMatchObject({
      auth: "signed_out", errorCode: "invalid_password",
    });
    expect(await f.service.signUp("ada@example.com", "x".repeat(129))).toMatchObject({
      auth: "signed_out", errorCode: "invalid_password",
    });
    expect(f.types()).toEqual(["state", "state"]);
  });

  it("creates an account with no confirmation and signs in", async () => {
    const f = fixture({ verification: false });
    const state = await f.service.signUp("new@example.com", PASSWORD);

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready", user: { id: "user-new@example.com", email: "new@example.com" } });
    expect(JSON.stringify(f.states)).not.toContain(PASSWORD);
  });

  it("names the address awaiting a code instead of starting a workspace", async () => {
    const f = fixture({ verification: true });
    const state = await f.service.signUp("new@example.com", PASSWORD);

    expect(state).toMatchObject({ auth: "signed_out", pendingEmail: "new@example.com" });
    expect(state.errorCode).toBeUndefined();
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(0);
    expect(f.record.value).toBeNull();
  });

  it("confirms the emailed code and signs in with the password", async () => {
    const f = fixture({ verification: true });
    await f.service.signUp("new@example.com", PASSWORD);
    const state = await f.service.confirmEmail("new@example.com", "12345678", PASSWORD);

    expect(state).toMatchObject({ auth: "signed_in", runtime: "ready" });
    expect(state.pendingEmail).toBeUndefined();
    expect(f.events.find((event) => event.type === "verifyEmailOTP")).toMatchObject({ email: "new@example.com", otp: "12345678" });
  });

  it("resets a password without becoming a session", async () => {
    const f = fixture({ verification: true });
    expect(await f.service.requestPasswordReset("ada@example.com")).toMatchObject({ pendingEmail: "ada@example.com" });
    const state = await f.service.resetPassword("ada@example.com", "12345678", "a brand new passphrase");

    expect(state).toMatchObject({ auth: "signed_out" });
    expect(f.events.find((event) => event.type === "resetPasswordWithOTP")).toMatchObject({
      email: "ada@example.com", otp: "12345678", password: "a brand new passphrase",
    });
    expect(JSON.stringify(f.states)).not.toContain("a brand new passphrase");
    expect(f.record.value).toBeNull();
  });

  it("publishes the sign-in ways this deployment offers", async () => {
    const f = fixture({ verification: false });
    f.setMethods({
      password: { enabled: true, minLength: 10, maxLength: 128 },
      emailCode: { enabled: false },
      emailVerification: "off",
    });
    const state = await f.service.methods();
    expect(state.authMethods).toEqual({
      password: { enabled: true, minLength: 10, maxLength: 128 },
      emailCode: { enabled: false },
      emailVerification: "off",
    });
    // Cached: a second read does not ask again.
    await f.service.methods();
    expect(f.events.filter((event) => event.type === "authMethods")).toHaveLength(1);
  });

  it("never starts a workspace for a password login fenced by sign-out", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const f = fixture({ verification: false, beforeSignIn: () => held });

    const signingIn = f.service.signInWithPassword("ada@example.com", PASSWORD);
    await settle();
    expect(f.states.some((state) => state.auth === "signing_in")).toBe(true);

    // Sign-out fences synchronously, then its cleanup queues behind this login.
    const signingOut = f.service.signOut();
    await settle();
    release();
    const [late, out] = await Promise.all([signingIn, signingOut]);
    expect(out).toMatchObject({ auth: "signed_out", runtime: "stopped" });

    // The fenced attempt reports no identity (its own answer may still read
    // "signing_in" until the sign-out's queued cleanup publishes), and the last
    // published state is signed out.
    expect(late.auth).not.toBe("signed_in");
    expect(f.states.at(-1)).toMatchObject({ auth: "signed_out" });
    expect(f.events.filter((event) => event.type === "startRuntime")).toHaveLength(0);
    expect(f.record.value).toBeNull();
  });
});

describe("current-account operator maximum grant", () => {
  function operatorFixture() {
    const f = fixture({ saved: savedRecord() });
    let balance = { userId: user.id, email: user.email, availableMicroPoints: 19_869_000, reservedMicroPoints: 501_024_000 };
    f.client.operatorAiAccount = async (bearer, email) => {
      expect(bearer).toBe(ACCOUNT);
      expect(email).toBe(user.email);
      return { ...balance, bearer: ACCOUNT };
    };
    f.client.operatorGrantAiBalance = async (bearer, input) => {
      expect(bearer).toBe(ACCOUNT);
      expect(input.userId).toBe(user.id);
      f.events.push({ type: "grant", ...input });
      balance = { ...balance, availableMicroPoints: balance.availableMicroPoints + input.amountMicroPoints };
      f.setStatus(readyStatus(balance));
      return { account: balance, grantedMicroPoints: input.amountMicroPoints, replayed: false };
    };
    return f;
  }

  it("previews without mutation, grants fresh BigInt headroom, preserves reservations and refreshes", async () => {
    const f = operatorFixture();
    await f.service.restore();
    const preview = await f.service.operatorStatus();
    expect(preview).toEqual({ eligible: true, availableMicroPoints: 19_869_000, reservedMicroPoints: 501_024_000,
      maxGrantMicroPoints: Number(BigInt(Number.MAX_SAFE_INTEGER) - 19_869_000n - 501_024_000n) });
    expect(f.types()).not.toContain("grant");
    const result = await f.service.grantMaximum();
    expect(result).toMatchObject({ outcome: "granted", amountMicroPoints: preview.maxGrantMicroPoints,
      state: { ai: { availableMicroPoints: Number.MAX_SAFE_INTEGER - 501_024_000, reservedMicroPoints: 501_024_000 } } });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
    expect(await f.service.grantMaximum()).toMatchObject({ outcome: "already_max", amountMicroPoints: 0 });
    expect(f.events.filter(e => e.type === "grant")).toHaveLength(1);
    f.service.dispose();
  });

  it("denies nonoperators without a mutation", async () => {
    const f = operatorFixture();
    await f.service.restore();
    f.client.operatorAiAccount = async () => { throw new ControlPlaneError("forbidden", 403); };
    expect(await f.service.operatorStatus()).toEqual({ eligible: false });
    expect(await f.service.grantMaximum()).toMatchObject({ outcome: "failed", errorCode: "forbidden", amountMicroPoints: 0 });
    expect(f.types()).not.toContain("grant");
    f.service.dispose();
  });

  it.each(["amount_out_of_range", "network_unavailable"])("does not retry %s and refreshes status", async code => {
    const f = operatorFixture();
    await f.service.restore();
    let attempts = 0;
    f.client.operatorGrantAiBalance = async () => { attempts++; throw new ControlPlaneError(code); };
    const before = f.events.filter(e => e.type === "aiStatus").length;
    expect(await f.service.grantMaximum()).toMatchObject({ outcome: "failed", errorCode: code, amountMicroPoints: 0 });
    expect(attempts).toBe(1);
    expect(f.events.filter(e => e.type === "aiStatus").length).toBe(before + 1);
    f.service.dispose();
  });

  it("recomputes after preview and retains confirmed grant when refresh fails", async () => {
    const f = operatorFixture();
    await f.service.restore();
    await f.service.operatorStatus();
    f.client.operatorAiAccount = async () => ({ userId: user.id, email: user.email,
      availableMicroPoints: Number.MAX_SAFE_INTEGER - 10, reservedMicroPoints: 3 });
    f.client.operatorGrantAiBalance = async (_bearer, input) => {
      expect(input.amountMicroPoints).toBe(7);
      f.setStatus(new ControlPlaneError("network_unavailable"));
      return { account: { userId: user.id }, grantedMicroPoints: 7, replayed: false };
    };
    expect(await f.service.grantMaximum()).toMatchObject({ outcome: "granted", amountMicroPoints: 7,
      state: { errorCode: "network_unavailable" } });
    f.service.dispose();
  });

  it("fences an in-flight lookup on sign-out before any grant", async () => {
    const f = operatorFixture();
    await f.service.restore();
    let release;
    f.client.operatorAiAccount = () => new Promise(resolve => { release = resolve; });
    const grant = f.service.grantMaximum();
    await settle();
    const out = f.service.signOut();
    release({ userId: user.id, email: user.email, availableMicroPoints: 0, reservedMicroPoints: 0 });
    expect(await grant).toMatchObject({ outcome: "failed", errorCode: "signed_out" });
    await out;
    expect(f.types()).not.toContain("grant");
    f.service.dispose();
  });
});

describe("product account useAccount", () => {
  it("passes the live bearer only into the callback and never onto the snapshot", async () => {
    const f = fixture({ status: pendingStatus() });
    const state = await f.service.verifyCode(" ada@example.com ", "1234 5678");
    expect(state.auth).toBe("signed_in");
    expect(state).not.toHaveProperty("accountToken");
    const seen = await f.service.useAccount(async ({ token, user: account }) => {
      expect(token).toBe(ACCOUNT);
      expect(account).toEqual({ id: user.id, email: user.email });
      return "ok";
    });
    expect(seen).toBe("ok");
    f.service.dispose();
  });

  it("returns null when signed out", async () => {
    const f = fixture();
    expect(await f.service.useAccount(async () => "no")).toBe(null);
    f.service.dispose();
  });
});
