import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnyProviderDriver,
  DriverCreateInput,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  SendTurnInput,
} from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE } from "../../packages/shared/product-account.ts";
import {
  PRODUCT_AI_EXPIRED_MESSAGE,
  PRODUCT_AI_INSTANCE_ID,
  PRODUCT_AI_KEY_ENV,
  PRODUCT_AI_MODEL_MESSAGE,
  PRODUCT_AI_PENDING_MESSAGE,
  PRODUCT_AI_SUSPENDED_MESSAGE,
  PRODUCT_AI_UNAVAILABLE_MESSAGE,
  ProductAiProviders,
  parseProductAiUpdate,
  productAiInstanceConfigs,
} from "./product-ai.ts";

const TOKEN = `omb_product_ai_${"a".repeat(22)}.${"b".repeat(43)}`;
const NEXT_TOKEN = `omb_product_ai_${"c".repeat(22)}.${"d".repeat(43)}`;
const ORIGIN = "https://operator.example";
const NOW = 1_800_000_000_000;

function model(id = "hezuo-default", protocol: "chat" | "responses" = "chat", over: Partial<Record<string, unknown>> = {}) {
  return {
    id, label: "Hezuo", protocol, pricingVersion: "v1",
    inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
    maxContextTokens: 1_000, maxOutputTokens: 100,
    ...over,
  };
}
function connection(over: Record<string, unknown> = {}) {
  return { origin: ORIGIN, userId: "user-1", tokenId: "token-1", token: TOKEN, expiresAt: NOW + 15 * 60_000,
    defaultModel: "hezuo-default", models: [model()], ...over };
}
const ready = (over: Record<string, unknown> = {}) => ({ state: "ready", connection: connection(over) });

const parsed = (raw: unknown, options: { now?: number; allowLoopback?: boolean } = {}) =>
  parseProductAiUpdate(raw, { now: NOW, ...options });

/** A throwaway leaf certificate for 127.0.0.1, or null where openssl is absent. */
function loopbackCertificate(altName = "IP:127.0.0.1", commonName = "127.0.0.1"): string | null {
  const directory = mkdtempSync(join(tmpdir(), "omb-product-ai-ca-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", `/CN=${commonName}`, "-addext", `subjectAltName=${altName}`], { stdio: "pipe" });
  const pem = made.status === 0 ? readFileSync(cert, "utf8") : null;
  rmSync(directory, { recursive: true, force: true });
  return pem;
}

function managedDriver() {
  const inputs: DriverCreateInput<unknown>[] = [];
  const keys: Array<string | null> = [];
  const turns: SendTurnInput[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const disposed: string[] = [];
  let fail = false;
  const driver: AnyProviderDriver = {
    driverKind: "openai-compat",
    metadata: { displayName: "Fixture account engine" },
    models: { default: "driver-default", options: [{ id: "driver-default", label: "driver-default" }] },
    decodeConfig(raw: unknown) { if (fail) throw new Error("fixture decode failure"); return raw; },
    defaultConfig: () => ({}),
    async create(input: DriverCreateInput<unknown>): Promise<ProviderInstance> {
      inputs.push(input);
      const instance: ProviderInstance = {
        instanceId: input.instanceId,
        driverKind: "openai-compat",
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return { default: (input.config as { model?: string }).model ?? "driver-default",
            options: ((input.config as { managedModels?: string[] }).managedModels ?? []).map(id => ({ id, label: id })) };
        },
        refreshModels: vi.fn(async () => {}),
        installRuntime: vi.fn(async () => {}),
        startAuthentication: vi.fn(),
        signOut: vi.fn(),
        snapshot: async (): Promise<ProviderSnapshot> => {
          try {
            const key = input.requestCredential?.();
            keys.push(key?.apiKey ?? null);
            if (!key) return { state: "unavailable", reason: "no credential" };
            return { state: "available", authenticated: true };
          } catch (error) {
            return { state: "unavailable", reason: error instanceof Error ? error.message : "unavailable" };
          }
        },
        adapter: {
          provider: "openai-compat",
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn: async (turn: SendTurnInput) => {
            const key = input.requestCredential ? input.requestCredential().apiKey : "";
            keys.push(key);
            turns.push(turn);
            for (const listener of listeners) listener({ eventId: "e", provider: "openai-compat", threadId: turn.threadId, createdAt: new Date(NOW).toISOString(), type: "turn.started", turnId: "turn-1" } as RuntimeEvent);
            return { turnId: "turn-1" };
          },
          interruptTurn: async () => {},
          respondToRequest: async () => "unavailable",
          hasSession: () => false,
          stopAll: async () => {},
          onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        generateText: async (_prompt: string) => {
          keys.push(input.requestCredential ? input.requestCredential().apiKey : "");
          return "helper";
        },
        dispose: async () => { disposed.push(input.instanceId); listeners.clear(); },
      };
      return instance;
    },
  };
  return { driver, inputs, keys, turns, listeners, disposed, breakDecode: () => { fail = true; } };
}

const registries: ProviderRegistry[] = [], providers: ProductAiProviders[] = [];
function setup(options: { now?: () => number; allowLoopbackOrigin?: boolean } = {}) {
  const fixture = managedDriver();
  const registry = new ProviderRegistry([fixture.driver], { npmAvailable: () => false });
  registries.push(registry);
  const onState = vi.fn(), afterReplace = vi.fn(), beforeReplace = vi.fn();
  const provider = new ProductAiProviders({ registry, now: options.now ?? (() => NOW), ...options, onState, afterReplace, beforeReplace });
  providers.push(provider);
  return { fixture, registry, provider, onState, afterReplace, beforeReplace };
}
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  for (const registry of registries.splice(0)) await registry.disposeAll();
  vi.restoreAllMocks();
});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

