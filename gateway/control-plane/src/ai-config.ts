import { z } from "zod";

import type { ProductModel } from "../../../packages/shared/product-account";

/**
 * Operator-provisioned upstream AI configuration for the hosted product:
 * read from the Worker environment on every request, never from user input.
 * Nothing here throws. A partially configured deployment still signs accounts
 * in, answers `unavailable`, and forwards nothing.
 */

const modelIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
/** Every amount and token bound is a nonnegative safe integer; anything else
 * could not survive the BigInt pricing arithmetic in the wallet. */
const amountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenBoundSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

function printable(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point === undefined || point < 32 || point === 127) return false;
    }
    return true;
  });
}

const modelSchema = z.strictObject({
  id: modelIdSchema,
  label: printable(80),
  protocol: z.enum(["chat", "responses"]),
  pricingVersion: printable(64),
  inputMicroPointsPerMillion: amountSchema,
  cachedInputMicroPointsPerMillion: amountSchema.optional(),
  outputMicroPointsPerMillion: amountSchema,
  maxContextTokens: tokenBoundSchema,
  maxOutputTokens: tokenBoundSchema,
  upstreamModel: printable(200),
  chatMaxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  enabled: z.boolean(),
});

export interface AiModelConfig extends ProductModel {
  /** Null for `protocol: "responses"`, which has its own output parameter. */
  chatMaxTokensField: "max_tokens" | "max_completion_tokens" | null;
  enabled: boolean;
  upstreamModel: string;
  channelId?: string;
}

export interface AiConfig {
  /** Upstream API base without credentials, query, fragment, or trailing
   * slash; null when unset or invalid. */
  upstreamBaseURL: string | null;
  upstreamApiKey: string | null;
  /** Public ID of the enabled catalog entry new selections start from. */
  defaultModel: string | null;
  models: readonly AiModelConfig[];
  operatorUserIds: ReadonlySet<string>;
  routes?: ReadonlyMap<string, { baseURL: string; apiKey: string }>;
  /** Redacted codes for ignored settings and catalog entries, never values. */
  issues: readonly string[];
  /** True only when a request could be forwarded at all. */
  ready: boolean;
}

/** The AI settings a deployment may provide. */
export interface AiEnvironment {
  AI_DEFAULT_MODEL?: string;
  AI_MODELS?: string;
  AI_OPERATOR_USER_IDS?: string;
  AI_UPSTREAM_API_KEY?: string;
  AI_UPSTREAM_BASE_URL?: string;
}

const EMPTY: AiConfig = {
  upstreamBaseURL: null,
  upstreamApiKey: null,
  defaultModel: null,
  models: [],
  operatorUserIds: new Set<string>(),
  issues: [],
  ready: false,
};

const INVALID_JSON = Symbol("invalid-json");

export function readUpstreamBaseURL(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A JSON setting may arrive parsed (a wrangler JSON var) or as text (a secret). */
function parseEnvJSON(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return INVALID_JSON;
  }
}

function readModels(value: unknown): { models: AiModelConfig[]; issues: string[] } {
  const raw = parseEnvJSON(value);
  if (raw === undefined) return { models: [], issues: [] };
  if (!Array.isArray(raw)) return { models: [], issues: ["models_json"] };

  const models: AiModelConfig[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const label = `model_${index + 1}`;
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(`${label}_shape`);
      continue;
    }
    const model = parsed.data;
    if (model.maxOutputTokens > model.maxContextTokens) {
      issues.push(`${label}_context`);
      continue;
    }
    if (model.protocol === "chat" && model.chatMaxTokensField === undefined) {
      issues.push(`${label}_token_field`);
      continue;
    }
    if (seen.has(model.id)) {
      issues.push(`${label}_duplicate`);
      continue;
    }
    seen.add(model.id);
    models.push({
      id: model.id,
      label: model.label,
      protocol: model.protocol,
      pricingVersion: model.pricingVersion,
      inputMicroPointsPerMillion: model.inputMicroPointsPerMillion,
      // No cached price is no discount: bill cache reads as fresh input.
      cachedInputMicroPointsPerMillion: model.cachedInputMicroPointsPerMillion ?? model.inputMicroPointsPerMillion,
      outputMicroPointsPerMillion: model.outputMicroPointsPerMillion,
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      chatMaxTokensField: model.protocol === "chat" ? model.chatMaxTokensField ?? null : null,
      enabled: model.enabled,
      upstreamModel: model.upstreamModel,
    });
  }
  return { models, issues };
}

