import { readAiConfig, readUpstreamBaseURL, type AiConfig, type AiModelConfig } from "./ai-config";
import { HTTPError } from "./http";

export interface ChannelView {
  id: string;
  name: string;
  baseURL: string;
  enabled: boolean;
  hasKey: boolean;
}
export interface ManagedModel extends AiModelConfig { channelId: string }
export interface ChannelCatalog {
  revision: number;
  channels: ChannelView[];
  models: ManagedModel[];
  defaultModel: string | null;
}
export interface ChannelCatalogInput {
  revision: number;
  reason: string;
  channels: Array<Omit<ChannelView, "hasKey"> & { apiKey?: string }>;
  models: ManagedModel[];
  defaultModel: string | null;
}
interface StoredChannel extends Omit<ChannelView, "hasKey"> { encryptedKey: string }
interface Snapshot { channels: StoredChannel[]; models: ManagedModel[]; defaultModel: string | null }
interface CatalogRow { revision: number; snapshot_json: string }
const encoder = new TextEncoder();
const KEY = /^\S{8,512}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function invalid(): never { throw new HTTPError(400, "invalid_channel_catalog"); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function printable(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
/** Operators are trusted to select internal HTTPS upstreams. This is not an
 * SSRF sandbox: hostname filtering cannot prevent DNS rebinding. */
export function validateChannelBaseURL(value: unknown): string {
  const url = readUpstreamBaseURL(value);
  if (!url || typeof value !== "string" || value.length > 2048) invalid();
  return url;
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (typeof env.BETTER_AUTH_SECRET !== "string" || env.BETTER_AUTH_SECRET.length < 32) {
    throw new HTTPError(503, "channel_secret_unavailable");
  }
  const material = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("hezuobot/channel-store/v1"), info: encoder.encode("upstream-api-key") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function aad(channel: Pick<StoredChannel, "id" | "baseURL">): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([channel.id, channel.baseURL]));
}
async function encrypt(key: CryptoKey, channel: Pick<StoredChannel, "id" | "baseURL">, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(channel) }, key, encoder.encode(value)));
  const bytes = new Uint8Array(iv.length + ciphertext.length);
  bytes.set(iv); bytes.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...bytes));
}
async function decrypt(key: CryptoKey, channel: StoredChannel): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(channel.encryptedKey), (character) => character.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(channel) }, key, bytes.slice(12));
    const value = new TextDecoder().decode(plaintext);
    if (!KEY.test(value)) throw new Error();
    return value;
  } catch { throw new HTTPError(503, "channel_credentials_unavailable"); }
}
async function stored(env: Env): Promise<{ revision: number; snapshot: Snapshot } | null> {
  const row = await env.DB.prepare("SELECT revision, snapshot_json FROM ai_channel_catalog WHERE id = 1").first<CatalogRow>();
  if (!row) return null;
  try {
    const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
    if (!record(snapshot) || !Array.isArray(snapshot.channels) || !Array.isArray(snapshot.models)) throw new Error();
    return { revision: row.revision, snapshot };
  } catch { throw new HTTPError(503, "channel_catalog_unavailable"); }
}
function view(revision: number, snapshot: Snapshot): ChannelCatalog {
  return {
    revision,
    channels: snapshot.channels.map(({ id, name, baseURL, enabled, encryptedKey }) => ({ id, name, baseURL, enabled, hasKey: encryptedKey.length > 0 })),
    models: snapshot.models,
    defaultModel: snapshot.defaultModel,
  };
}
function legacyCatalog(env: Env): ChannelCatalog {
  const config = readAiConfig(env);
  const configured = config.upstreamBaseURL !== null;
  return {
    revision: 0,
    channels: configured ? [{ id: "legacy", name: "Legacy upstream", baseURL: config.upstreamBaseURL!, enabled: true, hasKey: config.upstreamApiKey !== null }] : [],
    models: configured ? config.models.map((model) => ({ ...model, channelId: "legacy" })) : [],
    defaultModel: configured ? config.defaultModel : null,
  };
}
export async function loadChannelCatalog(env: Env): Promise<ChannelCatalog> {
  const persisted = await stored(env);
  return persisted ? view(persisted.revision, persisted.snapshot) : legacyCatalog(env);
}

