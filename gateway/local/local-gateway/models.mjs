// Catalog construction for the local gateway.
//
// Two inputs are supported:
//   * the Worker's own `AI_MODELS` array (a JSON file), used verbatim after
//     validation — the operator has already written every price;
//   * an OMP `models.yml` (pass `--open-models`), whose metadata is real but
//     whose prices are NOT: this repository never invents a price from another
//     product's config. A seeded model stays `enabled: false` unless an
//     explicit rate is supplied for it, so nothing can be billed by accident.
//
// Rates are microPoints per million tokens (1 point = 1,000,000 microPoints).
// Absent or partial rates leave the model disabled.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class CatalogError extends Error {}

function fail(message) {
  throw new CatalogError(message);
}

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

/** The price names the Worker's own schema accepts. */
const RATE_FIELDS = [
  ["inputMicroPointsPerMillion", positive],
  ["cachedInputMicroPointsPerMillion", nonnegative],
  ["outputMicroPointsPerMillion", positive],
];

/** Reads a rates document: `{modelId: {inputMicroPointsPerMillion, …}}`. */
export function readRates(value, label = "rates") {
  let document = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return {};
    try {
      document = JSON.parse(text.startsWith("{") ? text : readFileSync(path.resolve(text), "utf8"));
    } catch {
      fail(`${label} must be JSON or a path to a JSON file`);
    }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) fail(`${label} must be an object keyed by model id`);
  const rates = new Map();
  for (const [id, entry] of Object.entries(document)) {
    if (!MODEL_ID.test(id)) fail(`${label}: ${JSON.stringify(id)} is not a model id`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${label}.${id} must be an object`);
    const rate = {};
    for (const [field, check] of RATE_FIELDS) {
      if (entry[field] === undefined) continue;
      if (!check(entry[field])) fail(`${label}.${id}.${field} must be a nonnegative safe integer`);
      rate[field] = entry[field];
    }
    if (!positive(rate.inputMicroPointsPerMillion) || !positive(rate.outputMicroPointsPerMillion)) {
      fail(`${label}.${id} needs inputMicroPointsPerMillion and outputMicroPointsPerMillion`);
    }
    rates.set(id, rate);
  }
  return rates;
}

function describeModel(model, { rates, maxOutputTokens, pricingVersion }) {
  const id = model?.id;
  if (typeof id !== "string" || !MODEL_ID.test(id)) fail(`model without a usable id`);
  const contextWindow = model.contextWindow;
  if (!positive(contextWindow)) fail(`${id}: contextWindow must be a positive safe integer`);
  const declaredMax = positive(model.maxTokens) ? model.maxTokens : null;
  const ceiling = positive(maxOutputTokens) ? Math.min(maxOutputTokens, declaredMax ?? maxOutputTokens) : declaredMax;
  if (!positive(ceiling) || ceiling > contextWindow) fail(`${id}: maxOutputTokens must be a positive integer no larger than its context`);
  const responses = typeof model.api === "string" && /responses/i.test(model.api);
  const rate = rates.get(id) ?? null;
  const entry = {
    id,
    label: typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim().slice(0, 80) : id,
    protocol: responses ? "responses" : "chat",
    pricingVersion,
    inputMicroPointsPerMillion: rate?.inputMicroPointsPerMillion ?? 0,
    cachedInputMicroPointsPerMillion: rate?.cachedInputMicroPointsPerMillion ?? rate?.inputMicroPointsPerMillion ?? 0,
    outputMicroPointsPerMillion: rate?.outputMicroPointsPerMillion ?? 0,
    maxContextTokens: contextWindow,
    maxOutputTokens: ceiling,
    upstreamModel: id,
    ...(responses ? {} : { chatMaxTokensField: "max_tokens" }),
    enabled: Boolean(rate),
  };
  return entry;
}

/**
 * Builds the catalog from an OMP `models.yml`. `provider` selects which
 * provider block is mirrored (default: the only one). Every model whose id has
 * no explicit rate is emitted disabled, so the Worker refuses it.
 */
export function catalogFromOpenModels({ document, provider, rates = new Map(), maxOutputTokens, pricingVersion = "local-v1" }) {
  const providers = document?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) fail("models.yml has no providers block");
  const names = Object.keys(providers);
  if (names.length === 0) fail("models.yml has no providers");
  const selectedName = provider ?? (names.length === 1 ? names[0] : null);
  if (!selectedName) fail(`models.yml has ${names.length} providers; choose one with --open-models-provider`);
  const selected = providers[selectedName];
  if (!selected || typeof selected !== "object") fail(`models.yml has no provider ${JSON.stringify(selectedName)}`);
  const models = Array.isArray(selected.models) ? selected.models : [];
  if (models.length === 0) fail(`provider ${JSON.stringify(selectedName)} declares no models`);
  const catalog = models.map((model) => describeModel({ ...model, api: model.api ?? selected.api }, {
    rates, maxOutputTokens, pricingVersion,
  }));
  const ids = new Set();
  for (const model of catalog) {
    if (ids.has(model.id)) fail(`model ${JSON.stringify(model.id)} is declared twice`);
    ids.add(model.id);
  }
  const baseURL = typeof selected.baseUrl === "string" ? selected.baseUrl : null;
  return { catalog, baseURL, provider: selectedName, apiKey: typeof selected.apiKey === "string" ? selected.apiKey : null };
}

const REQUIRED = ["id", "label", "protocol", "pricingVersion", "inputMicroPointsPerMillion", "cachedInputMicroPointsPerMillion", "outputMicroPointsPerMillion", "maxContextTokens", "maxOutputTokens", "upstreamModel", "enabled"];

/** Validates a catalog file in the Worker's own `AI_MODELS` shape. */
export function validateCatalogFile(entries) {
  if (!Array.isArray(entries) || entries.length === 0) fail("--models must be a nonempty JSON array");
  const seen = new Set();
  return entries.map((model, index) => {
    const label = `models[${index}]`;
    if (!model || typeof model !== "object" || Array.isArray(model)) fail(`${label} must be an object`);
    for (const field of REQUIRED) if (model[field] === undefined) fail(`${label}.${field} is required`);
    if (typeof model.id !== "string" || !MODEL_ID.test(model.id)) fail(`${label}.id must be a model id`);
    if (seen.has(model.id)) fail(`${label}.id is duplicated`);
    seen.add(model.id);
    if (model.protocol !== "chat" && model.protocol !== "responses") fail(`${label}.protocol must be chat or responses`);
    if (model.protocol === "chat" && model.chatMaxTokensField !== "max_tokens" && model.chatMaxTokensField !== "max_completion_tokens") {
      fail(`${label}.chatMaxTokensField must be max_tokens or max_completion_tokens for a chat model`);
    }
    for (const field of ["inputMicroPointsPerMillion", "outputMicroPointsPerMillion"]) {
      // A disabled entry may stay unpriced; an enabled one must have real rates.
      if (!(model.enabled ? positive(model[field]) : nonnegative(model[field]))) {
        fail(`${label}.${field} must be a ${model.enabled ? "positive" : "nonnegative"} safe integer`);
      }
    }
    if (!nonnegative(model.cachedInputMicroPointsPerMillion)) fail(`${label}.cachedInputMicroPointsPerMillion must be a nonnegative safe integer`);
    for (const field of ["maxContextTokens", "maxOutputTokens"]) {
      if (!positive(model[field])) fail(`${label}.${field} must be a positive safe integer`);
    }
    if (model.maxOutputTokens > model.maxContextTokens) fail(`${label}.maxOutputTokens must not exceed maxContextTokens`);
    if (typeof model.enabled !== "boolean") fail(`${label}.enabled must be a boolean`);
    return { ...model };
  });
}

/** Reads the catalog document named by `--models`. */
export function readCatalogFile(file) {
  let text;
  try {
    text = readFileSync(path.resolve(file), "utf8");
  } catch {
    fail(`cannot read --models ${JSON.stringify(file)}`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail("--models must contain JSON (an AI_MODELS array or an OMP models.yml is not JSON; pass the YAML with --open-models)");
  }
  return validateCatalogFile(document);
}

/** Reads an OMP `models.yml` file. */
export function readOpenModels(file) {
  let text;
  try {
    text = readFileSync(path.resolve(file), "utf8");
  } catch {
    fail(`cannot read --open-models ${JSON.stringify(file)}`);
  }
  let document;
  try {
    document = parseYAML(text);
  } catch {
    fail(`--open-models ${JSON.stringify(file)} is not valid YAML`);
  }
  return document;
}