/** A malformed entry invalidates the whole list: admitting a subset would make
 * operator permission depend on which elements happened to parse. */
function readOperatorIds(value: unknown): { ids: ReadonlySet<string>; valid: boolean } {
  const raw = parseEnvJSON(value);
  if (raw === undefined) return { ids: new Set<string>(), valid: true };
  if (!Array.isArray(raw)) return { ids: new Set<string>(), valid: false };
  const ids = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length > 128 || entry.trim() !== entry || entry === "") {
      return { ids: new Set<string>(), valid: false };
    }
    ids.add(entry);
  }
  return { ids, valid: true };
}

export function readAiConfig(env: object): AiConfig {
  const settings = env as Partial<Record<string, unknown>>;
  const issues: string[] = [];

  const upstreamBaseURL = readUpstreamBaseURL(settings.AI_UPSTREAM_BASE_URL);
  if (upstreamBaseURL === null) issues.push("upstream_url");

  const key = settings.AI_UPSTREAM_API_KEY;
  const upstreamApiKey =
    typeof key === "string" && key.length >= 8 && key.length <= 512 && !/\s/.test(key) ? key : null;
  if (upstreamApiKey === null) issues.push("upstream_key");

  const { models, issues: modelIssues } = readModels(settings.AI_MODELS);
  issues.push(...modelIssues);

  const declaredDefault =
    typeof settings.AI_DEFAULT_MODEL === "string" ? settings.AI_DEFAULT_MODEL.trim() : "";
  const enabled = models.filter((model) => model.enabled);
  const defaultModel =
    declaredDefault !== "" && enabled.some((model) => model.id === declaredDefault)
      ? declaredDefault
      : null;
  if (declaredDefault === "") issues.push("default_model_missing");
  else if (defaultModel === null) issues.push("default_model");

  const operators = readOperatorIds(settings.AI_OPERATOR_USER_IDS);
  if (!operators.valid) issues.push("operator_ids");

  return {
    upstreamBaseURL,
    upstreamApiKey,
    defaultModel,
    models,
    operatorUserIds: operators.ids,
    issues,
    ready: upstreamBaseURL !== null && upstreamApiKey !== null && defaultModel !== null && enabled.length > 0,
  };
}

/** The same configuration for callers that must not fail: an unexpected error
 * leaves AI unavailable rather than breaking the request that asked. */
export function aiConfigFrom(env: unknown): AiConfig {
  try {
    return readAiConfig(env as object);
  } catch {
    return EMPTY;
  }
}

/** Enabled catalog entries, exactly as published to clients. */
export function publicModels(config: AiConfig): ProductModel[] {
  return config.models.filter((model) => model.enabled).map(({ id, label, protocol, pricingVersion,
    inputMicroPointsPerMillion, cachedInputMicroPointsPerMillion, outputMicroPointsPerMillion,
    maxContextTokens, maxOutputTokens }) => ({
    id,
    label,
    protocol,
    pricingVersion,
    inputMicroPointsPerMillion,
    cachedInputMicroPointsPerMillion,
    outputMicroPointsPerMillion,
    maxContextTokens,
    maxOutputTokens,
  }));
}

/** An enabled model by public ID; disabled and unknown IDs are absent. */
export function findModel(config: AiConfig, id: string): AiModelConfig | null {
  return config.models.find((model) => model.enabled && model.id === id) ?? null;
}
