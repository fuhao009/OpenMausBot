import { z } from "zod";

import { accountSession, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type ControlPlaneAuth } from "./auth";
import { HTTPError, JSON_HEADERS, readBoundedJSON } from "./http";
import { sha256 } from "./installations";

const actionSchema = z.strictObject({
  operationId: z.uuid(),
  reason: z.string().trim().min(1).max(500).refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point === undefined || point < 32 || point === 127) return false;
    }
    return true;
  }),
});
const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
type Kind = "disable" | "delete" | "reset-password";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: JSON_HEADERS });

/** Must run before other account routes. Restricted reset sessions are accepted only here. */
export async function routeAccountLifecycle(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  operatorUserIds: ReadonlySet<string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const operatorRoute = /^\/v1\/operator\/accounts\/([^/]+)\/(disable|delete|reset-password)$/.exec(path);
  if (path !== "/v1/account/change-password" && !operatorRoute) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  if (!operatorRoute) return changeTemporaryPassword(request, env, auth);
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  if (!operatorUserIds.has(session.user.id)) throw new HTTPError(403, "forbidden");
  const parsed = actionSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const userId = decodeURIComponent(operatorRoute[1]);
  if (userId.length < 1 || userId.length > 128) throw new HTTPError(400, "invalid_request");
  const kind = operatorRoute[2] as Kind;
  const { operationId, reason } = parsed.data;
  const bodyHash = await sha256(JSON.stringify([session.user.id, userId, kind, reason]));
  const previous = await env.DB.prepare("SELECT body_hash FROM account_lifecycle_audit WHERE operation_id=?").bind(operationId).first<{ body_hash: string }>();
  if (previous) {
    if (previous.body_hash !== bodyHash) throw new HTTPError(409, "operation_conflict");
    return json({ operationId, userId, kind, replayed: true });
  }
  // 32 random bytes rendered as hex: 256 bits, safely inside registration's policy.
  const temporaryPassword = kind === "reset-password"
    ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    : undefined;
  const passwordHash = temporaryPassword ? await (await auth.$context).password.hash(temporaryPassword) : null;
  try {
    const result = await env.DB.prepare(`INSERT INTO account_lifecycle_audit
      (operation_id, operator_user_id, user_id, kind, reason, body_hash, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING`)
      .bind(operationId, session.user.id, userId, kind, reason, bodyHash, passwordHash, Date.now()).run();
    if (!result.meta.changes) {
      const winner = await env.DB.prepare("SELECT body_hash FROM account_lifecycle_audit WHERE operation_id=?").bind(operationId).first<{ body_hash: string }>();
      if (winner?.body_hash !== bodyHash) throw new HTTPError(409, "operation_conflict");
      return json({ operationId, userId, kind, replayed: true });
    }
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    const message = String(error);
    if (message.includes("account_not_found")) throw new HTTPError(404, "not_found");
    if (/account_(delete_conflict|reset_conflict|deleted)/.test(message)) throw new HTTPError(409, "account_lifecycle_conflict");
    throw error;
  }
  return json({ operationId, userId, kind, replayed: false, ...(temporaryPassword ? { temporaryPassword } : {}) });
}

async function changeTemporaryPassword(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.match(/^Bearer\s+[^\s]+$/i)) throw new HTTPError(401, "unauthorized");
  const session = await auth.api.getSession({ headers: new Headers({ authorization }) });
  if (!session) throw new HTTPError(401, "unauthorized");
  const state = await env.DB.prepare("SELECT password_change_required, disabled, deleted FROM account_lifecycle WHERE user_id=?")
    .bind(session.user.id).first<{ password_change_required: number; disabled: number; deleted: number }>();
  if (state?.disabled || state?.deleted) throw new HTTPError(401, "unauthorized");
  if (!state?.password_change_required) throw new HTTPError(409, "password_change_not_required");
  const parsed = passwordSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  if (parsed.data.currentPassword === parsed.data.newPassword) throw new HTTPError(400, "password_unchanged");
  const credential = await env.DB.prepare(`SELECT password FROM "account" WHERE "userId"=? AND "providerId"='credential'`).bind(session.user.id).first<{ password: string }>();
  const context = await auth.$context;
  if (!credential || !await context.password.verify({ hash: credential.password, password: parsed.data.currentPassword })) throw new HTTPError(401, "invalid_password");
  const passwordHash = await context.password.hash(parsed.data.newPassword);
  const operationId = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO account_lifecycle_audit
    (operation_id, operator_user_id, user_id, kind, reason, body_hash, password_hash, created_at)
    SELECT ?, ?, ?, 'change-password', 'Required password change', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM "session" WHERE id=? AND "userId"=?)
      AND EXISTS (SELECT 1 FROM "account" WHERE "userId"=? AND "providerId"='credential' AND password=?)`)
    .bind(operationId, session.user.id, session.user.id, await sha256(operationId), passwordHash, Date.now(), session.session.id, session.user.id, session.user.id, credential.password).run();
  if (!result.meta.changes) throw new HTTPError(409, "password_change_conflict");
  return json({ changed: true, requiresSignIn: true });
}
