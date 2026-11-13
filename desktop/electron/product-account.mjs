import { createProductAccountAuthentication } from "./product-account-authentication.mjs";
import { createHash, randomUUID } from "node:crypto";
import { ControlPlaneError, normalizeAccountEmail } from "./control-plane-client.mjs";
import { unreadableRecord } from "./encrypted-record-store.mjs";
import { normalizeProductCa, productCaBindsOrigin } from "./product-ca.mjs";
import { validateProductOrigin } from "./product-service.mjs";

const RECORD_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_KEY = /^[0-9a-f]{64}$/;
const ERROR_RETRY_MS = 15_000;
const MIN_TIMER_MS = 5_000;
const NETWORK_CODES = new Set([
  "network_unavailable",
  "control_plane_unavailable",
  "rate_limited",
  "internal_error",
  "request_failed",
  "invalid_response",
  "ai_unavailable",
]);

const boundedToken = (value) =>
  typeof value === "string" && value.length >= 20 && value.length <= 8_192 && /^\S+$/.test(value);

const boundedText = (value, maximum) =>
  typeof value === "string" && value.length >= 1 && value.length <= maximum;


/** sha256(origin + "\n" + user.id): main's workspace root and storage
 * partition, so two accounts on one computer never share either. */
export function productAccountKey(origin, userId) {
  if (!boundedText(origin, 512) || !boundedText(userId, 256)) {
    throw new Error("product_account_identity_invalid");
  }
  return createHash("sha256").update(`${origin}\n${userId}`).digest("hex");
}

export function productAccountPartition(accountKey) {
  if (!ACCOUNT_KEY.test(typeof accountKey === "string" ? accountKey : "")) {
    throw new Error("product_account_identity_invalid");
  }
  return `persist:product-${accountKey}`;
}

const defaultSetTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

function copyState(state) {
  const copy = { auth: state.auth, runtime: state.runtime };
  if (state.user) copy.user = { id: state.user.id, email: state.user.email };
  if (state.authMethods) {
    copy.authMethods = {
      password: { ...state.authMethods.password },
      emailCode: { ...state.authMethods.emailCode },
      emailVerification: state.authMethods.emailVerification,
    };
  }
  if (typeof state.pendingEmail === "string") copy.pendingEmail = state.pendingEmail;
  if (state.ai) {
    copy.ai = {
      state: state.ai.state,
      unit: "points",
      availableMicroPoints: state.ai.availableMicroPoints,
      reservedMicroPoints: state.ai.reservedMicroPoints,
      defaultModel: state.ai.defaultModel,
      models: state.ai.models.map((model) => ({ ...model })),
    };
  }
  if (state.errorCode) copy.errorCode = state.errorCode;
  return copy;
}

const errorCodeOf = (error, fallback = "request_failed") => {
  const code = error instanceof ControlPlaneError ? error.code : "";
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
};

const isUnauthorized = (error) =>
  error?.status === 401 || errorCodeOf(error) === "unauthorized" || errorCodeOf(error) === "signed_out";

/**
 * SECURITY: the account bearer and model tokens never leave this module or
 * main's private callbacks. `stopRuntime` must resolve only after the owned
 * runtime and its children exited, and `applyCapability` only after the runtime
 * accepted (or removed) the capability; both are required.
 *
 * Every callback names the runtime it addresses: `applyCapability` and
 * `stopRuntime` always carry the generation of the start that created that
 * runtime, never a later session fence. A clear for the old runtime is stamped
 * with that old generation, so a receiver may accept exactly the generation it
 * started and drop anything else as stale.
 */
