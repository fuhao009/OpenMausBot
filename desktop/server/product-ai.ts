// Security invariant: the account's model token lives in this process's memory only — never config.json, an engine
// home, an environment variable or the wire — and the capability reaches this process only through Electron's private
// utility-parent port (`hezuo:product-ai`), never an HTTP route.
import type {
  InstanceConfigMap,
  ModelCatalog,
  ModelSelection,
  ProviderInstance,
  SendTurnInput,
  TextGenerationOptions,
} from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { normalizeProductCa, productCaBindsOrigin } from "../electron/product-ca.mjs";
import type { TaskPatch } from "./store.ts";
import type { ProductAiState, ProductModel } from "../../packages/shared/product-account.ts";
import { PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE } from "../../packages/shared/product-account.ts";

export type { ProductAiState, ProductModel } from "../../packages/shared/product-account.ts";

export const PRODUCT_AI_INSTANCE_ID = "product-ai";
export const PRODUCT_AI_KEY_ENV = "HEZUO_PRODUCT_AI_TOKEN";
export const PRODUCT_AI_PATH = "/v1/ai";
/** How long a request waits for a free slot when the account already has its in-flight limit running. */
export const ACCOUNT_SLOT_WAIT_MS = 600_000;
/** How many more times a reply is asked for when the gateway ends its stream with an upstream error. */
export const UPSTREAM_STREAM_RETRIES = 2;

const DISPLAY_NAME = "Hezuo AI";
const TOKEN = /^omb_product_ai_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_MODELS = 256;
const PROTOCOLS = new Set(["chat", "responses"]);

export const PRODUCT_AI_PENDING_MESSAGE =
  "Your account AI access is waiting for an administrator to enable it. Refresh your account status once it has been enabled.";
export const PRODUCT_AI_SUSPENDED_MESSAGE =
  "AI access for this account has been suspended. Contact your administrator.";
export const PRODUCT_AI_UNAVAILABLE_MESSAGE =
  "Account AI is not available right now. Check your account status, then try again.";
export const PRODUCT_AI_EXPIRED_MESSAGE =
  "The account AI session has expired. Refresh your account status, then try again.";
export const PRODUCT_AI_MODEL_MESSAGE =
  "This model is not part of your account's AI plan. Choose one of the account's models.";

const invalid = (what: string) => Object.assign(new Error(`invalid_product_ai_${what}`), { code: "invalid_product_ai" });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function normalizeOrigin(value: unknown, allowLoopback: boolean): string {
  if (!text(value, 2048)) throw invalid("origin");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("origin"); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw invalid("origin");
  if (url.protocol === "https:") return url.origin;
  if (allowLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  throw invalid("origin");
}

const MODEL_KEYS = ["id", "label", "protocol", "pricingVersion", "inputMicroPointsPerMillion", "cachedInputMicroPointsPerMillion",
  "outputMicroPointsPerMillion", "maxContextTokens", "maxOutputTokens"] as const;
const CONNECTION_KEYS = ["origin", "userId", "tokenId", "token", "expiresAt", "defaultModel", "models", "ca"] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(what);
}

function readModel(value: unknown): ProductModel {
  if (!record(value)) throw invalid("model");
  exactKeys(value, MODEL_KEYS, "model");
  const { id, label, protocol, pricingVersion, inputMicroPointsPerMillion, cachedInputMicroPointsPerMillion,
    outputMicroPointsPerMillion, maxContextTokens, maxOutputTokens } = value;
  if (!text(id, 128) || !MODEL_ID.test(id)) throw invalid("model_id");
  if (!text(label, 200) || /\p{Cc}/u.test(label)) throw invalid("model_label");
  if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) throw invalid("model_protocol");
  if (!text(pricingVersion, 64) || /\p{Cc}/u.test(pricingVersion)) throw invalid("pricing_version");
  if (!count(inputMicroPointsPerMillion) || !count(cachedInputMicroPointsPerMillion) || !count(outputMicroPointsPerMillion)) throw invalid("pricing");
  if (!count(maxContextTokens) || maxContextTokens < 1) throw invalid("max_context");
  if (!count(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > maxContextTokens) throw invalid("max_output");
  return Object.freeze({
    id, label, protocol: protocol as ProductModel["protocol"], pricingVersion,
    inputMicroPointsPerMillion, cachedInputMicroPointsPerMillion, outputMicroPointsPerMillion,
    maxContextTokens, maxOutputTokens,
  });
}

