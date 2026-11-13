import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneError,
  createControlPlaneClient,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";

/** A throwaway certificate for 127.0.0.1, or null where openssl is absent. */
function certificate(altName = "IP:127.0.0.1", commonName = "127.0.0.1") {
  const directory = mkdtempSync(join(tmpdir(), "omb-client-ca-"));
  try {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-subj", `/CN=${commonName}`, "-addext", `subjectAltName=${altName}`], { stdio: "pipe" });
    if (made.status !== 0) return null;
    return { pem: readFileSync(join(directory, "cert.pem"), "utf8"), key: readFileSync(join(directory, "key.pem"), "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A real TLS server on 127.0.0.1, so the client's own handshake is exercised. */
async function startTls(fixture, handler) {
  const server = createServer({ key: fixture.key, cert: fixture.pem }, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, close: () => { server.closeAllConnections(); server.close(); } };
}

const ACCOUNT = `signed.${"a".repeat(40)}`;
const INSTALL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const INSTALL_ID = "11111111-1111-4111-8111-111111111111";
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("control-plane desktop client", () => {
  it.each([9, 129])("rejects a %i-character password before transport", async length => {
    const fetchImpl = vi.fn();
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    for (const method of ["signUpWithPassword", "signInWithPassword"]) {
      await expect(client[method]("ada@example.com", "x".repeat(length))).rejects.toMatchObject({ code: "invalid_password" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([10, 128])("sends a %i-character password unchanged", async length => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).password).toBe("x".repeat(length));
      return jsonResponse({ user: { id: "user-1", email: "ada@example.com" }, token: null });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await client.signUpWithPassword("ada@example.com", "x".repeat(length));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("recovers one installation registration conflict without replaying creation", async () => {
    let listings = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/v1/installations") && init.method !== "POST") {
        return jsonResponse({ installations: listings++ === 0 ? [] : [{ id: INSTALL_ID, clientInstanceId: "client-1", name: "Mac", platform: "darwin" }] });
      }
      if (url.endsWith("/v1/installations")) return jsonResponse({ error: "installation_exists" }, { status: 409 });
      return jsonResponse({ credential: INSTALL, credentialExpiresAt: Date.now() + 100_000 }, { status: 201 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureInstallation({ accountToken: ACCOUNT, clientInstanceId: "client-1", name: "Mac", platform: "darwin" })).resolves.toMatchObject({ credential: INSTALL });
    expect(fetchImpl.mock.calls.filter(([url, init]) => url.endsWith("/v1/installations") && init.method === "POST")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/credentials/rotate"))).toHaveLength(1);
  });

  it("accepts exact HTTPS and loopback development origins only", () => {
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/")).toBe(
      "https://accounts.openmausbot.com",
    );
    expect(normalizeControlPlaneURL("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeControlPlaneURL("http://accounts.openmausbot.com")).toBe("");
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/api")).toBe("");
    expect(normalizeControlPlaneURL("https://user:secret@accounts.openmausbot.com")).toBe("");
  });

  it("normalizes an email without accepting malformed input", () => {
    expect(normalizeAccountEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAccountEmail("not-an-email")).toBe("");
    expect(normalizeAccountEmail(new String("ada@example.com"))).toBe("");
    expect(normalizeControlPlaneURL({ toString: () => "https://accounts.openmausbot.com" })).toBe("");
  });

  it("accepts plain cross-realm response records", async () => {
    const payload = runInNewContext(
      "({ user: { id: 'user-1', email: 'ada@example.com' } })",
    );
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "set-auth-token": ACCOUNT }),
        json: async () => payload,
      })),
    });

    await expect(client.verifyOTP("ada@example.com", "12345678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
  });

  it("rejects non-plain response records instead of coercing them", async () => {
    class Payload {
      constructor() {
        this.user = { id: "user-1", email: "ada@example.com" };
      }
    }
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => new Payload(),
      })),
    });

    await expect(client.me(ACCOUNT)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses a pinned transport for its own origin when a certificate is bundled", async () => {
    const fixture = certificate();
    if (!fixture) return;
    // A certificate for another host is refused at construction, never used loosely.
    const elsewhere = certificate("DNS:accounts.example", "accounts.example");
    if (elsewhere) {
      expect(() => createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", ca: elsewhere.pem })).toThrow(ControlPlaneError);
    }
    expect(() => createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", ca: "not a certificate" })).toThrow(ControlPlaneError);

    const server = await startTls(fixture, (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "openmausbot-control-plane" }));
    });
    try {
      // No NODE_EXTRA_CA_CERTS and no global trust change: the bundled
      // certificate is the only reason this self-signed server verifies.
      const client = createControlPlaneClient({ baseURL: server.origin, ca: fixture.pem });
      await expect(client.health()).resolves.toBe(true);
      // The same bundle cannot be pointed at a sibling host through the client.
      expect(() => createControlPlaneClient({ baseURL: server.origin.replace("127.0.0.1", "localhost"), ca: fixture.pem })).toThrow(ControlPlaneError);
    } finally {
      server.close();
    }
  });

  it("requires the exact healthy control-plane identity before onboarding", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "openmausbot-control-plane" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "some-other-service" }));
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
      timeoutSignal,
    });

    await expect(client.health()).resolves.toBe(true);
    await expect(client.health()).rejects.toMatchObject({
      code: "control_plane_unavailable",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://accounts.openmausbot.com/healthz");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
    expect(fetchImpl.mock.calls[0][1].headers.get("origin")).toBeNull();
    expect(timeoutSignal).toHaveBeenNthCalledWith(1, 3_000);
  });

  it("uses the signed Better Auth bearer header, never its raw JSON token", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({
        email: "ada@example.com",
        otp: "12345678",
        name: "ada",
      });
      return jsonResponse(
        { token: "raw-database-token-must-not-be-used", user: { id: "user-1", email: "ada@example.com" } },
        { headers: { "set-auth-token": ACCOUNT } },
      );
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.verifyOTP("Ada@Example.com", "1234-5678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("raw-database-token-must-not-be-used");
  });

  it("signs up and in with a password, keeping only the signed bearer", async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => {
      seen.push({ url, body: init.body === undefined ? null : JSON.parse(init.body), origin: init.headers.get("origin") });
      if (url.endsWith("/api/auth/sign-up/email")) {
        // A deployment that requires confirmation creates the account but
        // withholds the session: no set-auth-token header at all.
        return jsonResponse({ token: null, user: { id: "user-1", email: "ada@example.com" } });
      }
      if (url.endsWith("/api/auth/sign-in/email")) {
        return jsonResponse(
          { token: "raw-database-token", user: { id: "user-1", email: "ada@example.com" } },
          { headers: { "set-auth-token": ACCOUNT } },
        );
      }
      return jsonResponse({ password: { enabled: true, minLength: 10, maxLength: 128 }, emailCode: { enabled: false }, emailVerification: "off" });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });

    await expect(client.signUpWithPassword(" Ada@Example.com ", "correct horse battery")).resolves.toEqual({
      accountToken: null,
      user: { id: "user-1", email: "ada@example.com" },
    });
    await expect(client.signInWithPassword("ada@example.com", "correct horse battery")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
    await expect(client.authMethods()).resolves.toEqual({
      password: { enabled: true, minLength: 10, maxLength: 128 },
      emailCode: { enabled: false },
      emailVerification: "off",
    });

    expect(seen.find((entry) => entry.url.endsWith("/sign-up/email")).body)
      .toEqual({ email: "ada@example.com", password: "correct horse battery", name: "ada" });
    expect(seen.find((entry) => entry.url.endsWith("/sign-in/email")).body)
      .toEqual({ email: "ada@example.com", password: "correct horse battery" });
    // Better Auth mutations carry the trusted origin (Better Auth 1.7 CSRF
    // rule); the public discovery read does not need it.
    const mutations = seen.filter((entry) => entry.url.includes("/api/auth/"));
    expect(mutations).toHaveLength(2);
    expect(mutations.every((entry) => entry.origin === "https://accounts.openmausbot.com")).toBe(true);
  });

  it("refuses a malformed password answer instead of treating it as signed in", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/auth/sign-in/email")) {
        // No set-auth-token: the raw JSON token is never an acceptable bearer.
        return jsonResponse({ token: "raw-database-token", user: { id: "user-1", email: "ada@example.com" } });
      }
      return jsonResponse({ password: { enabled: true, minLength: 1, maxLength: 4 }, emailCode: { enabled: true }, emailVerification: "irrelevant" });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });

    await expect(client.signInWithPassword("ada@example.com", "correct horse battery")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(client.authMethods()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.signUpWithPassword("not-an-email", "correct horse battery")).rejects.toMatchObject({
      code: "invalid_email",
    });
    await expect(client.signInWithPassword("ada@example.com", "")).rejects.toMatchObject({ code: "invalid_password" });
  });

  it("identifies native Better Auth mutations with the trusted control-plane origin", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      // Undici adds Fetch Metadata after our wrapper; Better Auth 1.7 forbids a browser-shaped request without a trusted Origin.
      const wireHeaders = new Headers(init.headers);
      wireHeaders.set("sec-fetch-mode", "cors");
      if (wireHeaders.has("sec-fetch-mode") && wireHeaders.get("origin") !== "https://accounts.openmausbot.com") {
        return jsonResponse({ error: "forbidden" }, { status: 403 });
      }
      return jsonResponse({ success: true });
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.requestOTP("ada@example.com")).resolves.toEqual({
      email: "ada@example.com",
    });
    expect(fetchImpl.mock.calls[0][1].headers.get("origin")).toBe(
      "https://accounts.openmausbot.com",
    );
  });

  it("keeps a valid installation credential without rotating it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self");
      return jsonResponse({
        installation: {
          id: INSTALL_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        },
        credentialExpiresAt: Date.now() + 10_000,
      });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    const result = await client.ensureInstallation({
      accountToken: ACCOUNT,
      currentCredential: INSTALL,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    });
    expect(result.credential).toBe(INSTALL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost installation credential by rotating the matching identity", async () => {
    const rotated = `omb_install_${"c".repeat(22)}.${"d".repeat(43)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/v1/installations")) {
        return jsonResponse({
          installations: [{ id: INSTALL_ID, clientInstanceId: "client-1", name: "Mac", platform: "darwin" }],
        });
      }
      expect(url).toContain(`/v1/installations/${INSTALL_ID}/credentials/rotate`);
      expect(init.method).toBe("POST");
      return jsonResponse({ credential: rotated, credentialExpiresAt: Date.now() + 10_000 }, { status: 201 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureInstallation({
      accountToken: ACCOUNT,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({ credential: rotated, installation: { id: INSTALL_ID } });
  });

  it("lists validated active installations for response-loss cleanup", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations");
      expect(init.headers.get("authorization")).toBe(`Bearer ${ACCOUNT}`);
      return jsonResponse({
        installations: [{
          id: INSTALL_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        }],
      });
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.listInstallations(ACCOUNT)).resolves.toEqual([{
      id: INSTALL_ID,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    }]);
  });

  it("rejects malformed installation lists instead of skipping cleanup targets", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({
        installations: [{ id: "not-an-installation", clientInstanceId: "client-1" }],
      })),
    });

    await expect(client.listInstallations(ACCOUNT)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("validates endpoint material without leaking the connector token into the URL", async () => {
    const connectorToken = `eyJ${"x".repeat(80)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self/endpoint");
      expect(init.headers.get("authorization")).toBe(`Bearer ${INSTALL}`);
      expect(url).not.toContain(connectorToken);
      return jsonResponse({ endpoint: { url: "https://c-opaque.openmausbot.com" }, connectorToken });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureEndpoint(INSTALL)).resolves.toEqual({
      endpoint: { url: "https://c-opaque.openmausbot.com" },
      connectorToken,
    });
  });

  it("reports the app's release with an endpoint request only when it is a printable version", async () => {
    const connectorToken = `eyJ${"x".repeat(80)}`;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ endpoint: { url: "https://c-opaque.mausbot.si" }, connectorToken }),
    );
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    const sent = () => {
      const [, init] = fetchImpl.mock.lastCall;
      return { body: init.body, contentType: init.headers.get("content-type") };
    };

    await expect(client.ensureEndpoint(INSTALL, { appVersion: " 0.1.104 " })).resolves.toEqual({
      endpoint: { url: "https://c-opaque.mausbot.si" },
      connectorToken,
    });
    expect(sent()).toEqual({ body: JSON.stringify({ appVersion: "0.1.104" }), contentType: "application/json" });

    for (const options of [undefined, {}, { appVersion: "" }, { appVersion: "   " }, { appVersion: "0.1\n.104" },
      { appVersion: "9".repeat(65) }, { appVersion: 104 }, { appVersion: new String("0.1.104") }]) {
      await client.ensureEndpoint(INSTALL, options);
      expect(sent(), JSON.stringify(options)).toEqual({ body: undefined, contentType: null });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it("maps bounded server error codes and hides arbitrary response text", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "rate_limited", detail: "secret detail" }, { status: 429 })),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "ControlPlaneError",
      code: "rate_limited",
      status: 429,
    });
  });

  it("falls back from Better Auth's message-only 429 without exposing its prose", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { message: "Too many requests. Please try again later." },
        { status: 429, headers: { "x-request-id": requestId } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "ControlPlaneError",
      code: "rate_limited",
      status: 429,
      requestId,
    });
  });

  it("uses stable status errors when a response has no public error contract", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { code: "INTERNAL_DEPENDENCY_DETAIL", message: "do not expose this" },
        { status: 400, headers: { "x-request-id": "not-a-safe-request-id" } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      requestId: "",
    });
  });

  it("fails closed on redirects and network errors", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("redirect blocked");
      }),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toEqual(
      expect.objectContaining({ code: "network_unavailable" }),
    );
    expect(() => createControlPlaneClient({ baseURL: "http://remote.example" })).toThrow(
      ControlPlaneError,
    );
  });

  it("reads the endpoint without a connector token and maps a removed endpoint to null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: null }))
      .mockResolvedValueOnce(jsonResponse({
        endpoint: { url: "https://c-opaque.openmausbot.com", hostname: "c-opaque.openmausbot.com", status: "deleting" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        endpoint: { url: "https://c-opaque.openmausbot.com", status: "renamed-by-a-future-server" },
      }))
      .mockResolvedValueOnce(jsonResponse({ endpoint: { url: "http://c-opaque.openmausbot.com" } }));
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });

    await expect(client.getEndpoint(INSTALL)).resolves.toBeNull();
    await expect(client.getEndpoint(INSTALL)).resolves.toEqual({
      url: "https://c-opaque.openmausbot.com",
      status: "deleting",
    });
    await expect(client.getEndpoint(INSTALL)).resolves.toEqual({
      url: "https://c-opaque.openmausbot.com",
      status: "unknown",
    });
    await expect(client.getEndpoint(INSTALL)).rejects.toMatchObject({ code: "invalid_response" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self/endpoint");
    expect(init.method).toBe("GET");
    expect(init.headers.get("authorization")).toBe(`Bearer ${INSTALL}`);
    await expect(client.getEndpoint(ACCOUNT)).rejects.toMatchObject({ code: "signed_out", status: 401 });
  });

  it("carries a capacity error code and the server's Retry-After delay", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "endpoint_capacity" }, {
        status: 503,
        headers: { "retry-after": "600", "x-request-id": "44444444-4444-4444-8444-444444444444" },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "endpoint_capacity" }, {
        status: 503,
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }));
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });

    const first = await client.ensureEndpoint(INSTALL).catch((error) => error);
    expect(first).toBeInstanceOf(ControlPlaneError);
    expect(first).toMatchObject({
      code: "endpoint_capacity",
      status: 503,
      retryAfterMs: 600_000,
      requestId: "44444444-4444-4444-8444-444444444444",
    });
    await expect(client.ensureEndpoint(INSTALL)).rejects.toMatchObject({
      code: "endpoint_capacity",
      retryAfterMs: 0,
    });
  });

  it("reads the account's AI status without inventing a catalog", async () => {
    const status = {
      state: "ready",
      unit: "points",
      availableMicroPoints: 3_000,
      reservedMicroPoints: 1_200,
      defaultModel: "fixture/model",
      models: [{
        id: "fixture/model",
        label: "Fixture",
        protocol: "responses",
        pricingVersion: "2026-11-01",
        inputMicroPointsPerMillion: 2_000_000,
        cachedInputMicroPointsPerMillion: 500_000,
        outputMicroPointsPerMillion: 4_000_000,
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
      }],
    };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/account/ai");
      expect(init.headers.get("authorization")).toBe(`Bearer ${ACCOUNT}`);
      return jsonResponse(status);
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.aiStatus(ACCOUNT)).resolves.toEqual(status);
    await expect(client.aiStatus(undefined)).rejects.toMatchObject({ code: "signed_out", status: 401 });
  });

  it("rejects malformed prices, protocols and totals instead of displaying them", async () => {
    const base = {
      state: "ready",
      unit: "points",
      availableMicroPoints: 0,
      reservedMicroPoints: 0,
      defaultModel: "m",
      models: [{
        id: "m",
        label: "M",
        protocol: "chat",
        pricingVersion: "v1",
        inputMicroPointsPerMillion: 1,
        cachedInputMicroPointsPerMillion: 0,
        outputMicroPointsPerMillion: 1,
        maxContextTokens: 1,
        maxOutputTokens: 1,
      }],
    };
    const cases = [
      { ...base, state: "trial" },
      { ...base, unit: "USD" },
      { ...base, availableMicroPoints: "0" },
      { ...base, availableMicroPoints: -1 },
      { ...base, reservedMicroPoints: 1.5 },
      { ...base, models: [{ ...base.models[0], protocol: "embeddings" }] },
      { ...base, models: [{ ...base.models[0], inputMicroPointsPerMillion: -2 }] },
      { ...base, models: [{ ...base.models[0], maxContextTokens: 0 }] },
      { ...base, models: "none" },
      { ...base, defaultModel: 7 },
    ];
    for (const payload of cases) {
      const client = createControlPlaneClient({
        baseURL: "https://accounts.openmausbot.com",
        fetchImpl: vi.fn(async () => jsonResponse(payload)),
      });
      await expect(client.aiStatus(ACCOUNT), JSON.stringify(payload)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("issues one short-lived model credential per call for this device", async () => {
    const credential = `omb_product_ai_${"d".repeat(22)}.${"e".repeat(43)}`;
    const tokenId = "33333333-3333-4333-8333-333333333333";
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/account/ai/tokens");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ deviceId: INSTALL_ID });
      return jsonResponse({ id: tokenId, token: credential, expiresAt: 1_800_000_000_000 }, { status: 201 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.createAiToken(ACCOUNT, INSTALL_ID)).resolves.toEqual({
      id: tokenId,
      token: credential,
      expiresAt: 1_800_000_000_000,
    });
    await expect(client.createAiToken(ACCOUNT, "not-a-device")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a credential response that is not exactly what was promised", async () => {
    const valid = { id: "33333333-3333-4333-8333-333333333333", token: `omb_product_ai_${"d".repeat(22)}.${"e".repeat(43)}`, expiresAt: 1 };
    for (const [payload, status] of [
      [{ ...valid, token: "omb_install_aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, 201],
      [{ ...valid, id: "not-a-uuid" }, 201],
      [{ ...valid, expiresAt: 0 }, 201],
      [valid, 200],
      [{ id: valid.id }, 201],
    ]) {
      const client = createControlPlaneClient({
        baseURL: "https://accounts.openmausbot.com",
        fetchImpl: vi.fn(async () => jsonResponse(payload, { status })),
      });
      await expect(client.createAiToken(ACCOUNT, INSTALL_ID)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("keeps a non-usable account's refusal as the gateway's own code", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "insufficient_balance" }, { status: 402 })),
    });
    await expect(client.createAiToken(ACCOUNT, INSTALL_ID)).rejects.toMatchObject({
      code: "insufficient_balance",
      status: 402,
    });
  });

  it("revokes a model credential idempotently and never another account's", async () => {
    const tokenId = "33333333-3333-4333-8333-333333333333";
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`https://accounts.openmausbot.com/v1/account/ai/tokens/${tokenId}`);
      expect(init.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.revokeAiToken(ACCOUNT, tokenId)).resolves.toBeUndefined();
    await expect(client.revokeAiToken(ACCOUNT, "someone-else")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("uses authenticated operator APIs and never retries a refused grant", async () => {
    const account = { userId: "user-1", email: "ada@example.com", availableMicroPoints: 1, reservedMicroPoints: 2 };
    const calls = [];
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ACCOUNT}`);
        expect(init.redirect).toBe("error");
        return init.method === "POST"
          ? jsonResponse({ error: "amount_out_of_range" }, { status: 400 })
          : jsonResponse({ account: { ...account, accountToken: "never-return" } });
      },
    });
    expect(await client.operatorAiAccount(ACCOUNT, account.email)).toEqual(account);
    expect(calls[0].url).toContain("/v1/operator/ai/account?email=ada%40example.com");
    const input = { operationId: "11111111-1111-4111-8111-111111111111", userId: account.userId,
      amountMicroPoints: Number.MAX_SAFE_INTEGER - 3, reason: "explicit operator action" };
    await expect(client.operatorGrantAiBalance(ACCOUNT, input)).rejects.toMatchObject({ code: "amount_out_of_range" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].init.body)).toEqual(input);
  });

  it("pages the ledger with an opaque cursor and rejects a malformed page", async () => {
    const page = {
      items: [
        { id: "req-1", kind: "request", createdAt: 20, model: "m", state: "review", reservedMicroPoints: 2_400 },
        { id: "op-1", kind: "grant", createdAt: 10, amountMicroPoints: 1_000_000, reason: "welcome" },
      ],
      nextCursor: "eyJjcmVhdGVkQXQiOjEwLCJpZCI6Im9wLTEifQ",
    };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/account/ai/ledger?cursor=eyJhIjoxfQ");
      expect(init.headers.get("authorization")).toBe(`Bearer ${ACCOUNT}`);
      return jsonResponse(page);
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.aiLedger(ACCOUNT, "eyJhIjoxfQ")).resolves.toEqual(page);

    const plain = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async (url) => {
        expect(url).toBe("https://accounts.openmausbot.com/v1/account/ai/ledger");
        return jsonResponse({ items: [], nextCursor: null });
      }),
    });
    await expect(plain.aiLedger(ACCOUNT)).resolves.toEqual({ items: [], nextCursor: null });

    for (const payload of [
      { items: [], nextCursor: 3 },
      { items: [{ id: "x", kind: "refund", createdAt: 1 }], nextCursor: null },
      { items: [{ id: "x", kind: "grant", createdAt: -1 }], nextCursor: null },
      { items: [{ id: "x", kind: "grant", createdAt: 1, amountMicroPoints: 2.5 }], nextCursor: null },
      { items: "none", nextCursor: null },
    ]) {
      const broken = createControlPlaneClient({
        baseURL: "https://accounts.openmausbot.com",
        fetchImpl: vi.fn(async () => jsonResponse(payload)),
      });
      await expect(broken.aiLedger(ACCOUNT), JSON.stringify(payload)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});
