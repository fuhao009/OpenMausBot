import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createAuth, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../src/auth";
import { readAuthConfig } from "../src/config";
import worker from "../src/index";

const BASE_URL = "https://auth.openmausbot.test";
const PASSWORD = "correct horse battery staple";
/** The fixture deployment carries a sender and the suite's `EMAIL` binding. */
const MAIL = { EMAIL_FROM: "noreply@openmausbot.test", AUTH_EMAIL_VERIFICATION: "required" };

/** A deployment with no mail transport at all: the verification toggle must be
 * off (no sender, no EMAIL binding) or the Worker refuses to start. */
function bareEnv(): Env {
  return { ...env, EMAIL_FROM: "", EMAIL: undefined, AUTH_EMAIL_VERIFICATION: "" } as unknown as Env;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  env?: Env;
  ip?: string;
}

let requestIp = 0;

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers();
  requestIp += 1;
  headers.set("cf-connecting-ip", options.ip ?? `203.0.113.${(requestIp % 200) + 10}`);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const request = new Request(`${BASE_URL}${path}`, { method: options.method ?? "GET", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, options.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** An env whose mail sender captures what the Worker hands it, and which can
 * also stand in for a deployment with no mail transport at all. */
function mailEnv(sender: (message: Message) => Promise<void> = async () => {}) {
  return { ...env, ...MAIL, EMAIL: { send: sender } } as unknown as Env;
}

interface Message {
  to: string;
  from: { email: string; name: string };
  subject: string;
  html: string;
  text: string;
}

const codes = () => {
  const captured: Message[] = [];
  return {
    captured,
    env: mailEnv(async (message) => { captured.push(message); }),
  };
};

async function signUp(email: string, password = PASSWORD, target: Env = mailEnv()) {
  return call("/api/auth/sign-up/email", {
    method: "POST",
    env: target,
    body: { email, password, name: email.split("@", 1)[0] },
  });
}

async function signIn(email: string, password = PASSWORD, target: Env = mailEnv()) {
  return call("/api/auth/sign-in/email", {
    method: "POST",
    env: target,
    body: { email, password },
  });
}

/** The server-only code mint, exactly as a Worker test can ask for it; it writes
 * the same hashed row the real send path writes. */
async function mintVerificationCode(email: string, target: Env = mailEnv()) {
  const ctx = createExecutionContext();
  const auth = createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "email-verification" } });
  await waitOnExecutionContext(ctx);
  return otp;
}