function readModels(value: unknown): readonly ProductModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS) throw invalid("models");
  const models = value.map(readModel);
  if (new Set(models.map(model => model.id)).size !== models.length) throw invalid("models");
  return Object.freeze(models) as ProductModel[];
}

function readConnection(value: unknown, now: number, allowLoopback: boolean): ProductAiConnection {
  if (!record(value)) throw invalid("connection");
  exactKeys(value, CONNECTION_KEYS, "connection");
  const { origin, userId, tokenId, token, expiresAt, defaultModel, models } = value;
  if (!text(userId, 128) || /\p{Cc}/u.test(userId)) throw invalid("user");
  if (!text(tokenId, 128) || /\p{Cc}/u.test(tokenId)) throw invalid("token_id");
  if (typeof token !== "string" || !TOKEN.test(token)) throw invalid("token");
  if (!count(expiresAt) || expiresAt < 1 || expiresAt <= now) throw invalid("expiry");
  const catalog = readModels(models);
  if (!text(defaultModel, 128) || !catalog.some(model => model.id === defaultModel)) throw invalid("default_model");
  const normalizedOrigin = normalizeOrigin(origin, allowLoopback);
  // The deployment's public certificate rides this private message and must
  // cover exactly this origin; a certificate for another host is refused.
  const ca = value.ca === undefined ? null : normalizeProductCa(value.ca);
  if (value.ca !== undefined && (ca === null || !productCaBindsOrigin(ca, normalizedOrigin))) throw invalid("ca");
  return Object.freeze({
    origin: normalizedOrigin,
    userId, tokenId, token, expiresAt,
    defaultModel,
    models: catalog,
    ...(ca ? { ca } : {}),
  });
}

/** One live capability from main: the only place an account model token exists outside Electron's memory. */
export interface ProductAiConnection {
  origin: string;
  userId: string;
  tokenId: string;
  token: string;
  expiresAt: number;
  defaultModel: string;
  models: readonly ProductModel[];
  /** The pinned certificate of exactly this origin, when the deployment ships one. */
  ca?: string;
}

export interface ParsedProductAiUpdate {
  state: ProductAiState;
  connection: ProductAiConnection | null;
}

export interface ParseProductAiUpdateOptions {
  now?: number;
  /** A loopback HTTP origin is a fixture/development arrangement only; production main always sends HTTPS. */
  allowLoopback?: boolean;
}

export function parseProductAiUpdate(raw: unknown, options: ParseProductAiUpdateOptions = {}): ParsedProductAiUpdate {
  if (!record(raw)) throw invalid("payload");
  const state = raw.state;
  if (typeof state !== "string" || !["pending", "ready", "insufficient_balance", "suspended", "unavailable"].includes(state)) {
    throw invalid("state");
  }
  if (raw.type !== undefined && raw.type !== "hezuo:product-ai") throw invalid("type");
  if (raw.requestId !== undefined && !text(raw.requestId, 100)) throw invalid("request_id");
  for (const key of Object.keys(raw)) {
    if (!["type", "requestId", "state", "connection"].includes(key)) throw invalid("payload");
  }
  const now = options.now ?? Date.now();
  const connection = raw.connection === undefined || raw.connection === null
    ? null
    : readConnection(raw.connection, now, options.allowLoopback === true);
  const holdsCredential = state === "ready" || state === "insufficient_balance";
  if (!holdsCredential && connection !== null) throw invalid("connection");
  if (state === "ready" && connection === null) throw invalid("connection");
  return { state: state as ProductAiState, connection };
}