describe("the private capability parser", () => {
  it("accepts exactly the documented wire shape", () => {
    expect(parsed(ready())).toEqual({ state: "ready", connection: {
      origin: ORIGIN, userId: "user-1", tokenId: "token-1", token: TOKEN, expiresAt: NOW + 15 * 60_000,
      defaultModel: "hezuo-default", models: [model()] } });
    expect(parsed({ type: "hezuo:product-ai", requestId: "r-1", state: "ready", connection: connection() }).state).toBe("ready");
    for (const state of ["pending", "suspended", "unavailable"] as const) {
      expect(parsed({ state, connection: null })).toEqual({ state, connection: null });
    }
    // A balance-empty account may keep its credential so accepted work finishes.
    const held = parsed({ state: "insufficient_balance", connection: connection() });
    expect(held.connection?.token).toBe(TOKEN);
    expect(parsed({ state: "insufficient_balance", connection: null }).connection).toBeNull();
  });

  it("refuses anything outside it, before a token or address is used", () => {
    const bad = [
      null, "ready", [], {}, { state: "running", connection: null },
      { state: "ready" },
      { state: "pending", connection: connection() },
      { state: "suspended", connection: connection() },
      { state: "unavailable", connection: connection() },
      { state: "insufficient_balance", connection: connection({ defaultModel: null }) },
      ready({ token: "omd_" + "a".repeat(43) }),
      ready({ token: TOKEN + "x" }),
      ready({ origin: "http://operator.example" }),
      ready({ origin: "https://operator.example/path" }),
      ready({ origin: "https://operator.example/?q=1" }),
      ready({ origin: "https://user:pass@operator.example" }),
      ready({ expiresAt: NOW }),
      ready({ expiresAt: 0 }),
      ready({ models: [] }),
      ready({ models: [model(), model()] }),
      ready({ models: [model("hezuo-default", "chat", { maxOutputTokens: 2_000 })] }),
      ready({ models: [model("hezuo-default", "audio" as "chat")] }),
      ready({ models: [model("bad model")] }),
      ready({ models: [model("hezuo-default", "chat", { inputMicroPointsPerMillion: -1 })] }),
      ready({ models: [model("hezuo-default", "chat", { maxContextTokens: 1.5 })] }),
      ready({ defaultModel: "not-there" }),
      ready({ userId: "" }),
      ready({ extra: true }),
      ready({ models: [{ ...model(), upstreamModel: "secret" }] }),
      { state: "ready", connection: connection(), extra: true },
      { type: "hezuo:managed-desktop", state: "pending", connection: null },
    ];
    for (const value of bad) expect(() => parsed(value), JSON.stringify(value)).toThrow(/invalid_product_ai/);
    // A loopback HTTP origin exists only for an explicit fixture or development deployment.
    expect(() => parsed({ state: "ready", connection: connection({ origin: "http://127.0.0.1:8787" }) }, { allowLoopback: true })).not.toThrow();
  });

  it("carries one public certificate, bound to the connection's own origin", () => {
    const pem = loopbackCertificate();
    if (!pem) return;
    const loopback2 = (over: Record<string, unknown> = {}) => connection({ origin: "https://127.0.0.1:8787", ...over });
    const held = parsed({ state: "ready", connection: loopback2({ ca: pem }) });
    expect(held.connection?.ca).toBe(`${pem.trim()}\n`);
    // The same certificate can never be attached to another host.
    expect(() => parsed({ state: "ready", connection: connection({ ca: pem }) })).toThrow(/invalid_product_ai/);
    expect(() => parsed({ state: "ready", connection: connection({ origin: "https://127.0.0.2:8787", ca: pem }) })).toThrow(/invalid_product_ai/);
    // Nor may a key, a second certificate, or surrounding text ride along; plain HTTP needs no certificate at all.
    expect(() => parsed({ state: "ready", connection: loopback2({ ca: `${pem}${pem}` }) })).toThrow(/invalid_product_ai/);
    expect(() => parsed({ state: "ready", connection: loopback2({ ca: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }) })).toThrow(/invalid_product_ai/);
    expect(() => parsed({ state: "ready", connection: connection({ origin: "http://127.0.0.1:8787", ca: pem }) }, { allowLoopback: true })).toThrow(/invalid_product_ai/);
    // An absent certificate keeps relying on the platform trust store.
    expect(parsed(ready()).connection?.ca).toBeUndefined();
  });
});