export function createProductAccountService({
  client,
  store,
  origin,
  ca = null,
  startRuntime,
  stopRuntime,
  applyCapability,
  recoverInstallation,
  onState = () => {},
  now = Date.now,
  statusPollMs = 60_000,
  renewLeadMs = 60_000,
  newDeviceId = () => randomUUID(),
  setTimer = defaultSetTimer,
  clearTimer = clearTimeout,
} = {}) {
  if (!client || typeof client.aiStatus !== "function" || typeof client.createAiToken !== "function") {
    throw new Error("A product control-plane client is required.");
  }
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new Error("An encrypted product account record store is required.");
  }
  if ([startRuntime, stopRuntime, applyCapability].some((callback) => typeof callback !== "function")) {
    throw new Error("The account runtime callbacks are required.");
  }
  const serviceOrigin = validateProductOrigin(origin, { allowLoopback: true });
  // A certificate is only ever carried with the exact origin it was bundled
  // for. Anything else (another host, a malformed or expired PEM) is refused
  // here rather than silently reaching the runtime.
  const serviceCa = normalizeProductCa(ca);
  if (serviceCa !== null && !productCaBindsOrigin(serviceCa, serviceOrigin)) {
    throw new Error("product_ca_origin_mismatch");
  }

  let auth = "signed_out";
  let workspace = "stopped";
  let errorCode = "";
  let user = null;
  let accountToken = null;
  let accountKey = null;
  let deviceId = null;
  let ai = null;
  let statusKnown = false;
  let credential = null;
  let startAttempted = false;
  let workspaceStarted = false;
  let startSettled = true;
  /** A stop that arrived while startRuntime was still running: the start's
   * own completion stops whatever it created. */
  let stopPending = false;
  /** The most recent stop for the owned runtime, so callers share one call. */
  let issuedStop = null;
  let runtimeGeneration = 0;
  let runtimeKey = null;
  let capability = { generation: 0, state: null, tokenId: null, catalog: "" };
  let capabilityTrouble = false;
  let pendingCapability = Promise.resolve();
  let cleanupBlocked = false;
  /** The address whose emailed code is outstanding (sign-up or reset), so the
   * form can ask for the code without the renderer becoming a credential store. */
  let verificationEmail = null;
  /** What this deployment offers, read once per signed-out session. */
  let methods = null;

  let generation = 0;
  let queue = Promise.resolve();
  let timer = null;
  let closed = false;
  const subscribers = new Set();

  const stale = (stamp) => closed || stamp !== generation;

  /** Lifecycle operations run one at a time so no start outlives its stop. */
  const serial = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => {}, () => {});
    return result;
  };

  const clearScheduled = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (delay) => {
    clearScheduled();
    if (closed || auth !== "signed_in") return;
    let milliseconds = delay ?? statusPollMs;
    if (delay === undefined && ai?.state === "ready" && credential) {
      milliseconds = Math.min(statusPollMs, credential.expiresAt - renewLeadMs - now());
    }
    timer = setTimer(() => {
      timer = null;
      void serial(poll).catch(() => {});
    }, Math.max(MIN_TIMER_MS, milliseconds));
  };

  /** A started workspace is usable for local history and tools even while AI is
   * pending; with usable AI it only reads "ready" after main acknowledged the
   * current credential. */
  const runtimeNow = () => {
    if (workspace !== "ready") return workspace;
    if (auth !== "signed_in") return "error";
    if (!statusKnown) return "starting";
    if (!ai || ai.state !== "ready") return "ready";
    const usable = capability.generation === generation
      && capability.state === "ready"
      && credential !== null
      && capability.tokenId === credential.id
      && credential.expiresAt > now();
    if (usable) return "ready";
    // A capability not yet acknowledged is "starting"; one whose credential
    // lapsed needs a fresh status read before this account may use AI again.
    if (capabilityTrouble || credential === null || credential.expiresAt <= now()) return "error";
    return "starting";
  };

  const snapshot = () => copyState({
    auth,
    runtime: runtimeNow(),
    ...(user ? { user: { id: user.id, email: user.email } } : {}),
    ...(ai ? { ai } : {}),
    ...(verificationEmail ? { pendingEmail: verificationEmail } : {}),
    ...(methods ? { authMethods: { ...methods } } : {}),
    ...(errorCode ? { errorCode } : {}),
  });

  const publish = () => {
    const state = snapshot();
    for (const subscriber of subscribers) {
      try { subscriber(copyState(state)); } catch { /* a listener never breaks the session */ }
    }
    try { onState(copyState(state)); } catch { /* main's window may be closing */ }
    return state;
  };

  const connectionFor = (current) => ({
    origin: serviceOrigin,
    userId: user.id,
    tokenId: current.id,
    token: current.token,
    expiresAt: current.expiresAt,
    defaultModel: ai.defaultModel,
    availableMicroPoints: ai.availableMicroPoints,
    models: ai.models.map((model) => ({ ...model })),
    ...(serviceCa ? { ca: serviceCa } : {}),
  });

  /** Prices and the model list are part of what the runtime was told, so a
   * catalogue change re-applies even while the credential is unchanged. */
  const catalogSignature = () => JSON.stringify([
    ai?.defaultModel ?? null,
    ai?.availableMicroPoints ?? 0,
    ...(ai?.models ?? []).map((model) => [model.id, model.protocol, model.pricingVersion,
      model.inputMicroPointsPerMillion, model.cachedInputMicroPointsPerMillion, model.outputMicroPointsPerMillion,
      model.maxContextTokens, model.maxOutputTokens]),
  ]);

  async function pushCapability(state, connection, stamp) {
    if (stale(stamp) || workspace !== "ready") return false;
    const tokenId = connection ? connection.tokenId : null;
    const catalog = connection ? catalogSignature() : "";
    if (capability.generation === stamp && capability.state === state
        && capability.tokenId === tokenId && capability.catalog === catalog) {
      capabilityTrouble = false;
      return true;
    }
    pendingCapability = Promise.resolve().then(() =>
      applyCapability({ generation: stamp, accountKey, user: { ...user }, state, connection }));
    try {
      await pendingCapability;
    } catch {
      if (stale(stamp)) return false;
      capabilityTrouble = true;
      errorCode = "capability_unavailable";
      publish();
      return false;
    }
    if (stale(stamp)) return false;
    capability = { generation: stamp, state, tokenId, catalog };
    capabilityTrouble = false;
    if (errorCode === "capability_unavailable") errorCode = "";
    return true;
  }

  /**
   * Invokes `stopRuntime` right away: its synchronous prefix is what pauses
   * tasks and closes the account's renderer, so it must not wait for a queued
   * start. Every invocation names the runtime this process owns, with that
   * runtime's own generation, never a later session fence.
   */
  function beginStop() {
    if (!startAttempted) return null;
    // A stop issued while the start was still running only covers what existed
    // then; once the start settles, the caller needs one more.
    if (issuedStop && issuedStop.generation === runtimeGeneration && issuedStop.startWasSettled === startSettled) {
      return issuedStop;
    }
    const entry = { generation: runtimeGeneration, startWasSettled: startSettled, ok: true, promise: null };
    const input = { generation: runtimeGeneration, accountKey: runtimeKey };
    errorCode = "sign_out_draining";
    publish();
    entry.promise = (async () => {
      try {
        await stopRuntime(input);
      } catch {
        entry.ok = false;
      }
      return entry.ok;
    })();
    issuedStop = entry;
    // A failed stop is retried by the next sign-out attempt, not reused.
    entry.promise.then((ok) => { if (!ok && issuedStop === entry) issuedStop = null; });
    return entry;
  }

  /** A start that settles after a stop needs a second stop for what it
   * created; the first stop's own result still covers the older workspace. */
  async function stopWorkspace() {
    if (!startAttempted) {
      workspaceStarted = false;
      stopPending = false;
      return true;
    }
    if (issuedStop && !issuedStop.startWasSettled) await issuedStop.promise;
    if (!startAttempted) {
      workspaceStarted = false;
      stopPending = false;
      return true;
    }
    const entry = beginStop();
    const ok = await entry.promise;
    if (!ok) {
      workspace = "error";
      return false;
    }
    if (!entry.startWasSettled) {
      // The start finished during (or after) this stop: a later stop settles it.
      return false;
    }
    startAttempted = false;
    workspaceStarted = false;
    stopPending = false;
    runtimeKey = null;
    runtimeGeneration = 0;
    if (cleanupBlocked && auth !== "signed_in") {
      cleanupBlocked = false;
      if (errorCode === "sign_out_blocked") errorCode = "";
      if (workspace !== "error") workspace = "stopped";
      publish();
    }
    return true;
  }

  const usableCatalog = (status) =>
    status.models.length > 0
    && status.defaultModel !== null
    && status.models.some((model) => model.id === status.defaultModel);

  async function revokeCredential(current) {
    if (!current || !accountToken) return;
    try { await client.revokeAiToken(accountToken, current.id); } catch { /* server TTL still bounds it */ }
  }

  async function applyStatus(read, stamp) {
    if (stale(stamp)) return false;
    // A "ready" account whose catalog cannot be admitted is a deployment fault:
    // never issue a credential for a model this app cannot price or select.
    const catalogInvalid = read.state === "ready" && !usableCatalog(read);
    const status = catalogInvalid
      ? { ...read, state: "unavailable", defaultModel: null, models: [] }
      : read;
    ai = status;
    statusKnown = true;
    if (NETWORK_CODES.has(errorCode) || errorCode === "capability_unavailable") errorCode = "";
    if (catalogInvalid) errorCode = "ai_catalog_invalid";

    if (status.state === "ready") {
      const previous = credential;
      let next = previous && previous.expiresAt > now() + renewLeadMs ? previous : null;
      if (!next) {
        try {
          next = await client.createAiToken(accountToken, deviceId);
        } catch (error) {
          if (stale(stamp)) return false;
          errorCode = errorCodeOf(error, "ai_unavailable");
          publish();
          return false;
        }
        if (stale(stamp)) return false;
      }
      credential = next;
      const applied = await pushCapability("ready", connectionFor(next), stamp);
      if (!applied || stale(stamp)) return false;
      if (previous && previous.id !== next.id) {
        // The old credential stays usable until the replacement is in the
        // runtime; revoking it earlier would cut a running turn.
        client.revokeAiToken(accountToken, previous.id).catch(() => {});
      }
      return true;
    }

    const previous = credential;
    const keep = status.state === "insufficient_balance"
      && previous !== null
      && previous.expiresAt > now()
      && usableCatalog(status);
    if (keep) {
      // Accepted work may finish; no new model call is admitted.
      await pushCapability("insufficient_balance", connectionFor(previous), stamp);
      return true;
    }
    credential = null;
    if (workspace === "ready") await pushCapability(status.state, null, stamp);
    // Whatever the runtime no longer holds cannot be used again: retire it.
    await revokeCredential(previous);
    return true;
  }

  async function statusFailure(error, stamp) {
    if (stale(stamp)) return false;
    statusKnown = true;
    if (isUnauthorized(error)) {
      if (stamp === generation && auth === "signed_in") {
        // The record stays: it names this device, so signing in again keeps
        // its credential slot instead of consuming a new one.
        await terminate("session_expired", { revoke: false, removeRecord: false });
      }
      return false;
    }
    errorCode = errorCodeOf(error, "control_plane_unavailable");
    if (credential !== null && credential.expiresAt <= now() && workspace === "ready" && capability.state !== null) {
      // The gateway will refuse this credential now, so the runtime must not
      // keep presenting it; a later status read issues a fresh one.
      credential = null;
      await pushCapability("unavailable", null, stamp);
    }
    publish();
    return false;
  }

  async function loadStatus(stamp) {
    let status;
    try {
      status = await client.aiStatus(accountToken);
    } catch (error) {
      return statusFailure(error, stamp);
    }
    if (stale(stamp)) return false;
    return applyStatus(status, stamp);
  }

  async function poll() {
    if (closed || auth !== "signed_in" || !accountToken) return;
    const stamp = generation;
    const healthy = await loadStatus(stamp);
    if (stale(stamp)) return;
    publish();
    schedule(healthy ? undefined : Math.min(statusPollMs, ERROR_RETRY_MS));
  }

  async function startSignedIn(stamp) {
    if (stale(stamp)) return snapshot();
    workspace = "starting";
    statusKnown = false;
    runtimeGeneration = stamp;
    runtimeKey = accountKey;
    startAttempted = true;
    startSettled = false;
    publish();
    let started = false;
    try {
      await startRuntime({
        generation: stamp,
        user: { ...user },
        accountKey,
        partition: productAccountPartition(accountKey),
      });
      started = true;
    } catch {
      started = false;
    }
    workspaceStarted = started;
    startSettled = true;
    // A sign-out that arrived mid-start stopped what existed then; stop what
    // this start created since.
    if (stopPending) await stopWorkspace();
    if (stale(stamp)) {
      // A queued sign-out stops this workspace; nothing here may publish or
      // register a capability under the old identity.
      return snapshot();
    }
    if (!started) {
      if (await stopWorkspace()) {
        startAttempted = false;
        runtimeKey = null;
        runtimeGeneration = 0;
      }
      if (stale(stamp)) return snapshot();
      workspace = "error";
      errorCode = "workspace_start_failed";
      publish();
      return snapshot();
    }
    workspace = "ready";
    publish();
    const healthy = await loadStatus(stamp);
    if (stale(stamp)) return snapshot();
    publish();
    schedule(healthy ? undefined : Math.min(statusPollMs, ERROR_RETRY_MS));
    return snapshot();
  }

  async function terminate(reason, { revoke, removeRecord }) {
    generation += 1;
    clearScheduled();
    const token = accountToken;
    const key = accountKey;
    const previousUser = user;
    const previousCredential = credential;
    const hadCapability = capability.state !== null;
    const hadWorkspace = startAttempted || workspaceStarted;

    // Start the stop before publishing: its synchronous prefix is what pauses
    // tasks and closes the account's renderer, so the signed_out state that
    // opens the account window never describes a still-running workspace.
    const runtimeStamp = runtimeGeneration;
    const runtimeIdentity = runtimeKey;
    let stop = null;
    if (hadWorkspace) {
      stopPending = true;
      stop = beginStop();
      await stop?.promise;
    }
    auth = "signed_out";
    user = null;
    accountToken = null;
    accountKey = null;
    ai = null;
    verificationEmail = null;
    credential = null;
    statusKnown = false;
    capability = { generation: 0, state: null, tokenId: null, catalog: "" };
    capabilityTrouble = false;
    methods = null;
    errorCode = "";
    workspace = hadWorkspace ? "starting" : "stopped";
    publish();

    await pendingCapability.catch(() => {});
    if (hadWorkspace && (workspaceStarted || hadCapability)) {
      try {
        // The clear addresses the runtime that held the capability, so it
        // carries that runtime's own generation.
        await applyCapability({
          generation: runtimeStamp,
          accountKey: runtimeIdentity ?? key,
          user: previousUser,
          state: "unavailable",
          connection: null,
        });
      } catch { /* the runtime is going away; its capability dies with it */ }
    }

    const stopped = stop ? await stop.promise : true;
    if (!stopped) {
      // The workspace is still there: say so, so no page treats it as ended.
      workspace = "error";
    } else if (!startSettled) {
      // A start outlived the stop: its own completion stops what it created,
      // and until that lands no new identity may start.
      cleanupBlocked = true;
      workspace = "error";
    } else {
      workspace = "stopped";
      startAttempted = false;
      workspaceStarted = false;
      stopPending = false;
      runtimeKey = null;
      runtimeGeneration = 0;
      issuedStop = null;
    }

    const forgotten = revoke && token
      ? Promise.allSettled([
          ...(previousCredential ? [client.revokeAiToken(token, previousCredential.id)] : []),
          client.signOut(token),
        ])
      : Promise.resolve();
    const removed = removeRecord
      ? store.write(null).then(() => true, () => false)
      : Promise.resolve(true);
    const [, recordRemoved] = await Promise.all([forgotten, removed]);

    if (!stopped || !recordRemoved) {
      cleanupBlocked = true;
      errorCode = "sign_out_blocked";
      publish();
      return snapshot();
    }
    cleanupBlocked = false;
    if (reason) errorCode = reason;
    publish();
    return snapshot();
  }

  async function retryCleanup() {
    if (!cleanupBlocked) return true;
    if (!await stopWorkspace()) {
      errorCode = "sign_out_blocked";
      publish();
      return false;
    }
    try {
      await store.write(null);
    } catch {
      cleanupBlocked = true;
      errorCode = "sign_out_blocked";
      publish();
      return false;
    }
    cleanupBlocked = false;
    workspace = "stopped";
    errorCode = "";
    publish();
    return true;
  }

  const validRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== RECORD_VERSION || value.origin !== serviceOrigin) return null;
    if (!boundedToken(value.accountToken)) return null;
    const savedUser = value.user;
    if (!savedUser || typeof savedUser !== "object" || Array.isArray(savedUser)) return null;
    const email = normalizeAccountEmail(savedUser.email);
    if (!email || email !== savedUser.email || !boundedText(savedUser.id, 256)) return null;
    if (typeof value.deviceId !== "string" || !UUID.test(value.deviceId)) return null;
    return { accountToken: value.accountToken, user: { id: savedUser.id, email }, deviceId: value.deviceId };
  };

  async function restoreNow() {
    if (cleanupBlocked || auth === "signed_in" || auth === "signing_in") return snapshot();
    let saved;
    try {
      saved = await store.read();
    } catch (error) {
      // A record this computer cannot decode stays exactly where it is.
      auth = unreadableRecord(error) ? "signed_out" : "unavailable";
      errorCode = unreadableRecord(error) ? "login_unreadable" : "login_locked";
      workspace = "stopped";
      publish();
      return snapshot();
    }
    if (saved === null) {
      auth = "signed_out";
      workspace = "stopped";
      errorCode = "";
      publish();
      return snapshot();
    }
    const record = validRecord(saved);
    if (!record) {
      auth = "signed_out";
      workspace = "stopped";
      errorCode = "login_invalid";
      publish();
      return snapshot();
    }

    const stamp = ++generation;
    clearScheduled();
    let me;
    try {
      me = await client.me(record.accountToken);
    } catch (error) {
      if (stale(stamp)) return snapshot();
      if (isUnauthorized(error)) {
        // The record is kept: it names this device, and the account window
        // replaces it on the next sign-in.
        auth = "signed_out";
        workspace = "stopped";
        errorCode = "session_expired";
        publish();
        return snapshot();
      }
      auth = "unavailable";
      workspace = "stopped";
      errorCode = errorCodeOf(error, "control_plane_unavailable");
      publish();
      return snapshot();
    }
    if (stale(stamp)) return snapshot();
    if (me.id !== record.user.id || me.email !== record.user.email) {
      // The saved sign-in no longer describes the verified account. Leave the
      // record for an explicit sign-out or a new sign-in to replace.
      auth = "signed_out";
      workspace = "stopped";
      errorCode = "login_mismatch";
      publish();
      return snapshot();
    }

    user = { id: me.id, email: me.email };
    accountToken = record.accountToken;
    deviceId = record.deviceId;
    accountKey = productAccountKey(serviceOrigin, me.id);
    auth = "signed_in";
    workspace = "stopped";
    startAttempted = false;
    workspaceStarted = false;
    ai = null;
    statusKnown = false;
    credential = null;
    capability = { generation: 0, state: null, tokenId: null, catalog: "" };
    capabilityTrouble = false;
    cleanupBlocked = false;
    errorCode = "";
    publish();
    return startSignedIn(stamp);
  }

  const authenticationState = {
    get cleanupBlocked() { return cleanupBlocked; }, set cleanupBlocked(value) { cleanupBlocked = value; },
    get auth() { return auth; }, set auth(value) { auth = value; },
    get errorCode() { return errorCode; }, set errorCode(value) { errorCode = value; },
    get startAttempted() { return startAttempted; }, set startAttempted(value) { startAttempted = value; },
    get workspace() { return workspace; }, set workspace(value) { workspace = value; },
    get workspaceStarted() { return workspaceStarted; }, set workspaceStarted(value) { workspaceStarted = value; },
    get generation() { return generation; }, set generation(value) { generation = value; },
    get verificationEmail() { return verificationEmail; }, set verificationEmail(value) { verificationEmail = value; },
    get methods() { return methods; }, set methods(value) { methods = value; },
  };
  const { requestCodeNow, verifyCodeNow, passwordSignInNow, signUpNow, confirmEmailNow, requestPasswordResetNow, resetPasswordNow, methodsNow, readSavedDeviceId } = createProductAccountAuthentication({
    state: authenticationState, client, store, validRecord, snapshot, publish, retryCleanup, stopWorkspace, clearScheduled, stale, completeSignIn, errorCodeOf, NETWORK_CODES,
  });

  /** Persists the login record, then starts the workspace for this identity. */
  async function completeSignIn(stamp, verified) {
    const savedDevice = await readSavedDeviceId();
    if (stale(stamp)) return snapshot();
    let nextDeviceId = savedDevice;
    if (typeof nextDeviceId !== "string" || !UUID.test(nextDeviceId)) nextDeviceId = newDeviceId();
    if (typeof nextDeviceId !== "string" || !UUID.test(nextDeviceId)) {
      auth = "signed_out";
      errorCode = "login_invalid";
      publish();
      return snapshot();
    }
    const key = productAccountKey(serviceOrigin, verified.user.id);
    try {
      await store.write({
        version: RECORD_VERSION,
        origin: serviceOrigin,
        accountToken: verified.accountToken,
        user: { id: verified.user.id, email: verified.user.email },
        deviceId: nextDeviceId,
      });
    } catch (error) {
      if (stale(stamp)) return snapshot();
      auth = "signed_out";
      workspace = "stopped";
      errorCode = unreadableRecord(error) ? "login_unreadable" : "login_unwritable";
      publish();
      return snapshot();
    }
    if (stale(stamp)) return snapshot();

    user = { id: verified.user.id, email: verified.user.email };
    accountToken = verified.accountToken;
    accountKey = key;
    deviceId = nextDeviceId;
    auth = "signed_in";
    workspace = "stopped";
    startAttempted = false;
    workspaceStarted = false;
    ai = null;
    statusKnown = false;
    credential = null;
    capability = { generation: 0, state: null, tokenId: null, catalog: "" };
    capabilityTrouble = false;
    cleanupBlocked = false;
    errorCode = "";
    verificationEmail = null;
    publish();
    return startSignedIn(stamp);
  }


  async function refreshNow() {
    if (cleanupBlocked && !await retryCleanup()) return snapshot();
    if (auth !== "signed_in") return restoreNow();
    if (errorCode === "installation_replaced" && recoverInstallation) {
      await recoverInstallation({ token: accountToken, user: { ...user } });
      errorCode = "";
    }
    if (workspace === "error" || workspace === "stopped") {
      if (!await stopWorkspace()) {
        errorCode = "workspace_stop_failed";
        publish();
        return snapshot();
      }
      return startSignedIn(generation);
    }
    const stamp = generation;
    const healthy = await loadStatus(stamp);
    if (stale(stamp)) return snapshot();
    publish();
    schedule(healthy ? undefined : Math.min(statusPollMs, ERROR_RETRY_MS));
    return snapshot();
  }

  // Eligibility is a read-only server-authorized lookup, never a local role flag.
  async function operatorStatusNow(stamp) {
    if (auth !== "signed_in" || !accountToken || !user || stale(stamp)) throw new ControlPlaneError("signed_out", 401);
    let account;
    try { account = await client.operatorAiAccount(accountToken, user.email); }
    catch (error) {
      if (stale(stamp)) throw new ControlPlaneError("signed_out", 401);
      if (error.status === 403) return { eligible: false };
      throw error;
    }
    if (stale(stamp)) throw new ControlPlaneError("signed_out", 401);
    if (account.userId !== user.id || account.email !== user.email) throw new ControlPlaneError("login_mismatch");
    const { availableMicroPoints, reservedMicroPoints } = account;
    if (![availableMicroPoints, reservedMicroPoints].every(value => Number.isSafeInteger(value) && value >= 0)) throw new ControlPlaneError("invalid_response");
    const remaining = BigInt(Number.MAX_SAFE_INTEGER) - BigInt(availableMicroPoints) - BigInt(reservedMicroPoints);
    if (remaining < 0n) throw new ControlPlaneError("invalid_response");
    return { eligible: true, availableMicroPoints, reservedMicroPoints, maxGrantMicroPoints: Number(remaining) };
  }

  async function grantMaximumNow(stamp) {
    let outcome = "failed";
    let amountMicroPoints = 0;
    let operationId;
    let failure;
    try {
      const status = await operatorStatusNow(stamp);
      if (!status.eligible) throw new ControlPlaneError("forbidden", 403);
      if (stale(stamp)) throw new ControlPlaneError("signed_out", 401);
      if (status.maxGrantMicroPoints === 0) outcome = "already_max";
      else {
        operationId = randomUUID();
        // Exactly one attempt. An ambiguous response or a concurrent balance
        // overflow must never trigger a second mutation with another UUID.
        const result = await client.operatorGrantAiBalance(accountToken, {
          operationId, userId: user.id, amountMicroPoints: status.maxGrantMicroPoints,
          reason: "Desktop operator: maximum balance for current account",
        });
        if (result.account.userId !== user?.id) throw new ControlPlaneError("login_mismatch");
        outcome = "granted";
        amountMicroPoints = result.grantedMicroPoints;
      }
    } catch (error) { failure = errorCodeOf(error); }
    if (!stale(stamp) && auth === "signed_in") {
      try { await refreshNow(); }
      catch { errorCode = "status_unavailable"; publish(); }
    }
    return { outcome, amountMicroPoints, ...(operationId ? { operationId } : {}),
      ...(failure ? { errorCode: failure } : {}), state: snapshot() };
  }

  return {
    async state() {
      return snapshot();
    },

    async requestCode(email) {
      return serial(() => requestCodeNow(email));
    },

    async verifyCode(email, code) {
      return serial(() => verifyCodeNow(email, code));
    },

    /** Signs in with the password the person typed; it is passed through and
     * never retained by this service. */
    async signInWithPassword(email, password) {
      return serial(() => passwordSignInNow(email, password));
    },

    /** Creates the account. With emailed verification required, the answer says
     * which address awaits its code and holds no session. */
    async signUp(email, password) {
      return serial(() => signUpNow(email, password));
    },

    /** Confirms a pending sign-up's emailed code and signs in. */
    async confirmEmail(email, code, password) {
      return serial(() => confirmEmailNow(email, code, password));
    },

    async requestPasswordReset(email) {
      return serial(() => requestPasswordResetNow(email));
    },

    async resetPassword(email, code, password) {
      return serial(() => resetPasswordNow(email, code, password));
    },

    /** The sign-in ways this deployment offers. */
    async methods() {
      return serial(() => methodsNow());
    },

    async refresh() {
      return serial(() => refreshNow());
    },

    async renewAiToken() {
      return serial(async () => {
        if (closed || auth !== "signed_in" || !accountToken || !ai || ai.state !== "ready") return false;
        const stamp = generation;
        const previous = credential;
        try {
          const next = await client.createAiToken(accountToken, deviceId);
          if (stale(stamp)) return false;
          credential = next;
          if (!await pushCapability("ready", connectionFor(next), stamp)) {
            if (!stale(stamp)) { errorCode = "session_expired"; publish(); }
            return false;
          }
          if (previous && previous.id !== next.id) await revokeCredential(previous);
          errorCode = "";
          publish();
          schedule();
          return true;
        } catch {
          if (!stale(stamp)) { errorCode = "session_expired"; publish(); }
          return false;
        }
      });
    },

    operatorStatus() {
      const stamp = generation;
      return serial(() => operatorStatusNow(stamp));
    },

    grantMaximum() {
      const stamp = generation;
      return serial(() => grantMaximumNow(stamp));
    },

    async ledger(cursor) {
      if (auth !== "signed_in" || !accountToken) throw new ControlPlaneError("signed_out", 401);
      if (cursor !== undefined && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(cursor))) {
        throw new ControlPlaneError("invalid_cursor", 400);
      }
      return client.aiLedger(accountToken, cursor);
    },

    async signOut() {
      // Fence synchronously so no timer, capability or late login acts before
      // the serialized cleanup below, and pause the owned workspace now rather
      // than a queue turn later.
      generation += 1;
      clearScheduled();
      if (startAttempted) {
        stopPending = true;
        beginStop();
      }
      return serial(async () => {
        if (cleanupBlocked && !await retryCleanup()) return snapshot();
        if (auth !== "signed_in" && !startAttempted) {
          const removed = await stopWorkspace()
            && await store.write(null).then(() => true, () => false);
          if (!removed) {
            cleanupBlocked = true;
            errorCode = "sign_out_blocked";
            publish();
            return snapshot();
          }
          cleanupBlocked = false;
          workspace = workspace === "error" ? "error" : "stopped";
          // A code that was outstanding belongs to a form that is now gone, and
          // a fenced attempt that was mid-sign-in is signed out with it.
          auth = "signed_out";
          verificationEmail = null;
          errorCode = "";
          publish();
          return snapshot();
        }
        return terminate(undefined, { revoke: true, removeRecord: true });
      });
    },

    async restore() {
      return serial(() => restoreNow());
    },

    /** Runs `fn` with the live account bearer and user. The token never appears
     * in a snapshot or IPC payload; callers must not retain it. */
    async useAccount(fn) {
      if (typeof fn !== "function") return null;
      return serial(async () => {
        if (auth !== "signed_in" || !accountToken || !user) return null;
        return fn({ token: accountToken, user: { id: user.id, email: user.email } });
      });
    },

    onState(callback) {
      if (typeof callback !== "function") return () => {};
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    },

    reportInstallation(error) {
      if (auth !== "signed_in") return;
      if (error === "installation_replaced" || error === "installation_renewal_failed") errorCode = error;
      else if (errorCode === "installation_renewal_failed") errorCode = "";
      publish();
    },

    async dispose() {
      clearScheduled();
      closed = true;
      generation += 1;
      stopPending = startAttempted;
      const stop = beginStop();
      await stop?.promise;
      await queue;
      if (!await stopWorkspace()) throw new Error("product_runtime_stop_failed");
      subscribers.clear();
    },
  };
}