/** The one instance product mode registers: the operator's gateway, with the token supplied per request, never here. */
export function productAiInstanceConfigs(
  origin: string,
  models: readonly ProductModel[],
  defaultModel: string | null,
): InstanceConfigMap {
  return {
    [PRODUCT_AI_INSTANCE_ID]: {
      driver: "openai-compat",
      displayName: DISPLAY_NAME,
      access: "api",
      enabled: true,
      config: {
        url: `${origin}${PRODUCT_AI_PATH}`,
        apiKeyEnv: PRODUCT_AI_KEY_ENV,
        provider: "",
        ...(defaultModel ? { model: defaultModel } : {}),
        managedModels: models.map(model => model.id),
        modelProtocols: Object.fromEntries(models.map(model => [model.id, model.protocol])),
        accountSlotWaitMs: ACCOUNT_SLOT_WAIT_MS,
        upstreamStreamRetries: UPSTREAM_STREAM_RETRIES,
      },
    },
  };
}

interface Session {
  origin: string;
  userId: string;
  tokenId: string;
  token: string;
  expiresAt: number;
  /** The pinned certificate this deployment shipped, when any; applied to the engine's own origin only. */
  ca?: string;
}

interface Epoch { id: number; fenced: boolean }

export interface ProductAiOptions {
  registry: ProviderRegistry;
  now?: () => number;
  /** Fixture/development only; production main never names a loopback origin. */
  allowLoopbackOrigin?: boolean;
  /** Interrupt the turns of the instances being replaced, then let their processes exit. */
  beforeReplace?: (ids: string[]) => void | Promise<void>;
  afterReplace?: (ids: string[]) => void;
  /** State, catalog, token or default changed: the host broadcasts config status and forgets snapshots. */
  onState?: () => void;
  log?: (line: string) => void;
}

// Protocol is compiled into the runtime's routes, so it belongs to this identity alongside endpoint and account.
// The pinned certificate is part of it too: a rotated certificate builds a new engine rather than reusing a stale one.
const catalogSignature = (session: { origin: string; userId: string; ca?: string }, models: readonly ProductModel[]) =>
  JSON.stringify([session.origin, session.userId, session.ca ?? "", models.map(model => `${model.id}\u0000${model.protocol}`).sort()]);

