// Node-side account operations for the fixture, through the app's own
// control-plane client: real OTP sign-in against the fixture Worker, then the
// same operator endpoints gateway/scripts/account-ai-admin.mjs calls. The bearer stays
// in this process; nothing here writes it anywhere.
import { createControlPlaneClient } from "../../desktop/electron/control-plane-client.mjs";

/** A verified account session over the real OTP flow (the Worker writes the
 * code to its own mailbox). */
export async function signIn(origin, email, mailbox) {
  const client = createControlPlaneClient({ baseURL: origin });
  await client.requestOTP(email);
  const code = await mailbox.nextCode();
  const verified = await client.verifyOTP(email, code);
  return { client, token: verified.accountToken, user: verified.user, email };
}

/** A password sign-in for an account that already exists (the no-mail
 * deployment's way in for the operator). */
export async function signInWithPassword(origin, email, password) {
  const client = createControlPlaneClient({ baseURL: origin });
  const signedIn = await client.signInWithPassword(email, password);
  return { client, token: signedIn.accountToken, user: signedIn.user, email };
}

/** A password account, the way a deployment without mail creates and enters
 * one: sign up (no confirmation is required there), then sign in. A reused
 * address answers `email_taken`, which is this fixture's "already registered". */
export async function signUpWithPassword(origin, email, password) {
  const client = createControlPlaneClient({ baseURL: origin });
  await client.signUpWithPassword(email, password).catch(error => {
    if (error?.code !== "email_taken") throw error;
  });
  const signedIn = await client.signInWithPassword(email, password);
  return { client, token: signedIn.accountToken, user: signedIn.user, email };
}

/** A password account whose address this deployment asks to confirm: the
 * sign-up answers without a session and the Worker's own mailbox has the 8-digit
 * code, which /api/auth/email-otp/verify-email then accepts. */
export async function signUpWithVerification(origin, email, password, mailbox) {
  const client = createControlPlaneClient({ baseURL: origin });
  const created = await client.signUpWithPassword(email, password).catch(error => {
    if (error?.code !== "email_taken") throw error;
  });
  if (created.accountToken) return { client, token: created.accountToken, user: created.user, email };
  const code = await mailbox.nextCode();
  await client.verifyEmailOTP(email, code);
  const signedIn = await client.signInWithPassword(email, password);
  return { client, token: signedIn.accountToken, user: signedIn.user, email, verificationCode: code };
}

/** The operator's exact-email lookup: the documented way to turn a person's
 * verified address into the user id a mutation names. Unknown → null. */
export async function operatorLookup(client, token, email) {
  const response = await fetch(`${client.origin}/v1/operator/ai/account?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`operator lookup refused (${response.status})`);
  return await response.json();
}

export async function operatorSetAccount(client, token, { userId, enabled, reason }) {
  return await operatorRequest(client, token, "/v1/operator/ai/account", {
    operationId: crypto.randomUUID(), userId, enabled, reason,
  });
}

export async function operatorGrant(client, token, { userId, amountMicroPoints, reason }) {
  return await operatorRequest(client, token, "/v1/operator/ai/balance", {
    operationId: crypto.randomUUID(), userId, amountMicroPoints, reason,
  });
}

export async function operatorSettle(client, token, { requestId, chargedMicroPoints, reason }) {
  return await operatorRequest(client, token, `/v1/operator/ai/requests/${encodeURIComponent(requestId)}/settle`, {
    operationId: crypto.randomUUID(), chargedMicroPoints, reason,
  });
}

async function operatorRequest(client, token, path, body) {
  const origin = client.origin;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code ?? payload?.error ?? `http_${response.status}`;
    throw new Error(`operator ${path} refused: ${typeof code === "string" ? code : JSON.stringify(code)}`);
  }
  return payload;
}
