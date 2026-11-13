import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth, accountSession, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../src/auth";
import { readAuthConfig } from "../src/config";
import { routeAccountLifecycle } from "../src/account-lifecycle";
import { HTTPError } from "../src/http";

const target = { ...env, EMAIL_FROM: "", EMAIL: undefined, AUTH_EMAIL_VERIFICATION: "" } as unknown as Env;
const password = "original-password-1234";
let ip = 0;
interface FixtureAccount { id: string; email: string; token: string }
function request(path: string, body?: unknown, token?: string) {
  return new Request(`https://auth.hezuo.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${++ip}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function authCall(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID()).handler(request(path, body));
  await waitOnExecutionContext(ctx);
  return response;
}
async function fixture(): Promise<FixtureAccount> {
  const email = `${crypto.randomUUID()}@example.test`;
  const response = await authCall("/api/auth/sign-up/email", { email, password, name: "Private Name" });
  expect(response.status).toBe(200);
  const data = await response.json() as { user: { id: string } };
  return { id: data.user.id, email, token: response.headers.get("set-auth-token")! };
}
async function action(operator: FixtureAccount, userId: string, kind: string, operationId = crypto.randomUUID(), reason = "Support request") {
  const ctx = createExecutionContext();
  try {
    return await routeAccountLifecycle(request(`/v1/operator/accounts/${userId}/${kind}`, { operationId, reason }, operator.token), target,
      createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID()), new Set([operator.id]));
  } finally { await waitOnExecutionContext(ctx); }
}

describe("isolated account lifecycle", () => {
  it("requires an operator and rejects malformed mutation bodies", async () => {
    const user = await fixture();
    const ctx = createExecutionContext();
    const auth = createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID());
    await expect(routeAccountLifecycle(request(`/v1/operator/accounts/${user.id}/disable`, { operationId: crypto.randomUUID(), reason: "Denied" }, user.token), target, auth, new Set())).rejects.toBeInstanceOf(HTTPError);
    await expect(routeAccountLifecycle(request(`/v1/operator/accounts/${user.id}/disable`, { operationId: "bad", reason: "" }, user.token), target, auth, new Set([user.id]))).rejects.toBeInstanceOf(HTTPError);
    await waitOnExecutionContext(ctx);
  });

  it("disables login and sessions atomically, auditing once and rejecting changed retries", async () => {
    const operator = await fixture(); const user = await fixture(); const operationId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO account_ai_tokens(id, owner_user_id, session_id, device_id, lookup_id, secret_hash, created_at, expires_at)
      VALUES (?, ?, 'old-session', 'device', 'abcdefghijklmnopqrstuv', ?, 1, ?)`).bind(crypto.randomUUID(), user.id, "0".repeat(64), Date.now() + 60000).run();
    expect((await action(operator, user.id, "disable", operationId))?.status).toBe(200);
    expect((await action(operator, user.id, "disable", operationId))?.status).toBe(200);
    await expect(action(operator, user.id, "disable", operationId, "Different reason")).rejects.toBeInstanceOf(HTTPError);
    expect((await authCall("/api/auth/sign-in/email", { email: user.email, password })).status).toBe(401);
    expect(await env.DB.prepare('SELECT id FROM "session" WHERE "userId"=?').bind(user.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM account_ai_tokens WHERE owner_user_id=? AND revoked_at IS NULL").bind(user.id).first()).toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM account_lifecycle_audit WHERE operation_id=?").bind(operationId).first<{ n: number }>())?.n).toBe(1);
  });

  it("reveals a temporary password once and confines its session until a password replacement", async () => {
    const operator = await fixture(); const user = await fixture(); const operationId = crypto.randomUUID();
    const result = await (await action(operator, user.id, "reset-password", operationId))!.json() as { temporaryPassword: string };
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(result.temporaryPassword.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
    expect(await (await action(operator, user.id, "reset-password", operationId))!.json()).not.toHaveProperty("temporaryPassword");
    expect((await authCall("/api/auth/sign-in/email", { email: user.email, password })).status).toBe(401);
    const login = await authCall("/api/auth/sign-in/email", { email: user.email, password: result.temporaryPassword });
    expect(login.status).toBe(200);
    expect(await login.json()).toHaveProperty("requiresPasswordChange", true);
    const token = login.headers.get("set-auth-token")!;
    const ctx = createExecutionContext(); const auth = createAuth(target, ctx, readAuthConfig(target), crypto.randomUUID());
    expect(await accountSession(request("/v1/me", undefined, token), auth)).toBeNull();
    const newPassword = "replacement-password-5678";
    const changed = await routeAccountLifecycle(request("/v1/account/change-password", { currentPassword: result.temporaryPassword, newPassword }, token), target, auth, new Set());
    expect(changed?.status).toBe(200);
    expect((await authCall("/api/auth/sign-in/email", { email: user.email, password: result.temporaryPassword })).status).toBe(401);
    expect((await authCall("/api/auth/sign-in/email", { email: user.email, password: newPassword })).status).toBe(200);
    const audit = await env.DB.prepare("SELECT * FROM account_lifecycle_audit WHERE user_id=?").bind(user.id).all();
    expect(JSON.stringify(audit)).not.toContain(result.temporaryPassword);
    expect(JSON.stringify(audit)).not.toContain(newPassword);
    await waitOnExecutionContext(ctx);
  });

  it("blocks deletion with held funds, then anonymizes identity without deleting ledger", async () => {
    const operator = await fixture(); const user = await fixture();
    await env.DB.prepare("INSERT INTO account_ai_balances(owner_user_id, enabled, available_micro_points, reserved_micro_points, updated_at) VALUES (?,1,99,1,0)").bind(user.id).run();
    await expect(action(operator, user.id, "delete")).rejects.toBeInstanceOf(HTTPError);
    await env.DB.prepare("UPDATE account_ai_balances SET reserved_micro_points=0 WHERE owner_user_id=?").bind(user.id).run();
    await env.DB.prepare(`INSERT INTO account_ai_requests(id, owner_user_id, token_id, model, endpoint, pricing_version,
      input_rate, cached_rate, output_rate, max_input_tokens, max_output_tokens, reserved_micro_points, state, created_at, updated_at)
      VALUES ('review-test', ?, 'token', 'model', 'chat', 'v1', 0, 0, 0, 1, 1, 0, 'review', 1, 1)`).bind(user.id).run();
    await expect(action(operator, user.id, "delete")).rejects.toBeInstanceOf(HTTPError);
    await env.DB.prepare("UPDATE account_ai_requests SET state='settled', charged_micro_points=0 WHERE id='review-test'").run();
    expect((await action(operator, user.id, "delete"))?.status).toBe(200);
    const identity = await env.DB.prepare('SELECT * FROM "user" WHERE id=?').bind(user.id).first();
    expect(JSON.stringify(identity)).not.toContain(user.email);
    expect((await env.DB.prepare("SELECT available_micro_points FROM account_ai_balances WHERE owner_user_id=?").bind(user.id).first<{ available_micro_points: number }>())?.available_micro_points).toBe(99);
  });
});