describe("password accounts", () => {
  it("publishes the sign-in ways without mail and needs none to sign up", async () => {
    const bare = bareEnv();
    const methods = await call("/v1/auth/methods", { env: bare });
    expect(methods.status).toBe(200);
    await expect(methods.json()).resolves.toEqual({
      password: { enabled: true, minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
      emailCode: { enabled: false },
      emailVerification: "off",
    });

    // The same answer over the ordinary fixture deployment, where mail exists.
    await expect((await call("/v1/auth/methods")).json()).resolves.toMatchObject({
      emailCode: { enabled: true },
      emailVerification: "required",
    });

    const response = await signUp("no-mail@example.com", PASSWORD, bare);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).toBeTruthy();
    const body = await response.json<{ user: { email: string }; token: string }>();
    expect(body.user.email).toBe("no-mail@example.com");
    expect(body.token).not.toBe(response.headers.get("set-auth-token"));
  });

  it("answers 503 for emailed codes when the deployment has no mail", async () => {
    const bare = bareEnv();
    for (const path of [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/email-otp",
      "/api/auth/email-otp/request-password-reset",
    ]) {
      const response = await call(path, { method: "POST", env: bare, body: { email: "person@example.com", type: "sign-in" } });
      expect(response.status, path).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "email_unavailable" });
    }
    // Password sign-in is untouched by the missing transport.
    expect((await signUp("still-works@example.com", PASSWORD, bare)).status).toBe(200);
    expect((await signIn("still-works@example.com", PASSWORD, bare)).status).toBe(200);
  });

  it("stores a password hash, never the password, and signs in with it", async () => {
    const bare = bareEnv();
    const email = "hash-check@example.com";
    const created = await signUp(email, PASSWORD, bare);
    expect(created.status).toBe(200);
    const stored = await env.DB.prepare(
      'SELECT password FROM "account" a JOIN "user" u ON u.id = a."userId" WHERE u.email = ?',
    ).bind(email).first<{ password: string }>();
    expect(stored?.password).toBeTruthy();
    expect(stored?.password).not.toContain(PASSWORD);
    // Better Auth's scrypt hash is `salt:hex`; a plain or reversible value would not match this shape.
    expect(stored?.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);

    const signedIn = await signIn(email, PASSWORD, bare);
    expect(signedIn.status).toBe(200);
    const token = signedIn.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    expect((await call("/v1/me", { token: token ?? "" })).status).toBe(200);

    const wrong = await signIn(email, "not the right password", bare);
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "invalid_credentials" });
    const unknown = await signIn("nobody@example.com", PASSWORD, bare);
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual({ error: "invalid_credentials" });
  });

  it("refuses a password outside the published range and a duplicate address", async () => {
    const bare = bareEnv();
    const short = await signUp("short@example.com", "short", bare);
    expect(short.status).toBe(400);
    await expect(short.json()).resolves.toEqual({ error: "password_too_short" });

    // With verification off a duplicate must not be reported as a fresh
    // account: the address is already taken and the person signs in instead.
    expect((await signUp("duplicate@example.com", PASSWORD, bare)).status).toBe(200);
    const again = await signUp("duplicate@example.com", PASSWORD, bare);
    expect(again.status).toBe(422);
    await expect(again.json()).resolves.toEqual({ error: "email_taken" });

    // With verification on the generic answer hides whether the address exists.
    const hidden = await signUp("duplicate@example.com");
    expect(hidden.status).toBe(200);
    await expect(hidden.json()).resolves.toMatchObject({ token: null });
  });

  it("emails a real code on sign-up when verification is required, then admits after confirming it", async () => {
    const mail = codes();
    const email = "verify-me@example.com";
    const created = await signUp(email, PASSWORD, mail.env);
    expect(created.status).toBe(200);
    expect(created.headers.get("set-auth-token"), "no session before the address is confirmed").toBeNull();
    await expect(created.json()).resolves.toMatchObject({ token: null, user: { email } });

    const message = mail.captured.at(-1);
    expect(message?.to).toBe(email);
    expect(message?.from.email).toBe("noreply@openmausbot.test");
    const code = message?.text.match(/\b\d{8}\b/)?.[0] ?? "";
    expect(code).toMatch(/^\d{8}$/);
    expect(message?.html).toContain(code);

    const refused = await signIn(email, PASSWORD, mail.env);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({ error: "email_not_verified" });

    const confirmed = await call("/api/auth/email-otp/verify-email", {
      method: "POST", env: mail.env, body: { email, otp: code },
    });
    expect(confirmed.status).toBe(200);

    const signedIn = await signIn(email, PASSWORD, mail.env);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
  });

  it("accepts a server-minted confirmation code exactly once", async () => {
    const email = "minted@example.com";
    expect((await signUp(email)).status).toBe(200);
    const otp = await mintVerificationCode(email);
    const first = await call("/api/auth/email-otp/verify-email", { method: "POST", body: { email, otp } });
    expect(first.status).toBe(200);
    const replay = await call("/api/auth/email-otp/verify-email", { method: "POST", body: { email, otp } });
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({ error: "invalid_otp" });
    expect((await signIn(email)).status).toBe(200);
  });

  it("resets a forgotten password with an emailed code", async () => {
    const mail = codes();
    const email = "reset@example.com";
    expect((await signUp(email, PASSWORD, mail.env)).status).toBe(200);

    const requested = await call("/api/auth/email-otp/request-password-reset", {
      method: "POST", env: mail.env, body: { email },
    });
    expect(requested.status).toBe(200);
    const code = mail.captured.at(-1)?.text.match(/\b\d{8}\b/)?.[0] ?? "";
    expect(code).toMatch(/^\d{8}$/);

    const reset = await call("/api/auth/email-otp/reset-password", {
      method: "POST", env: mail.env, body: { email, otp: code, password: "a brand new passphrase" },
    });
    expect(reset.status).toBe(200);
    expect((await signIn(email, PASSWORD, mail.env)).status).toBe(401);
    expect((await signIn(email, "a brand new passphrase", mail.env)).status).toBe(200);
  });

  it("keeps the old emailed sign-in code path working where mail exists", async () => {
    const email = "code-sign-in@example.com";
    expect((await signUp(email)).status).toBe(200);
    const otp = await mintVerificationCode(email);
    expect((await call("/api/auth/email-otp/verify-email", { method: "POST", body: { email, otp } })).status).toBe(200);

    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readAuthConfig(env), crypto.randomUUID());
    const signInCode = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const response = await call("/api/auth/sign-in/email-otp", {
      method: "POST", body: { email, otp: signInCode, name: "code" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).toBeTruthy();
  });
});

