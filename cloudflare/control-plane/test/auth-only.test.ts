import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import { readAuthConfig, readConfig } from "../src/config";

it("keeps authentication health available without tunnel credentials", async () => {
  const authOnly = { ...env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_ZONE_ID: "" } as unknown as Env;
  expect(readAuthConfig(authOnly).authBaseURL).toBe(env.BETTER_AUTH_URL);
  expect(() => readConfig(authOnly)).toThrow();
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${env.BETTER_AUTH_URL}/healthz`), authOnly, ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "openmausbot-control-plane" });
  await waitOnExecutionContext(ctx);
});

it("reports unavailable tunnel mutation without disabling account routes", async () => {
  const authOnly = { ...env, CLOUDFLARE_API_TOKEN: "" };
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${env.BETTER_AUTH_URL}/v1/installations/self/endpoint`, { method: "POST" }), authOnly, ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "endpoint_unavailable" });
  const me = await worker.fetch(new Request(`${env.BETTER_AUTH_URL}/v1/me`), authOnly, ctx);
  expect(me.status).toBe(401);
  await waitOnExecutionContext(ctx);
});
