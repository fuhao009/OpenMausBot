import { normalizeAccountEmail } from "./control-plane-client.mjs";

/** A password is any 10–128 characters; the form's own limits match this and
 * Better Auth enforces the same range again at the Worker. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const isPassword = (value) =>
  typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;

export function createProductAccountAuthentication({ state, client, store, validRecord, snapshot, publish, retryCleanup, stopWorkspace, clearScheduled, stale, completeSignIn, errorCodeOf, NETWORK_CODES }) {
  async function requestCodeNow(rawEmail) {
    if (state.cleanupBlocked) return snapshot();
    if (state.auth === "signed_in" || state.auth === "signing_in") return snapshot();
    const email = normalizeAccountEmail(rawEmail);
    if (!email) {
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    state.errorCode = "";
    try {
      await client.requestOTP(email);
      state.auth = "signed_out";
    } catch (error) {
      state.auth = NETWORK_CODES.has(errorCodeOf(error)) ? "unavailable" : "signed_out";
      state.errorCode = errorCodeOf(error);
    }
    publish();
    return snapshot();
  }

  async function readSavedDeviceId() {
    try {
      const record = validRecord(await store.read());
      return record ? record.deviceId : null;
    } catch {
      return null;
    }
  }

  /** Shared guards before any credential exchange: cleanup, an existing
   * sign-in, and a state.workspace that still has to stop. */
  async function signInPreflight() {
    if (state.cleanupBlocked && !await retryCleanup()) return snapshot();
    // A live account is never replaced silently: switching goes through
    // sign-out, so the old window, partition and credential are gone first.
    if (state.auth === "signed_in") {
      state.errorCode = "sign_out_required";
      publish();
      return snapshot();
    }
    if (state.startAttempted && !await stopWorkspace()) {
      state.cleanupBlocked = true;
      state.errorCode = "sign_out_blocked";
      publish();
      return snapshot();
    }
    return null;
  }

  /** Fences every earlier login attempt and publishes the signing-in state. */
  function beginSignIn() {
    const stamp = ++state.generation;
    clearScheduled();
    state.auth = "signing_in";
    state.workspace = "stopped";
    state.startAttempted = false;
    state.workspaceStarted = false;
    state.errorCode = "";
    state.verificationEmail = null;
    publish();
    return stamp;
  }

  function failSignIn(stamp, error) {
    if (stale(stamp)) return null;
    state.auth = NETWORK_CODES.has(errorCodeOf(error)) ? "unavailable" : "signed_out";
    state.errorCode = errorCodeOf(error);
    publish();
    return null;
  }

  /** Exchanges one credential for a session and confirms /v1/me describes the
   * same person. A late answer from an abandoned attempt returns null. */
  async function authenticate(stamp, credentialCall) {
    let verified;
    try {
      verified = await credentialCall();
    } catch (error) {
      return failSignIn(stamp, error);
    }
    if (!verified || typeof verified.accountToken !== "string") {
      if (stale(stamp)) return null;
      state.auth = "signed_out";
      state.errorCode = verified?.errorCode ?? "invalid_response";
      publish();
      return null;
    }
    if (stale(stamp)) return null;
    let me;
    try {
      me = await client.me(verified.accountToken);
    } catch (error) {
      return failSignIn(stamp, error);
    }
    if (stale(stamp)) return null;
    if (me.id !== verified.user.id || me.email !== verified.user.email) {
      state.auth = "signed_out";
      state.errorCode = "login_mismatch";
      publish();
      return null;
    }
    return { accountToken: verified.accountToken, user: me };
  }

  async function verifyCodeNow(rawEmail, rawCode) {
    const blocked = await signInPreflight();
    if (blocked) return blocked;

    const email = normalizeAccountEmail(rawEmail);
    const otp = typeof rawCode === "string" ? rawCode.replaceAll(/\s|-/g, "") : "";
    if (!email) {
      state.auth = "signed_out";
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    if (!/^\d{8}$/.test(otp)) {
      state.auth = "signed_out";
      state.errorCode = "invalid_otp";
      publish();
      return snapshot();
    }

    const stamp = beginSignIn();
    const verified = await authenticate(stamp, () => client.verifyOTP(email, otp));
    if (!verified) return snapshot();
    return completeSignIn(stamp, verified);
  }

  async function passwordSignInNow(rawEmail, rawPassword) {
    const blocked = await signInPreflight();
    if (blocked) return blocked;

    const email = normalizeAccountEmail(rawEmail);
    if (!email) {
      state.auth = "signed_out";
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    if (!isPassword(rawPassword)) {
      state.auth = "signed_out";
      state.errorCode = "invalid_password";
      publish();
      return snapshot();
    }

    const stamp = beginSignIn();
    const verified = await authenticate(stamp, () => client.signInWithPassword(email, rawPassword));
    if (!verified) return snapshot();
    return completeSignIn(stamp, verified);
  }

  /**
   * Creates an account with a password. A deployment that requires an emailed
   * confirmation creates the account but returns no session: the state names
   * the address awaiting its code. Any password is used and dropped here; it
   * is never kept, logged or written to the record.
   */
  async function signUpNow(rawEmail, rawPassword) {
    const blocked = await signInPreflight();
    if (blocked) return blocked;

    const email = normalizeAccountEmail(rawEmail);
    if (!email) {
      state.auth = "signed_out";
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    if (!isPassword(rawPassword)) {
      state.auth = "signed_out";
      state.errorCode = "invalid_password";
      publish();
      return snapshot();
    }

    const stamp = beginSignIn();
    let created;
    try {
      created = await client.signUpWithPassword(email, rawPassword);
    } catch (error) {
      return failSignIn(stamp, error) ?? snapshot();
    }
    if (stale(stamp)) return snapshot();
    if (!created.accountToken) {
      // Verification is required: the address now has a code waiting, and no
      // session exists until that code is confirmed.
      state.auth = "signed_out";
      state.errorCode = "";
      state.verificationEmail = email;
      publish();
      return snapshot();
    }
    const verified = await authenticate(stamp, () => Promise.resolve(created));
    if (!verified) return snapshot();
    return completeSignIn(stamp, verified);
  }

  /** Confirms the emailed code for a pending sign-up, then signs in with the
   * password the person just chose (still only in their form). */
  async function confirmEmailNow(rawEmail, rawCode, rawPassword) {
    const blocked = await signInPreflight();
    if (blocked) return blocked;

    const email = normalizeAccountEmail(rawEmail);
    const code = typeof rawCode === "string" ? rawCode.replaceAll(/\s|-/g, "") : "";
    if (!email) {
      state.auth = "signed_out";
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    if (!/^\d{8}$/.test(code)) {
      state.auth = "signed_out";
      state.errorCode = "invalid_otp";
      publish();
      return snapshot();
    }
    if (!isPassword(rawPassword)) {
      state.auth = "signed_out";
      state.errorCode = "invalid_password";
      publish();
      return snapshot();
    }

    const stamp = beginSignIn();
    const verified = await authenticate(stamp, async () => {
      await client.verifyEmailOTP(email, code);
      return client.signInWithPassword(email, rawPassword);
    });
    if (!verified) return snapshot();
    return completeSignIn(stamp, verified);
  }

  async function requestPasswordResetNow(rawEmail) {
    if (state.cleanupBlocked) return snapshot();
    if (state.auth === "signed_in" || state.auth === "signing_in") return snapshot();
    const email = normalizeAccountEmail(rawEmail);
    if (!email) {
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    state.errorCode = "";
    try {
      await client.requestPasswordResetOTP(email);
      state.auth = "signed_out";
      state.verificationEmail = email;
    } catch (error) {
      state.auth = NETWORK_CODES.has(errorCodeOf(error)) ? "unavailable" : "signed_out";
      state.errorCode = errorCodeOf(error);
    }
    publish();
    return snapshot();
  }

  async function resetPasswordNow(rawEmail, rawCode, rawPassword) {
    if (state.cleanupBlocked) return snapshot();
    if (state.auth === "signed_in" || state.auth === "signing_in") return snapshot();
    const email = normalizeAccountEmail(rawEmail);
    const code = typeof rawCode === "string" ? rawCode.replaceAll(/\s|-/g, "") : "";
    if (!email) {
      state.errorCode = "invalid_email";
      publish();
      return snapshot();
    }
    if (!/^\d{8}$/.test(code)) {
      state.errorCode = "invalid_otp";
      publish();
      return snapshot();
    }
    if (!isPassword(rawPassword)) {
      state.errorCode = "invalid_password";
      publish();
      return snapshot();
    }
    try {
      await client.resetPasswordWithOTP(email, code, rawPassword);
    } catch (error) {
      state.errorCode = errorCodeOf(error);
      publish();
      return snapshot();
    }
    state.errorCode = "";
    publish();
    // The new password is not signed in here: the person signs in with it, so
    // a reset never silently becomes a session on a shared computer.
    return snapshot();
  }

  /** What this deployment offers (password always, email codes when mail is
   * configured). Cached for the signed-out window; a failure leaves the form on
   * its safe defaults. */
  async function methodsNow() {
    if (state.methods) return snapshot();
    let read;
    try {
      read = await client.authMethods();
    } catch (error) {
      state.errorCode = errorCodeOf(error, "service_unavailable");
      publish();
      return snapshot();
    }
    if (read) {
      state.methods = read;
      if (state.errorCode === "service_unavailable" || NETWORK_CODES.has(state.errorCode)) state.errorCode = "";
      publish();
    }
    return snapshot();
  }

  return { requestCodeNow, verifyCodeNow, passwordSignInNow, signUpNow, confirmEmailNow, requestPasswordResetNow, resetPasswordNow, methodsNow, readSavedDeviceId };
}