describe("operator lookup follows the deployment's verification policy", () => {
  /** A verified operator, created the way this deployment can create one:
   * emailed code with mail, password without it. */
  async function operatorFor(target: Env) {
    const email = `operator-${crypto.randomUUID()}@example.com`;
    let bearer: string | null;
    if (target.EMAIL === undefined) {
      expect((await signUp(email, PASSWORD, target)).status).toBe(200);
      bearer = (await signIn(email, PASSWORD, target)).headers.get("set-auth-token");
    } else {
      const ctx = createExecutionContext();
      const auth = createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID());
      const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
      await waitOnExecutionContext(ctx);
      bearer = (await call("/api/auth/sign-in/email-otp", {
        method: "POST", env: target, body: { email, otp, name: "operator" },
      })).headers.get("set-auth-token");
    }
    expect(bearer).toBeTruthy();
    const me = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<{ id: string }>();
    expect(me?.id).toBeTruthy();
    return {
      bearer: bearer ?? "",
      userId: me?.id ?? "",
      env: { ...target, AI_OPERATOR_USER_IDS: JSON.stringify([me?.id]) } as unknown as Env,
    };
  }

  it("finds an unconfirmed password account when verification is off, and says so", async () => {
    const bare = bareEnv();
    const operator = await operatorFor(bare);
    const targetEmail = "policy-off@example.com";
    expect((await signUp(targetEmail, PASSWORD, bare)).status).toBe(200);
    const targetId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(targetEmail)
      .first<{ id: string }>())?.id ?? "";

    const lookup = await call(`/v1/operator/ai/account?email=${encodeURIComponent(targetEmail)}`, {
      token: operator.bearer, env: operator.env,
    });
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      account: { userId: targetId, email: targetEmail, emailVerified: false, state: "pending" },
    });

    // And the operator can grant it AI access without pretending it is verified.
    const enabled = await call("/v1/operator/ai/account", {
      method: "POST", token: operator.bearer, env: operator.env,
      body: { operationId: crypto.randomUUID(), userId: targetId, enabled: true, reason: "local deployment" },
    });
    expect(enabled.status).toBe(200);
    const verified = await env.DB.prepare('SELECT "emailVerified" FROM "user" WHERE id = ?')
      .bind(targetId).first<{ emailVerified: number }>();
    expect(verified?.emailVerified).toBe(0);
  });

  it("still hides an unconfirmed address when verification is required", async () => {
    const operator = await operatorFor(env);
    const targetEmail = "policy-on@example.com";
    expect((await signUp(targetEmail, PASSWORD, env)).status).toBe(200);

    const lookup = await call(`/v1/operator/ai/account?email=${encodeURIComponent(targetEmail)}`, {
      token: operator.bearer, env: operator.env,
    });
    expect(lookup.status).toBe(404);

    const confirmed = await call("/api/auth/email-otp/verify-email", {
      method: "POST", env: env, body: { email: targetEmail, otp: await mintVerificationCode(targetEmail) },
    });
    expect(confirmed.status).toBe(200);
    const after = await call(`/v1/operator/ai/account?email=${encodeURIComponent(targetEmail)}`, {
      token: operator.bearer, env: operator.env,
    });
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({ account: { emailVerified: true } });
  });
});

describe("verification configuration", () => {
  it("reads the toggle and refuses to require mail it cannot send", () => {
    const base = { ...env } as unknown as Env;
    expect(readAuthConfig(base).emailVerification).toBe("required");
    const off = readAuthConfig({ ...base, AUTH_EMAIL_VERIFICATION: "off" } as unknown as Env);
    expect(off.emailVerification).toBe("off");
    expect(off.mailConfigured).toBe(true);
    const mailLess = { ...base, EMAIL_FROM: "", EMAIL: undefined, AUTH_EMAIL_VERIFICATION: "" } as unknown as Env;
    expect(readAuthConfig(mailLess)).toMatchObject({ emailFrom: null, mailConfigured: false, emailVerification: "off" });
    expect(() => readAuthConfig({ ...mailLess, AUTH_EMAIL_VERIFICATION: "required" }))
      .toThrow(/AUTH_EMAIL_VERIFICATION/);
    // A stale `required` in a deployment whose transport disappeared is an
    // error, not a silent switch: no one would receive the code.
    expect(() => readAuthConfig({ ...base, EMAIL_FROM: "", EMAIL: undefined } as unknown as Env))
      .toThrow(/AUTH_EMAIL_VERIFICATION/);
    expect(() => readAuthConfig({ ...base, AUTH_EMAIL_VERIFICATION: "maybe" } as unknown as Env))
      .toThrow(/AUTH_EMAIL_VERIFICATION/);
  });

  it("keeps the verification callback wired so a required sign-up can be confirmed", async () => {
    const mail = codes();
    const email = "callback@example.com";
    await signUp(email, PASSWORD, mail.env);
    expect(mail.captured).toHaveLength(1);
    // The message is the same shape Cloudflare Email Sending takes.
    expect(Object.keys(mail.captured[0]!).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(mail.captured[0]!.subject).toMatch(/verify/i);

    // A failed delivery must not turn into an error the caller can tell
    // apart: the sign-up answer stays generic and the account still exists.
    const failing = { ...env, ...MAIL, EMAIL: { send: async () => { throw new Error(`smtp rejected ${email}`); } } } as unknown as Env;
    const silent = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await signUp("undeliverable@example.com", PASSWORD, failing);
    const logged = silent.mock.calls.flat().join(" ");
    silent.mockRestore();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token: null });
    expect(logged).not.toContain("undeliverable@example.com");
    expect(logged).not.toContain("smtp rejected");
  });
});