describe("the account engine's config", () => {
  it("is one OpenAI-compatible instance on the gateway, with no token in anything persistable", () => {
    const configs = productAiInstanceConfigs(ORIGIN, [model(), model("hezuo-pro", "responses")], "hezuo-default");
    expect(Object.keys(configs)).toEqual([PRODUCT_AI_INSTANCE_ID]);
    const entry = configs[PRODUCT_AI_INSTANCE_ID]!;
    expect(entry).toMatchObject({ driver: "openai-compat", displayName: "Hezuo AI", access: "api", enabled: true });
    expect(entry.environment).toBeUndefined();
    expect(entry.config).toEqual({
      url: `${ORIGIN}/v1/ai`, apiKeyEnv: PRODUCT_AI_KEY_ENV, provider: "", model: "hezuo-default",
      managedModels: ["hezuo-default", "hezuo-pro"],
      modelProtocols: { "hezuo-default": "chat", "hezuo-pro": "responses" },
      accountSlotWaitMs: 600000,
      upstreamStreamRetries: 2,
    });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    expect(JSON.stringify(entry)).not.toMatch(/OPENAI_COMPAT_API_KEY|OPENAI_API_KEY|sk-/);
  });
});

describe("ProductAiProviders", () => {
  it("loads one engine from a ready capability and keeps its token out of the config envelope", async () => {
    const { fixture, registry, provider, onState, afterReplace } = setup();
    expect(provider.status()).toBe("unavailable");
    await provider.apply(ready());
    expect(provider.status()).toBe("ready");
    expect(provider.origin()).toBe(ORIGIN);
    expect(provider.defaultModel()).toBe("hezuo-default");
    expect(onState).toHaveBeenCalled();
    expect(afterReplace).toHaveBeenCalledWith([PRODUCT_AI_INSTANCE_ID]);
    const instance = registry.get(PRODUCT_AI_INSTANCE_ID);
    expect(instance).not.toBeNull();
    expect(fixture.inputs).toHaveLength(1);
    const input = fixture.inputs[0]!;
    expect(input.environment).toEqual({});
    expect(JSON.stringify(input.config)).not.toContain(TOKEN);
    expect(input.requestCredential?.().apiKey).toBe(TOKEN);
    // No bundled certificate: the driver keeps the platform trust store.
    expect(input.requestTrust).toBeUndefined();
    // The catalog, not the driver's, is what a picker sees.
    expect(instance!.models).toEqual({ default: "hezuo-default", options: [{ id: "hezuo-default", label: "Hezuo", contextWindow: 1_000 }] });
    // A product engine is never installed or signed in to.
    expect(instance!.installRuntime).toBeUndefined();
    expect(instance!.startAuthentication).toBeUndefined();
    expect(instance!.getAuthentication).toBeUndefined();
    expect(instance!.completeAuthentication).toBeUndefined();
    expect(instance!.cancelAuthentication).toBeUndefined();
    expect(instance!.signOut).toBeUndefined();
    expect((await instance!.snapshot()).state).toBe("available");
  });

  it("hands a bundled certificate to the engine as scoped trust, never as config or environment", async () => {
    const pem = loopbackCertificate("DNS:operator.example", "operator.example");
    if (!pem) return;
    const { fixture, provider } = setup();
    await provider.apply(ready({ ca: pem }));
    const input = fixture.inputs[0]!;
    expect(input.requestTrust).toEqual({ origin: ORIGIN, ca: `${pem.trim()}\n` });
    // Still nothing persistable: the envelope, the environment and the polled state carry no trust at all.
    expect(JSON.stringify(input.config)).not.toContain("BEGIN CERTIFICATE");
    expect(input.environment).toEqual({});
    expect(JSON.stringify(provider.status())).not.toContain("CERTIFICATE");
  });

  it("rotates a token in memory: no reload, no dispose, and the next request uses the new one", async () => {
    const { fixture, registry, provider, afterReplace } = setup();
    const load = vi.spyOn(registry, "load");
    await provider.apply(ready());
    const first = registry.get(PRODUCT_AI_INSTANCE_ID);
    expect(load).toHaveBeenCalledTimes(1);
    const events: RuntimeEvent[] = [];
    first!.adapter.onEvent(event => events.push(event));
    await first!.adapter.sendTurn({ threadId: "thread", text: "before rotation" });
    expect(fixture.keys.at(-1)).toBe(TOKEN);

    await provider.apply(ready({ token: NEXT_TOKEN, tokenId: "token-2", expiresAt: NOW + 30 * 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBe(first);
    expect(fixture.disposed).toEqual([]);
    expect(afterReplace).toHaveBeenCalledTimes(1);
    // The wrapper loaded before the rotation is still the live engine and now reads the new credential.
    await first!.adapter.sendTurn({ threadId: "thread", text: "after rotation" });
    expect(fixture.keys.at(-1)).toBe(NEXT_TOKEN);
    expect(events.filter(event => event.type === "turn.started")).toHaveLength(2);
    expect(await first!.generateText!("helper")).toBe("helper");
    expect(fixture.keys.at(-1)).toBe(NEXT_TOKEN);
  });

  it("keeps bot model choices through a pause and releases only the engine, never the catalog", async () => {
    const { registry, provider } = setup();
    await provider.apply(ready());
    const selected = { instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" };
    expect(provider.select(selected)).toEqual(selected);
    expect(provider.select({ instanceId: "openai", model: "gpt-personal" })).toEqual(selected);
    await provider.apply({ state: "suspended", connection: null });
    expect(provider.status()).toBe("suspended");
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();
    expect(provider.models().map(entry => entry.id)).toEqual(["hezuo-default"]);
    // A paused provider still names the catalog: a person's saved choice is not erased, it is refused at admission.
    expect(provider.allows(selected)).toBe(true);
    expect(provider.select(selected)).toEqual(selected);
    expect(provider.error()).toBe(PRODUCT_AI_SUSPENDED_MESSAGE);
    await provider.apply({ state: "pending", connection: null });
    expect(provider.error()).toBe(PRODUCT_AI_PENDING_MESSAGE);
    await provider.apply({ state: "unavailable", connection: null });
    expect(provider.error()).toBe(PRODUCT_AI_UNAVAILABLE_MESSAGE);
    await provider.apply({ state: "insufficient_balance", connection: null });
    expect(provider.status()).toBe("insufficient_balance");
    expect(provider.error()).toBe(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    expect(provider.allows(selected)).toBe(true);
  });

  it("reports insufficient reservation without credentials and keeps revoked wrappers fenced after recovery", async () => {
    const { fixture, registry, provider } = setup();
    await provider.apply({ state: "insufficient_balance", connection: null });
    expect(provider.status()).toBe("insufficient_balance");
    expect(provider.error()).toBe(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();

    await provider.apply(ready());
    const old = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    const revoked = provider.apply({ state: "insufficient_balance", connection: null });
    expect(provider.error()).toBe(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    await expect(old.adapter.sendTurn({ threadId: "thread", text: "refused" }))
      .rejects.toThrow(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    await expect(old.generateText!("helper")).rejects.toThrow(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    await revoked;
    expect(provider.status()).toBe("insufficient_balance");
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.keys).toHaveLength(0);

    await provider.apply(ready({ token: NEXT_TOKEN, tokenId: "token-2" }));
    await expect(old.adapter.sendTurn({ threadId: "thread", text: "still fenced" }))
      .rejects.toThrow(PRODUCT_AI_UNAVAILABLE_MESSAGE);
    await expect(old.generateText!("still fenced")).rejects.toThrow(PRODUCT_AI_UNAVAILABLE_MESSAGE);
    await registry.get(PRODUCT_AI_INSTANCE_ID)!.adapter.sendTurn({ threadId: "thread", text: "recovered" });
    expect(fixture.turns).toHaveLength(1);
    expect(fixture.keys.at(-1)).toBe(NEXT_TOKEN);
  });

  it("replaces the engine when the model catalog or protocol changes, fencing the old one at once", async () => {
    const { fixture, registry, provider } = setup();
    await provider.apply(ready());
    const before = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    await provider.apply(ready({ token: NEXT_TOKEN, models: [model("hezuo-pro", "responses")], defaultModel: "hezuo-pro" }));
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).not.toBe(before);
    expect(fixture.disposed).toContain(PRODUCT_AI_INSTANCE_ID);
    // Pricing-only changes keep the same route and therefore the same engine.
    const current = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    await provider.apply(ready({ models: [model("hezuo-pro", "responses", { inputMicroPointsPerMillion: 3_000_000 })], defaultModel: "hezuo-pro" }));
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBe(current);
    expect(provider.select()).toEqual({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-pro" });
  });

  it("keeps the engine for a balance-empty account with a live credential, and replaces it for another account", async () => {
    const { fixture, registry, provider } = setup();
    await provider.apply(ready());
    const first = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    await provider.apply({ state: "insufficient_balance", connection: connection({ token: NEXT_TOKEN, tokenId: "token-2" }) });
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBe(first);
    expect(fixture.disposed).toEqual([]);
    expect(provider.status()).toBe("insufficient_balance");
    // The gateway enforces the balance per request; this side must not refuse accepted work on a stale reading.
    await first.adapter.sendTurn({ threadId: "thread", text: "finish what was accepted" });
    expect(fixture.turns).toHaveLength(1);
    // Another account is another engine, even on the same origin with the same catalog.
    await provider.apply(ready({ userId: "user-2" }));
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).not.toBe(first);
    expect(fixture.disposed).toEqual([PRODUCT_AI_INSTANCE_ID]);
  });

  it("admits only the account's catalog and only while the account may make a new call", async () => {
    const { fixture, registry, provider } = setup();
    await provider.apply(ready());
    const instance = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    await instance.adapter.sendTurn({ threadId: "thread", text: "ok", model: "hezuo-default" });
    expect(fixture.turns).toHaveLength(1);
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "no", model: "gpt-personal" }))
      .rejects.toThrow(PRODUCT_AI_MODEL_MESSAGE);
    await expect(instance.generateText!("helper", { model: "gpt-personal" })).rejects.toThrow(PRODUCT_AI_MODEL_MESSAGE);
    expect(fixture.turns).toHaveLength(1);
    await provider.apply({ state: "suspended", connection: null });
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "stopped" })).rejects.toThrow(PRODUCT_AI_SUSPENDED_MESSAGE);
    await expect(instance.generateText!("helper")).rejects.toThrow(PRODUCT_AI_SUSPENDED_MESSAGE);
    expect(fixture.turns).toHaveLength(1);
    // A paused provider's status reads are a refusal, never a stale "available".
    expect((await instance.snapshot()).state).toBe("unavailable");
  });

  it("refuses every new request once the token's expiry passes", async () => {
    let now = NOW;
    const { registry, provider } = setup({ now: () => now });
    await provider.apply(ready());
    const instance = registry.get(PRODUCT_AI_INSTANCE_ID)!;
    now += 15 * 60_000;
    expect(provider.status()).toBe("unavailable");
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "late" })).rejects.toThrow(PRODUCT_AI_EXPIRED_MESSAGE);
    await expect(instance.generateText!("helper")).rejects.toThrow(PRODUCT_AI_EXPIRED_MESSAGE);
    await settle();
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();
    // Expiry keeps the catalog the same way a pause does.
    expect(provider.select()).toEqual({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" });
  });

  it("selects, allows and resets exactly like the hosted policy shape it stands in for", async () => {
    const { provider } = setup();
    expect(provider.select()).toEqual({ instanceId: "", model: "" });
    expect(provider.error()).toBe(PRODUCT_AI_UNAVAILABLE_MESSAGE);
    await provider.apply(ready({ models: [model("hezuo-default"), model("hezuo-pro")], defaultModel: "hezuo-pro" }));
    expect(provider.select()).toEqual({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-pro" });
    expect(provider.select({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" })).toEqual({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" });
    expect(provider.allows({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-pro" })).toBe(true);
    expect(provider.allows({ instanceId: "openai", model: "hezuo-pro" })).toBe(false);
    expect(provider.allows({ instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default", effort: "high" })).toBe(true);
    expect(provider.resetTask(
      { instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" },
      { instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-pro" },
    )).toEqual({ resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined });
    expect(provider.resetTask(
      { instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" },
      { instanceId: PRODUCT_AI_INSTANCE_ID, model: "hezuo-default" },
    )).toEqual({});
    expect(provider.owns(PRODUCT_AI_INSTANCE_ID)).toBe(true);
    expect(provider.owns("company.abc.openrouter")).toBe(false);
  });

  it("an empty catalog never falls back to a personal engine", async () => {
    const { provider } = setup();
    await provider.apply({ state: "pending", connection: null });
    expect(provider.select({ instanceId: "openai", model: "gpt-personal" })).toEqual({ instanceId: "", model: "" });
    expect(provider.allows({ instanceId: "openai", model: "gpt-personal" })).toBe(false);
    expect(provider.models()).toEqual([]);
    expect(provider.defaultModel()).toBeNull();
  });

  it("an invalid or unacceptable capability changes nothing, and a failed replace leaves unavailable", async () => {
    const { fixture, provider } = setup();
    await provider.apply(ready());
    await expect(provider.apply({ state: "ready", connection: connection({ token: "nope" }) })).rejects.toThrow(/invalid_product_ai/);
    expect(provider.status()).toBe("ready");
    fixture.breakDecode();
    const outcome = provider.apply(ready({ models: [model("hezuo-pro")], defaultModel: "hezuo-pro" })).catch(() => "failed");
    expect(await outcome).toBe("failed");
    expect(provider.status()).toBe("unavailable");
    expect(provider.origin()).toBeNull();
  });

  it("close releases the engine and keeps no credential; a second close is harmless", async () => {
    const { fixture, registry, provider } = setup();
    await provider.apply(ready());
    await provider.close();
    expect(fixture.disposed).toEqual([PRODUCT_AI_INSTANCE_ID]);
    expect(registry.get(PRODUCT_AI_INSTANCE_ID)).toBeNull();
    expect(provider.origin()).toBeNull();
    expect(provider.status()).toBe("unavailable");
    await provider.close();
    expect(fixture.disposed).toHaveLength(1);
  });
});