/** Full replacement. Credentials never leave this module; retaining one is
 * permitted only for an unchanged channel identity AND canonical URL. */
export async function saveChannelCatalog(env: Env, actorId: string, input: unknown): Promise<ChannelCatalog> {
  if (!record(input) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !printable(input.reason, 500) || !printable(actorId, 128) || !Array.isArray(input.channels) || input.channels.length > 50 || !Array.isArray(input.models) || input.models.length > 200 || !(input.defaultModel === null || typeof input.defaultModel === "string")) invalid();
  const revision = input.revision as number;
  if (revision === Number.MAX_SAFE_INTEGER) invalid();
  const previous = await stored(env);
  if ((previous?.revision ?? 0) !== revision) throw new HTTPError(409, "channel_revision_conflict");
  const legacy = previous ? null : readAiConfig(env);
  const oldChannels = new Map(previous?.snapshot.channels.map((channel) => [channel.id, channel]) ?? []);
  const key = await encryptionKey(env);
  const credentials = new Set<string>();
  if (legacy?.upstreamApiKey) credentials.add(legacy.upstreamApiKey);
  for (const channel of oldChannels.values()) credentials.add(await decrypt(key, channel));
  const channels: StoredChannel[] = [];
  const ids = new Set<string>();
  for (const entry of input.channels) {
    if (!record(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || ids.has(entry.id) || !printable(entry.name, 80) || typeof entry.enabled !== "boolean") invalid();
    ids.add(entry.id);
    const channel = { id: entry.id, name: entry.name.trim(), baseURL: validateChannelBaseURL(entry.baseURL), enabled: entry.enabled };
    let encryptedKey: string;
    if (entry.apiKey !== undefined) {
      if (typeof entry.apiKey !== "string" || !KEY.test(entry.apiKey)) invalid();
      credentials.add(entry.apiKey);
      encryptedKey = await encrypt(key, channel, entry.apiKey);
    } else {
      const old = oldChannels.get(channel.id);
      if (old && old.baseURL === channel.baseURL) {
        encryptedKey = old.encryptedKey;
      } else if (!previous && channel.id === "legacy" && channel.baseURL === legacy?.upstreamBaseURL && legacy?.upstreamApiKey) {
        encryptedKey = await encrypt(key, channel, legacy.upstreamApiKey);
      } else invalid();
    }
    channels.push({ ...channel, encryptedKey });
  }
  const models: ManagedModel[] = [];
  const modelIds = new Set<string>();
  for (const entry of input.models) {
    if (!record(entry) || typeof entry.channelId !== "string" || !ids.has(entry.channelId)) invalid();
    const { channelId, ...wire } = entry;
    // Runtime/config output represents this field as null for responses; its
    // environment wire schema deliberately expects it to be omitted instead.
    if (wire.protocol === "responses" && wire.chatMaxTokensField === null) delete wire.chatMaxTokensField;
    if (wire.protocol === "responses" && wire.chatMaxTokensField !== undefined) invalid();
    const validated = readAiConfig({ AI_MODELS: [wire] });
    if (validated.models.length !== 1 || validated.issues.some((issue) => issue.startsWith("model_"))) invalid();
    const model = validated.models[0]!;
    if (modelIds.has(model.id)) invalid();
    modelIds.add(model.id);
    models.push({ ...model, channelId });
  }
  const enabled = models.filter((model) => model.enabled && channels.some((channel) => channel.id === model.channelId && channel.enabled));
  if (input.defaultModel === null ? enabled.length > 0 : !enabled.some((model) => model.id === input.defaultModel)) invalid();
  const snapshot: Snapshot = { channels, models, defaultModel: input.defaultModel };
  const publicText = JSON.stringify({ actorId, reason: input.reason, ...view(revision + 1, snapshot) });
  if ([...credentials].some((credential) => publicText.includes(JSON.stringify(credential).slice(1, -1)))) invalid();
  const values = [JSON.stringify(snapshot), actorId, input.reason.trim(), Date.now()];
  // D1 serializes each statement. Audit triggers run inside the same statement;
  // unlike a separately conditioned audit INSERT they cannot race another save.
  const result = revision === 0
    ? await env.DB.prepare("INSERT INTO ai_channel_catalog (id, revision, snapshot_json, actor_id, reason, updated_at) VALUES (1, 1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(...values).run()
    : await env.DB.prepare("UPDATE ai_channel_catalog SET revision = revision + 1, snapshot_json = ?, actor_id = ?, reason = ?, updated_at = ? WHERE id = 1 AND revision = ?").bind(...values, revision).run();
  if (result.meta.changes === 0) throw new HTTPError(409, "channel_revision_conflict");
  return view(revision + 1, snapshot);
}

export async function loadRuntimeAiConfig(env: Env): Promise<AiConfig> {
  const persisted = await stored(env);
  if (!persisted) return readAiConfig(env);
  const legacy = readAiConfig(env);
  const routes = new Map<string, { baseURL: string; apiKey: string }>();
  const channelRoutes = new Map<string, { baseURL: string; apiKey: string }>();
  const usedChannelIds = new Set(persisted.snapshot.models.filter((model) => model.enabled).map((model) => model.channelId));
  const activeChannels = persisted.snapshot.channels.filter((channel) => channel.enabled && usedChannelIds.has(channel.id));
  const key = activeChannels.length > 0 ? await encryptionKey(env) : null;
  for (const channel of activeChannels) {
    if (key) channelRoutes.set(channel.id, { baseURL: channel.baseURL, apiKey: await decrypt(key, channel) });
  }
  const models = persisted.snapshot.models.map((model) => {
    const route = channelRoutes.get(model.channelId);
    if (route && model.enabled) routes.set(model.id, route);
    return { ...model, enabled: model.enabled && route !== undefined };
  });
  const defaultModel = persisted.snapshot.defaultModel;
  return {
    upstreamBaseURL: null,
    upstreamApiKey: null,
    models,
    defaultModel,
    operatorUserIds: legacy.operatorUserIds,
    issues: legacy.issues.filter((issue) => issue === "operator_ids"),
    routes,
    ready: defaultModel !== null && routes.has(defaultModel),
  };
}

export async function probeChannel(env: Env, id: string, fetcher: typeof fetch = fetch): Promise<{ models: string[]; latencyMs: number }> {
  const persisted = await stored(env);
  let baseURL: string;
  let apiKey: string;
  if (persisted) {
    const channel = persisted.snapshot.channels.find((candidate) => candidate.id === id);
    if (!channel) throw new HTTPError(404, "channel_not_found");
    baseURL = validateChannelBaseURL(channel.baseURL);
    apiKey = await decrypt(await encryptionKey(env), channel);
  } else {
    const legacy = readAiConfig(env);
    if (id !== "legacy" || !legacy.upstreamBaseURL) throw new HTTPError(404, "channel_not_found");
    if (!legacy.upstreamApiKey) throw new HTTPError(503, "channel_credentials_unavailable");
    baseURL = validateChannelBaseURL(legacy.upstreamBaseURL);
    apiKey = legacy.upstreamApiKey;
  }
  const started = Date.now();
  const controller = new AbortController();
  const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error("channel_probe_timeout"));
  }, 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pendingResponse = fetcher(`${baseURL}/models`, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, redirect: "manual", signal: controller.signal });
    void pendingResponse.then((response) => {
      if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
    }, () => {});
    const response = await Promise.race([pendingResponse, deadline]);
    if (!response.ok || response.redirected || !response.body) throw new Error();
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) throw new Error();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(data) || !Array.isArray(data.data) || data.data.length > 1000) throw new Error();
    const models = new Set<string>();
    for (const model of data.data) {
      if (!record(model) || !printable(model.id, 200) || model.id.includes(apiKey)) throw new Error();
      models.add(model.id);
    }
    return { models: [...models].sort(), latencyMs: Math.max(0, Date.now() - started) };
  } catch { throw new HTTPError(502, controller.signal.aborted ? "channel_probe_timeout" : "channel_probe_failed"); }
  finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
