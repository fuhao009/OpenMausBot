import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const ORIGIN = "https://auth.hezuo.test";
const PASSWORD = "test-only-admin-password";
const PUBLIC_MODEL = {
  id: "fixture-model",
  label: "Fixture model",
  protocol: "chat",
  pricingVersion: "fixture-v1",
  inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000,
  outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1_000,
  maxOutputTokens: 100,
};
const MODEL = { ...PUBLIC_MODEL, upstreamModel: "fixture/private-model", chatMaxTokensField: "max_tokens", enabled: true };

function deployment(operatorIds: string[] = []): Env {
  return {
    ...env,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "test-only-gateway-admin-secret-with-32-characters",
    AUTH_EMAIL_VERIFICATION: "off",
    EMAIL_FROM: "",
    EMAIL: undefined,
    AI_OPERATOR_USER_IDS: JSON.stringify(operatorIds),
    AI_UPSTREAM_API_KEY: "test-only-gateway-admin-upstream-key",
    AI_UPSTREAM_BASE_URL: "https://private-upstream.example.test/v1",
    AI_DEFAULT_MODEL: MODEL.id,
    AI_MODELS: JSON.stringify([MODEL, { ...MODEL, id: "disabled-model", enabled: false }]),
  } as unknown as Env;
}

async function call(target: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signUp(target: Env, name: string) {
  const email = `${name}@example.test`;
  const response = await call(target, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.15" },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("Password sign-up did not issue a signed bearer");
  const { user } = await response.json<{ user: { id: string } }>();
  return { user: { id: user.id, email, name }, init: { headers: { authorization: `Bearer ${token}` } } };
}

describe("GET /v1/operator/me", () => {
  it("returns 401 without an account session", async () => {
    const response = await call(deployment(), "/v1/operator/me");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 403 for a signed-in account not on the operator allowlist", async () => {
    const target = deployment();
    const operator = await signUp(target, "operator");
    const ordinary = await signUp(target, "ordinary");
    const configured = deployment([operator.user.id]);
    expect((await call(configured, "/v1/me", ordinary.init)).status).toBe(200);
    const response = await call(configured, "/v1/operator/me", ordinary.init);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("returns only the operator identity, public capabilities, and enabled public model fields", async () => {
    const operator = await signUp(deployment(), "operator");
    const response = await call(deployment([operator.user.id]), "/v1/operator/me", operator.init);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      user: operator.user,
      capabilities: { ai: true, password: true, emailCode: false, emailVerification: "off" },
      models: [PUBLIC_MODEL],
    });
  });
});