export class ProductAiProviders {
  private readonly options: ProductAiOptions;
  private readonly now: () => number;
  private readonly allowLoopback: boolean;
  private stateValue: ProductAiState = "unavailable";
  private session: Session | null = null;
  private catalogModels: readonly ProductModel[] = Object.freeze([]);
  private catalogDefault: string | null = null;
  private expired = false;
  private epoch: Epoch = { id: 0, fenced: false };
  private liveSignature: string | null = null;
  private ids = new Set<string>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ProductAiOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.allowLoopback = options.allowLoopbackOrigin === true;
  }

  owns(instanceId: string): boolean { return instanceId === PRODUCT_AI_INSTANCE_ID; }

  status(): ProductAiState { return this.visibleState(); }
  state(): ProductAiState { return this.visibleState(); }
  origin(): string | null { return this.session?.origin ?? null; }
  models(): readonly ProductModel[] { return this.catalogModels; }
  defaultModel(): string | null { return this.catalogDefault; }

  /** Readiness is deliberately not consulted: a paused account keeps its selections and admission refuses the call. */
  allows(selection: ModelSelection): boolean {
    return selection.instanceId === PRODUCT_AI_INSTANCE_ID &&
      this.catalogModels.some(model => model.id === selection.model);
  }

  select(previous?: ModelSelection): ModelSelection {
    if (previous && this.allows(previous)) return { ...previous };
    const model = this.catalogDefault && this.catalogModels.some(entry => entry.id === this.catalogDefault)
      ? this.catalogDefault
      : this.catalogModels[0]?.id;
    return model ? { instanceId: PRODUCT_AI_INSTANCE_ID, model } : { instanceId: "", model: "" };
  }

  resetTask(previous: ModelSelection, next: ModelSelection): TaskPatch {
    return previous.instanceId !== next.instanceId || previous.model !== next.model
      ? { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined }
      : {};
  }

  error(): string {
    return this.refusal(this.epoch) ?? PRODUCT_AI_MODEL_MESSAGE;
  }

  /** A revoked or changed capability fences the old wrappers synchronously, before this returns. */
  async apply(raw: unknown): Promise<void> {
    const update = parseProductAiUpdate(raw, { now: this.now(), allowLoopback: this.allowLoopback });
    const revision = ++this.revision;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const connection = update.connection;
    let reload = false;
    if (connection) {
      const signature = catalogSignature(connection, connection.models);
      const live = this.liveSignature === signature && this.options.registry.get(PRODUCT_AI_INSTANCE_ID) !== null;
      this.stateValue = update.state;
      this.session = {
        origin: connection.origin, userId: connection.userId, tokenId: connection.tokenId,
        token: connection.token, expiresAt: connection.expiresAt,
        ...(connection.ca ? { ca: connection.ca } : {}),
      };
      this.catalogModels = connection.models;
      this.catalogDefault = connection.defaultModel;
      this.expired = false;
      if (!live) {
        this.fenceEpoch();
        this.liveSignature = null;
        reload = true;
      }
      this.scheduleExpiry(revision);
    } else {
      if (this.session !== null || this.liveSignature !== null) {
        this.fenceEpoch();
        this.liveSignature = null;
        reload = true;
      }
      this.stateValue = update.state;
      this.session = null;
    }
    const task = this.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      if (reload) {
        await this.stopInstances(!connection);
        if (revision !== this.revision) return;
        if (connection) await this.load(revision);
      }
      if (revision !== this.revision) return;
      this.options.onState?.();
    });
    const settled = task.catch((error: unknown) => {
      if (revision === this.revision) {
        this.stateValue = "unavailable";
        this.expired = false;
        this.session = null;
        this.fenceEpoch();
        this.liveSignature = null;
        this.options.onState?.();
      }
      this.options.log?.(`[product ai] could not apply the account capability: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    this.tail = settled.catch(() => {});
    return settled;
  }

  async close(): Promise<void> {
    this.revision++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.stateValue = "unavailable";
    this.session = null;
    this.expired = false;
    this.fenceEpoch();
    this.liveSignature = null;
    const task = this.tail.catch(() => {}).then(() => this.stopInstances(true));
    this.tail = task;
    await task;
  }

  private visibleState(): ProductAiState {
    if ((this.stateValue === "ready" || this.stateValue === "insufficient_balance") && this.session && this.session.expiresAt <= this.now()) {
      return "unavailable";
    }
    return this.stateValue;
  }

  private fenceEpoch(): void {
    this.epoch.fenced = true;
    this.epoch = { id: this.epoch.id + 1, fenced: false };
  }

  private refusal(epoch: Epoch): string | null {
    if (this.stateValue === "pending") return PRODUCT_AI_PENDING_MESSAGE;
    if (this.stateValue === "suspended") return PRODUCT_AI_SUSPENDED_MESSAGE;
    // A credentialless balance refusal is authoritative even for a fenced wrapper; it never grants access.
    if (this.stateValue === "insufficient_balance" && !this.session) return PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE;
    if (this.expired) return PRODUCT_AI_EXPIRED_MESSAGE;
    if (epoch !== this.epoch || epoch.fenced) return PRODUCT_AI_UNAVAILABLE_MESSAGE;
    if (this.stateValue === "unavailable") return PRODUCT_AI_UNAVAILABLE_MESSAGE;
    const session = this.session;
    if (!session) return PRODUCT_AI_UNAVAILABLE_MESSAGE;
    if (session.expiresAt <= this.now()) {
      this.expire(session.tokenId, session.expiresAt);
      return PRODUCT_AI_EXPIRED_MESSAGE;
    }
    return null;
  }

  private credentialFor(instanceId: string, epoch: Epoch): { apiKey: string; expiresAt: number } {
    if (instanceId !== PRODUCT_AI_INSTANCE_ID) throw new Error("Account AI credentials were requested for an unknown engine.");
    const refusal = this.refusal(epoch);
    if (refusal) throw new Error(refusal);
    const session = this.session!;
    return { apiKey: session.token, expiresAt: session.expiresAt };
  }

  private scheduleExpiry(revision: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const session = this.session;
    if (!session || revision !== this.revision) return;
    const delay = Math.max(1, Math.min(2_147_483_647, session.expiresAt - this.now()));
    this.timer = setTimeout(() => this.expire(session.tokenId, session.expiresAt), delay);
    this.timer.unref?.();
  }

  private expire(tokenId: string, expiresAt: number): void {
    const session = this.session;
    if (!session || session.tokenId !== tokenId || session.expiresAt !== expiresAt) return;
    if (session.expiresAt > this.now()) { this.scheduleExpiry(this.revision); return; }
    this.revision++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.stateValue = "unavailable";
    this.expired = true;
    this.session = null;
    this.fenceEpoch();
    this.liveSignature = null;
    this.options.onState?.();
    this.tail = this.tail.catch(() => {}).then(() => this.stopInstances(true)).catch((error) => {
      this.options.log?.(`[product ai] could not release the expired engine: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async stopInstances(announce: boolean): Promise<void> {
    const ids = [...this.ids];
    this.ids.clear();
    this.liveSignature = null;
    if (ids.length) {
      let failure: unknown;
      try { await this.options.beforeReplace?.(ids); } catch (error) { failure = error; }
      for (const id of ids) {
        try { await this.options.registry.dispose(id); } catch (error) {
          this.options.log?.(`[product ai] could not stop ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (announce) this.options.afterReplace?.([]);
      if (failure) throw failure;
    } else if (announce) {
      this.options.afterReplace?.([]);
    }
  }

  private async load(revision: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    const epoch = this.epoch;
    const signature = catalogSignature(session, this.catalogModels);
    await this.options.registry.load(
      productAiInstanceConfigs(session.origin, this.catalogModels, this.catalogDefault),
      instance => this.decorateFor(epoch)(instance),
      {
        requestCredential: instanceId => this.credentialFor(instanceId, epoch),
        // The deployment's own certificate reaches the driver as a scoped transport input, never through config,
        // environment or a process-wide TLS setting.
        ...(session.ca ? { requestTrust: () => ({ origin: session.origin, ca: session.ca! }) } : {}),
      },
    );
    if (revision !== this.revision) {
      await this.stopInstances(true);
      return;
    }
    // ProviderRegistry keeps a failed create as an unavailable shadow; the account engine has no such half-state.
    if (this.options.registry.get(PRODUCT_AI_INSTANCE_ID) === null) {
      await this.stopInstances(false);
      throw new Error("The account's AI engine could not start.");
    }
    this.ids.add(PRODUCT_AI_INSTANCE_ID);
    this.liveSignature = signature;
    this.options.afterReplace?.([PRODUCT_AI_INSTANCE_ID]);
  }

  private admit(epoch: Epoch, model?: string): void {
    const refusal = this.refusal(epoch);
    if (refusal) throw new Error(refusal);
    if (model !== undefined && !this.catalogModels.some(entry => entry.id === model)) throw new Error(PRODUCT_AI_MODEL_MESSAGE);
  }

  private decorateFor(epoch: Epoch): (instance: ProviderInstance) => ProviderInstance {
    return instance => {
      const catalog = (): ModelCatalog => ({
        default: this.catalogDefault ?? this.catalogModels[0]?.id ?? "",
        options: this.catalogModels.map(model => ({ id: model.id, label: model.label, contextWindow: model.maxContextTokens })),
      });
      return {
        ...instance,
        get models() { return catalog(); },
        refreshModels: async () => {},
        installRuntime: undefined,
        startAuthentication: undefined,
        getAuthentication: undefined,
        completeAuthentication: undefined,
        cancelAuthentication: undefined,
        signOut: undefined,
        snapshot: async () => {
          const refusal = this.refusal(epoch);
          if (refusal) return { state: "unavailable", reason: refusal };
          try {
            const snapshot = await instance.snapshot();
            const after = this.refusal(epoch);
            if (after) return { state: "unavailable", reason: after };
            return { ...snapshot, billing: "metered", account: undefined };
          } catch (error) {
            return { state: "unavailable", reason: error instanceof Error ? error.message.slice(0, 300) : PRODUCT_AI_UNAVAILABLE_MESSAGE };
          }
        },
        adapter: {
          ...instance.adapter,
          sendTurn: async (input: SendTurnInput) => {
            this.admit(epoch, input.model);
            return instance.adapter.sendTurn(input);
          },
        },
        ...(instance.generateText ? {
          generateText: async (prompt: string, options?: TextGenerationOptions) => {
            this.admit(epoch, options?.model);
            return instance.generateText!(prompt, options);
          },
        } : {}),
      } satisfies ProviderInstance;
    };
  }
}
