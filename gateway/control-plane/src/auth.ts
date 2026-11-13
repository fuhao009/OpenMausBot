import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";

import type { AuthConfig, EmailVerificationMode } from "./config";
import { sendOTPEmail } from "./email";

/**
 * The auth instance for one request.
 *
 * Email and password sign-up is always enabled: a person creates an account
 * with a password and no mail transport is needed. Email codes stay available
 * wherever mail is configured (sign-in, password reset, email confirmation).
 * `AUTH_EMAIL_VERIFICATION=required` makes a password sign-up prove the address
 * before it gets a session; `off` (also the fallback with no mail) lets it sign
 * in immediately. Either way the account starts with no AI permission and no
 * balance: an operator grants those later.
 *
 * Passwords are hashed by Better Auth's own hasher (scrypt; it uses
 * `node:crypto`, which Workers supports). No plaintext password is logged,
 * returned or stored, and no mail address or code reaches a log line.
 */
/** The password policy the sign-up form shows and Better Auth enforces. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const databases = new WeakMap<object, D1Database>();

export function createAuth(
  env: Env,
  ctx: ExecutionContext,
  config: AuthConfig,
  requestId: string,
) {
  const mailFrom = config.mailConfigured ? config.emailFrom : null;
  const requireVerification = config.emailVerification === "required";

  const auth = betterAuth({
    appName: "Hezuo",
    baseURL: config.authBaseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [...config.allowedOrigins],
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const email = context.body?.email;
        if (typeof email === "string") {
          const lifecycle = await env.DB.prepare(`SELECT l.disabled, l.deleted, l.password_change_required FROM account_lifecycle l JOIN "user" u ON u.id=l.user_id WHERE lower(u.email)=lower(?)`).bind(email).first<{ disabled: number; deleted: number; password_change_required: number }>();
          if (lifecycle?.disabled || lifecycle?.deleted) throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
          if (!context.path.startsWith("/sign-in/") && context.path !== "/sign-up/email" && lifecycle?.password_change_required) {
            throw new APIError("FORBIDDEN", { message: "password_change_required" });
          }
        }
        if (context.path === "/get-session" || context.path === "/sign-out") return;
        const session = await getSessionFromCtx(context);
        if (!session) return;
        const state = await env.DB.prepare("SELECT disabled, deleted, password_change_required FROM account_lifecycle WHERE user_id=?").bind(session.user.id).first<{ disabled: number; deleted: number; password_change_required: number }>();
        if (state?.disabled || state?.deleted) throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
        if (state?.password_change_required) throw new APIError("FORBIDDEN", { message: "password_change_required" });
      }),
      after: createAuthMiddleware(async (context) => {
        const session = context.context.newSession;
        if (!session) return;
        if (context.path === "/sign-in/email" && typeof context.body?.password === "string") {
          const credential = await env.DB.prepare(`SELECT password FROM "account" WHERE "userId"=? AND "providerId"='credential'`).bind(session.user.id).first<{ password: string }>();
          if (!credential || !await context.context.password.verify({ hash: credential.password, password: context.body.password })) {
            await context.context.internalAdapter.deleteSession(session.session.token);
            throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
          }
        }
        const state = await env.DB.prepare("SELECT disabled, deleted, password_change_required FROM account_lifecycle WHERE user_id=?").bind(session.user.id).first<{ disabled: number; deleted: number; password_change_required: number }>();
        if (state?.disabled || state?.deleted) {
          await context.context.internalAdapter.deleteSession(session.session.token);
          throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
        }
        if (context.context.returned && typeof context.context.returned === "object") {
          context.context.returned = { ...context.context.returned, requiresPasswordChange: Boolean(state?.password_change_required) };
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: requireVerification,
      autoSignIn: !requireVerification,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    // Better Auth would otherwise delete expired verification rows inline on
    // every OTP check (two serial D1 round trips). Expired codes still fail
    // their expiresAt check; the sweep runs after the sign-in response.
    verification: { disableCleanup: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
        // Password guesses are the one unauthenticated path with a cheap
        // success signal, so they get the tightest rule of all.
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/email-otp/request-password-reset": { window: 60, max: 5 },
        "/email-otp/reset-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: true,
      ipAddress: {
        // Cloudflare writes this header at the edge. Do not trust a client-
        // supplied x-forwarded-for chain for rate limits or session metadata.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      // Better Auth 1.7.3+ introspects D1 as each auth instance starts (once per
      // request here) and makes auth requests wait on it: one more D1 round trip
      // per request for a schema the pinned migrations already fix.
      database: { generateId: "uuid", validateSchema: false },
      backgroundTasks: {
        handler(promise) {
          ctx.waitUntil(promise);
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 5 },
        // With a transport the plugin supplies Better Auth's emailVerification
        // callback, so a required sign-up sends an `email-verification` code
        // here and `/api/auth/email-otp/verify-email` confirms it. Without one
        // there is nothing to send with: Better Auth then reports verification
        // as unavailable instead of calling a transport that does not exist.
        overrideDefaultEmailVerification: mailFrom !== null,
        async sendVerificationOTP(input) {
          // No transport: the endpoint answers 503 before reaching this, and a
          // code that cannot be delivered is never left behind in D1.
          if (mailFrom === null) throw new Error("mail_unavailable");
          await sendOTPEmail({
            async send(message) {
              await env.EMAIL.send(message);
            },
          }, mailFrom, input, requestId);
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
  databases.set(auth, env.DB);
  return auth;
}

/** The instance this module builds. Its API surface is inferred from the exact
 * plugin set above (email OTP, bearer), so consumers import this name rather
 * than re-describing methods they would then have to keep in step. */
export type ControlPlaneAuth = ReturnType<typeof createAuth>;

/** The account policy a route needs without the full auth config: whether this
 * deployment confirms an address before a password account signs in. */
export interface AuthPolicy {
  emailVerification: EmailVerificationMode;
  mailConfigured: boolean;
}

/**
 * The expired-verification cleanup that `verification.disableCleanup` turns
 * off, as a single DELETE. It calls the adapter directly, so it skips
 * verification delete hooks. None are registered (emailOTP and bearer add
 * none); revisit this if databaseHooks are added or better-auth is upgraded.
 */
export async function deleteExpiredVerifications(auth: ControlPlaneAuth): Promise<void> {
  const context = await auth.$context;
  await context.adapter.deleteMany({
    model: "verification",
    where: [{ field: "expiresAt", operator: "lt", value: new Date() }],
  });
}

export async function accountSession(request: Request, auth: ControlPlaneAuth) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].startsWith("omb_install_") || match[1].startsWith("omb_product_ai_")) return null;

  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${match[1]}` }),
  });
  if (!session) return null;
  const state = await databases.get(auth)?.prepare("SELECT disabled, deleted, password_change_required FROM account_lifecycle WHERE user_id=?").bind(session.user.id).first<{ disabled: number; deleted: number; password_change_required: number }>();
  if (state?.disabled || state?.deleted || state?.password_change_required) return null;
  return session;
}
