import { authenticateModelToken } from "./account-ai";
import { findModel, publicModels, type AiConfig, type AiModelConfig } from "./ai-config";
import { loadRuntimeAiConfig } from "./channel-store";
import { markRequestStreaming, releaseRequest, reservationMicroPoints, reserveRequest, reviewRequest, settleRequest } from "./ai-wallet";
import { HTTPError, JSON_HEADERS, json, readBoundedJSON } from "./http";
import { applyBillingCatalog, estimateTaskMicroPoints, inputReservationTokens, planTaskBilling, refreshBillingController, type TaskBillingSnapshot } from "./task-billing";

/** Screenshots and tool context ride in this body; still bounded. */
export const AI_REQUEST_LIMIT_BYTES = 48 * 1024 * 1024;
/** One SSE event, so a desynchronised stream cannot exhaust memory. */
export const AI_SSE_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
/** A non-streaming completion. */
export const AI_JSON_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
/** One upstream exchange; a tool follow-up is a separate request with its own
 * reservation. */
export const AI_UPSTREAM_TIMEOUT_MS = 300_000;
export const DISCONNECT_DRAIN_MS = 120_000;

const MODELS_PATH = "/v1/ai/models";
const CHAT_PATH = "/v1/ai/chat/completions";
const RESPONSES_PATH = "/v1/ai/responses";
const QUOTE_PATH = "/v1/ai/quote";
const UPSTREAM_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 408, 409, 413, 422, 429]);
const AI_BUSY_RETRY_AFTER_SECONDS = 2;

const CHAT_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "reasoning_effort",
  "n",
  "service_tier",
]);

const RESPONSES_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "text",
  "include",
  "store",
  "background",
  "service_tier",
]);

type InferenceMode = "chat" | "responses";

interface UsageCandidate {
  cached: unknown;
  input: unknown;
  output: unknown;
  write: unknown;
  writeHour: unknown;
}

interface PreparedRequest {
  model: AiModelConfig;
  outputCap: number;
  stream: boolean;
  upstream: Record<string, unknown>;
  inputReserve?: number;
  billing?: TaskBillingSnapshot;
}

interface UpstreamControl {
  abort: () => void;
  dispose: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
  disconnected: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const invalid = (): HTTPError => new HTTPError(400, "invalid_request");

/** The inference error envelope: a stable code, a coarse type, and a neutral
 * message that never carries upstream text, a prompt, or a token. */
export function inferenceError(status: number, code: string, message: string): Response {
  let type = "invalid_request_error";
  if (status === 401) type = "authentication_error";
  else if (status === 402) type = "insufficient_quota";
  else if (status === 403) type = code === "model_not_allowed" ? "invalid_request_error" : "permission_error";
  else if (status === 429) type = "rate_limit_error";
  else if (status === 502) type = "upstream_error";
  else if (status === 503) type = "service_unavailable";
  return json({ error: { code, message, type } }, status);
}

function failure(error: unknown): Response {
  if (!(error instanceof HTTPError)) {
    return inferenceError(503, "ai_unavailable", "The AI service is not available.");
  }
  if (error.status === 413) return inferenceError(413, "request_too_large", "The request body is too large.");
  if (error.status === 401) return inferenceError(401, "ai_token_invalid", "The AI token is invalid or expired.");
  if (error.status === 402) {
    if (error.code === "budget_exceeded") return inferenceError(402, "budget_exceeded", "The request exceeds the authorized points budget.");
    return inferenceError(402, "insufficient_balance", "Available points cannot cover another request.");
  }
  if (error.status === 429) {
    const response = inferenceError(429, "ai_busy", "Too many requests are in flight for this account.");
    response.headers.set("retry-after", String(AI_BUSY_RETRY_AFTER_SECONDS));
    return response;
  }
  if (error.status === 403) {
    if (error.code === "ai_suspended") {
      return inferenceError(403, "ai_suspended", "AI access for this account is suspended.");
    }
    if (error.code === "model_not_allowed") {
      return inferenceError(403, "model_not_allowed", "The requested model is not allowed.");
    }
    return inferenceError(403, "ai_not_enabled", "AI access for this account is not enabled.");
  }
  if (error.status === 503) return error.code === "dynamic_billing_disabled"
    ? inferenceError(503, "dynamic_billing_disabled", "Task pricing is not enabled.")
    : inferenceError(503, "ai_unavailable", "The AI service is not available.");
  return inferenceError(400, "invalid_request", "The request was rejected.");
}

async function readInferenceBody(request: Request): Promise<Record<string, unknown>> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw invalid();
  const value = await readBoundedJSON(request, AI_REQUEST_LIMIT_BYTES);
  if (!isRecord(value)) throw invalid();
  return value;
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid();
}

function optionalNumber(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && !(typeof value === "number" && Number.isFinite(value))) throw invalid();
}

function optionalBoolean(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && typeof value !== "boolean") throw invalid();
}

function validateTools(tools: unknown) {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw invalid();
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") throw invalid();
    const chatShape = isRecord(tool.function) && isString(tool.function.name) && tool.function.name.length > 0;
    const responsesShape = isString(tool.name) && tool.name.length > 0;
    if (!chatShape && !responsesShape) throw invalid();
  }
}

function prepareChat(body: Record<string, unknown>, model: AiModelConfig): PreparedRequest {
  rejectUnknownFields(body, CHAT_FIELDS);
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isRecord)) throw invalid();
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid();
  if (body.n !== undefined && body.n !== 1) throw invalid();
  if (body.stream_options !== undefined) {
    const options = body.stream_options;
    if (!isRecord(options)) throw invalid();
    for (const key of Object.keys(options)) if (key !== "include_usage") throw invalid();
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") throw invalid();
  }

  const maxTokens = body.max_tokens;
  const maxCompletion = body.max_completion_tokens;
  if (maxTokens !== undefined && maxCompletion !== undefined) throw invalid();
  const requested = maxTokens ?? maxCompletion;
  if (requested !== undefined && !isPositiveInteger(requested)) throw invalid();
  const outputCap = Math.min(requested ?? model.maxOutputTokens, model.maxOutputTokens);

  optionalNumber(body, "temperature");
  optionalNumber(body, "top_p");
  optionalNumber(body, "presence_penalty");
  optionalNumber(body, "frequency_penalty");
  optionalBoolean(body, "parallel_tool_calls");
  if (body.seed !== undefined && (typeof body.seed !== "number" || !Number.isSafeInteger(body.seed))) throw invalid();
  if (body.stop !== undefined && !isString(body.stop) && !(Array.isArray(body.stop) && body.stop.every(isString))) {
    throw invalid();
  }
  if (body.tool_choice !== undefined && !isString(body.tool_choice) && !isRecord(body.tool_choice)) throw invalid();
  if (body.response_format !== undefined && !isRecord(body.response_format)) throw invalid();
  if (body.reasoning_effort !== undefined && !isString(body.reasoning_effort)) throw invalid();
  validateTools(body.tools);

  const field = model.chatMaxTokensField;
  if (field !== "max_tokens" && field !== "max_completion_tokens") throw new HTTPError(503, "ai_unavailable");

  const stream = body.stream === true;
  const upstream: Record<string, unknown> = { ...body };
  delete upstream.max_tokens;
  delete upstream.max_completion_tokens;
  delete upstream.stream_options;
  upstream.model = model.upstreamModel;
  upstream.n = 1;
  upstream.stream = stream;
  upstream[field] = outputCap;
  // Terminal chat usage is what the wallet settles from.
  if (stream) upstream.stream_options = { include_usage: true };
  return { model, outputCap, stream, upstream };
}

function prepareResponses(body: Record<string, unknown>, model: AiModelConfig): PreparedRequest {
  rejectUnknownFields(body, RESPONSES_FIELDS);
  const input = body.input;
  const inputValid = isString(input)
    ? input.length > 0
    : Array.isArray(input) && input.length > 0 && input.every((item) => isString(item) || isRecord(item));
  if (!inputValid) throw invalid();
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid();
  if (body.instructions !== undefined && !isString(body.instructions)) throw invalid();
  if (body.background !== undefined && body.background !== false) throw invalid();
  if (body.store !== undefined && body.store !== false) throw invalid();
  if (body.include !== undefined) {
    if (!Array.isArray(body.include) || body.include.some((entry) => entry !== "reasoning.encrypted_content")) {
      throw invalid();
    }
  }
  const requested = body.max_output_tokens;
  if (requested !== undefined && !isPositiveInteger(requested)) throw invalid();
  const outputCap = Math.min(requested ?? model.maxOutputTokens, model.maxOutputTokens);
  optionalNumber(body, "temperature");
  optionalNumber(body, "top_p");
  optionalBoolean(body, "parallel_tool_calls");
  if (body.tool_choice !== undefined && !isString(body.tool_choice) && !isRecord(body.tool_choice)) throw invalid();
  if (body.reasoning !== undefined && !isRecord(body.reasoning)) throw invalid();
  if (body.text !== undefined && !isRecord(body.text)) throw invalid();
  validateTools(body.tools);

  const stream = body.stream === true;
  const upstream: Record<string, unknown> = { ...body };
  delete upstream.background;
  upstream.model = model.upstreamModel;
  // Remote storage and background execution stay off.
  upstream.store = false;
  upstream.max_output_tokens = outputCap;
  return { model, outputCap, stream, upstream };
}

async function preparedRequest(env: Env, body: Record<string, unknown>, aiConfig: AiConfig, mode: InferenceMode): Promise<PreparedRequest> {
  const modelId = body.model;
  if (!isString(modelId) || modelId.length === 0) throw invalid();
  const budget = body.billing;
  if (budget !== undefined && (!isRecord(budget) || Object.keys(budget).some((key) => key !== "maxMicroPoints") || !isCount(budget.maxMicroPoints))) throw invalid();
  const plan = await planTaskBilling(env, aiConfig, mode, body);
  const model = plan?.model ?? findModel(aiConfig, modelId);
  if (!model || !model.enabled || model.protocol !== mode) throw new HTTPError(403, "model_not_allowed");
  if (!plan && body.service_tier !== undefined) throw invalid();
  const wire: Record<string, unknown> = { ...body, model: model.id };
  delete wire.billing;
  if (plan) {
    if (plan.snapshot.serviceTier === "default") delete wire.service_tier;
    else wire.service_tier = plan.snapshot.serviceTier;
  }
  const prepared = mode === "chat" ? prepareChat(wire, model) : prepareResponses(wire, model);
  if (plan) prepared.billing = plan.snapshot;
  prepared.inputReserve = plan?.snapshot.maxInputTokens ?? inputReservationTokens(body, model.maxContextTokens, prepared.outputCap);
  const reserved = plan?.snapshot.reservedMicroPoints ?? reservationMicroPoints({ ...model, maxContextTokens: prepared.inputReserve, maxOutputTokens: prepared.outputCap });
  if (isRecord(budget) && reserved > (budget.maxMicroPoints as number)) throw new HTTPError(402, "budget_exceeded");
  return prepared;
}

/** A completion body may carry token counts either directly or under `usage`. */
function usageSource(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  const nested = isRecord(record.usage) ? record.usage : null;
  if (nested && keys.some((key) => key in nested)) return nested;
  return keys.some((key) => key in record) ? record : null;
}

function cacheWrites(source: Record<string, unknown>, details: Record<string, unknown> | null): { write: unknown; writeHour: unknown } {
  const split = isRecord(source.cache_creation) ? source.cache_creation : null;
  const hour = split?.ephemeral_1h_input_tokens ?? details?.cache_write_1h_tokens ?? source.cache_write_1h_tokens;
  const ordinary = split?.ephemeral_5m_input_tokens ?? details?.cache_write_tokens ?? source.cache_write_tokens;
  const total = source.cache_creation_input_tokens ?? details?.cache_creation_tokens;
  if (ordinary !== undefined) return { write: ordinary, writeHour: hour ?? null };
  if (isCount(total) && isCount(hour) && hour <= total) return { write: total - hour, writeHour: hour };
  if (total !== undefined) return { write: null, writeHour: null };
  return { write: null, writeHour: hour ?? null };
}

function chatUsageCandidate(record: Record<string, unknown>): UsageCandidate | null {
  const source = usageSource(record, ["prompt_tokens", "completion_tokens"]);
  if (!source) return null;
  const details = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : null;
  // `null`, never 0: an unreported cache split must bill conservatively.
  return {
    cached: typeof details?.cached_tokens === "number" ? details.cached_tokens : null,
    input: source.prompt_tokens,
    output: source.completion_tokens,
    ...cacheWrites(source, details),
  };
}

function responsesUsageCandidate(record: Record<string, unknown>): UsageCandidate | null {
  const source = usageSource(record, ["input_tokens", "output_tokens"]);
  if (!source) return null;
  const details = isRecord(source.input_tokens_details) ? source.input_tokens_details : null;
  return {
    cached: typeof details?.cached_tokens === "number" ? details.cached_tokens : null,
    input: source.input_tokens,
    output: source.output_tokens,
    ...cacheWrites(source, details),
  };
}

async function markReview(env: Env, requestId: string, reason: string): Promise<void> {
  try {
    await reviewRequest(env, requestId, reason);
  } catch {
    // The reservation remains; the scheduled recovery sweep surfaces it.
  }
}

/** Missing or malformed usage is never zero: it becomes a reviewable
 * reservation. An unreported cache split is not a discount, so the wallet
 * bills that input at the higher of the two rates. */
async function settleUsage(env: Env, requestId: string, candidate: UsageCandidate | null): Promise<boolean> {
  return (await settleOutcome(env, requestId, candidate)) === null;
}

/** Null when the usage settled, else why it did not. */
async function settleOutcome(env: Env, requestId: string, candidate: UsageCandidate | null, reason: string | null = null): Promise<string | null> {
  if (!candidate) {
    const missing = reason === "client_disconnected_settled" ? "client_disconnected" : "usage_missing";
    await markReview(env, requestId, missing);
    return missing;
  }
  const { cached, input, output, write, writeHour } = candidate;
  if (!isCount(input) || !isCount(output) || (cached !== null && (!isCount(cached) || cached > input))
      || (write !== null && !isCount(write)) || (writeHour !== null && !isCount(writeHour))
      || Number(cached ?? 0) + Number(write ?? 0) + Number(writeHour ?? 0) > Number(input)) {
    const invalidUsage = reason === "client_disconnected_settled" ? "client_disconnected" : "usage_invalid";
    await markReview(env, requestId, invalidUsage);
    return invalidUsage;
  }
  try {
    const result = await settleRequest(env, requestId, {
      cachedInputTokens: cached === null ? null : cached,
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: write === null ? null : write as number,
      cacheWriteHourTokens: writeHour === null ? null : writeHour as number,
    }, Date.now(), reason);
    await refreshBillingController(env).catch(() => {
      console.error(JSON.stringify({ message: "billing controller refresh failed", requestId }));
    });
    return result.status === "settled" ? null : "settle_failed";
  } catch {
    return "settle_failed";
  }
}

function createUpstreamControl(requestSignal: AbortSignal): UpstreamControl {
  const controller = new AbortController();
  let timedOut = false;
  let disconnected = false;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, AI_UPSTREAM_TIMEOUT_MS);
  const onClientAbort = () => {
    disconnected = true;
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, DISCONNECT_DRAIN_MS);
  };
  if (requestSignal.aborted) onClientAbort();
  else requestSignal.addEventListener("abort", onClientAbort, { once: true });
  return {
    abort: () => controller.abort(),
    dispose: () => {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", onClientAbort);
    },
    signal: controller.signal,
    timedOut: () => timedOut,
    disconnected: () => disconnected,
  };
}

interface SseFrame {
  lines: string[];
}

/** SSE is line-oriented with CR, LF, or CRLF endings and dispatches a frame at
 * a blank line (WHATWG HTML "server-sent events"). */
class SseReader {
  private buffer = "";
  private bufferBytes = 0;
  private start = 0;
  private scanned = 0;
  private frame: string[] = [];
  private frameBytes = 0;
  private readonly limit: number;
  private readonly encoder = new TextEncoder();

  constructor(limit: number) {
    this.limit = limit;
  }

  push(text: string): SseFrame[] {
    this.buffer += text;
    this.bufferBytes += this.encoder.encode(text).byteLength;
    const frames = this.drain(false);
    if (this.bufferBytes > this.limit) throw new HTTPError(502, "upstream_error");
    return frames;
  }

  flush(): SseFrame[] {
    return this.drain(true);
  }

  private drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const next = this.readLine(final);
      if (next === null) break;
      this.bufferBytes -= this.encoder.encode(next.consumed).byteLength;
      if (next.line.length === 0) {
        if (this.frame.length > 0) frames.push(this.take());
        continue;
      }
      this.frame.push(next.line);
      this.frameBytes += this.encoder.encode(next.line).byteLength + 1;
      if (this.frameBytes > this.limit) {
        this.frame = [];
        this.frameBytes = 0;
        throw new HTTPError(502, "upstream_error");
      }
    }
    if (final && this.frame.length > 0) frames.push(this.take());
    this.reclaim();
    return frames;
  }

  private take(): SseFrame {
    const frame = { lines: this.frame };
    this.frame = [];
    this.frameBytes = 0;
    return frame;
  }

  /** Drop the already-consumed prefix so a long stream does not grow one
   * string without bound. */
  private reclaim() {
    if (this.start < 4096) return;
    this.buffer = this.buffer.slice(this.start);
    this.scanned -= this.start;
    this.start = 0;
  }

  /** One line without its terminator, plus the raw prefix it consumed. `null`
   * when more input is needed. Scanning resumes where the last call stopped,
   * so a frame arriving in many chunks is inspected once per character. */
  private readLine(final: boolean): { consumed: string; line: string } | null {
    for (let index = this.scanned; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if (character === "\n") {
        const line = this.buffer.slice(this.start, index);
        const consumed = this.buffer.slice(this.start, index + 1);
        this.start = index + 1;
        this.scanned = this.start;
        return { consumed, line };
      }
      if (character === "\r") {
        if (index + 1 === this.buffer.length && !final) {
          this.scanned = index;
          return null;
        }
        const width = this.buffer[index + 1] === "\n" ? 2 : 1;
        const line = this.buffer.slice(this.start, index);
        const consumed = this.buffer.slice(this.start, index + width);
        this.start = index + width;
        this.scanned = this.start;
        return { consumed, line };
      }
    }
    if (final && this.start < this.buffer.length) {
      const line = this.buffer.slice(this.start);
      this.start = this.buffer.length;
      this.scanned = this.start;
      return { consumed: line, line };
    }
    this.scanned = this.buffer.length;
    return null;
  }
}

function frameData(frame: SseFrame): string | null {
  const data: string[] = [];
  for (const line of frame.lines) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

const renderFrame = (frame: SseFrame): string => `${frame.lines.join("\n")}\n\n`;

const renderData = (frame: SseFrame, data: string): string =>
  `${[
    ...frame.lines.filter((line) => !line.startsWith("data:")),
    ...data.split("\n").map((line) => `data: ${line}`),
  ].join("\n")}\n\n`;

const renderStreamError = (message: string, code = "upstream_error"): string =>
  `event: error\ndata: ${JSON.stringify({ error: { code, message, type: "upstream_error" } })}\n\n`;

const STREAM_ERROR_MESSAGE_LIMIT = 300;
const STREAM_ERROR_CODE = /^[A-Za-z][\w.-]{0,63}$/;

/** What the upstream said went wrong, when it said so: its own short code and its message cut to a sentence or two. */
function upstreamFailure(error: unknown, fallbackMessage: string): { code: string; message: string } {
  const source = isRecord(error) ? error : null;
  const code = source && isString(source.code) && STREAM_ERROR_CODE.test(source.code) ? source.code : "upstream_error";
  const message = source && isString(source.message) && source.message.trim()
    ? source.message.trim().slice(0, STREAM_ERROR_MESSAGE_LIMIT)
    : fallbackMessage;
  return { code, message };
}

/** One line, never any prompt text, header or key. */
function logStreamFailure(requestId: string, reason: string, code: string, event: string): void {
  console.error(`[ai-gateway] stream failed request=${requestId} reason=${reason} code=${code} event=${event}`);
}

function rewriteModel(value: Record<string, unknown>, upstreamModel: string, publicModel: string): boolean {
  if (value.model !== upstreamModel) return false;
  value.model = publicModel;
  return true;
}

const isTerminalEvent = (type: unknown): boolean =>
  type === "response.completed" || type === "response.incomplete" || type === "response.failed";

interface StreamOptions {
  control: UpstreamControl;
  env: Env;
  mode: InferenceMode;
  model: AiModelConfig;
  requestId: string;
  upstream: Response;
  waitUntil: (promise: Promise<unknown>) => void;
  requestSignal: AbortSignal;
}

/** Relays upstream SSE with backpressure while connected. After disconnect,
 * draining continues in the execution context until usage or the drain deadline. */
function forwardStream(options: StreamOptions): Response {
  const { control, env, mode, model, requestId, upstream, waitUntil } = options;
  const reader = upstream.body?.getReader();
  if (!reader) {
    void markReview(env, requestId, "upstream_body_missing");
    control.abort();
    control.dispose();
    return inferenceError(502, "upstream_error", "The upstream response could not be read.");
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sse = new SseReader(AI_SSE_FRAME_LIMIT_BYTES);
  const pending: string[] = [];
  // Chat reports usage in the chunk before [DONE]; responses only in the
  // terminal event itself.
  let chatUsage: UsageCandidate | null = null;
  let finished = false;
  let terminal = false;
  let disconnected = control.disconnected();
  let drainTimer: NodeJS.Timeout | undefined;
  const completion = Promise.withResolvers<void>();
  waitUntil(completion.promise);

  async function shutdown() {
    if (finished) return;
    finished = true;
    clearTimeout(drainTimer);
    options.requestSignal.removeEventListener("abort", disconnect);
    try {
      await reader?.cancel();
    } catch {
      // Already closed.
    }
    control.abort();
    control.dispose();
    completion.resolve();
  }

  async function processFrames(frames: SseFrame[]): Promise<boolean> {
    for (const frame of frames) {
      const data = frameData(frame);
      if (data === null) {
        pending.push(renderFrame(frame));
        continue;
      }
      if (mode === "chat" && data === "[DONE]") {
        if (await settleOutcome(env, requestId, chatUsage, disconnected || control.disconnected() ? "client_disconnected_settled" : null) === null) pending.push(renderFrame(frame));
        else pending.push(renderStreamError("The response could not be settled."));
        return false;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        await markReview(env, requestId, disconnected ? "client_disconnected" : "upstream_stream_malformed");
        pending.push(renderStreamError("The upstream response was malformed."));
        return false;
      }
      if (!isRecord(parsed)) {
        pending.push(renderFrame(frame));
        continue;
      }
      if (parsed.error !== undefined && parsed.error !== null) {
        await markReview(env, requestId, disconnected ? "client_disconnected" : "upstream_stream_error");
        const failure = upstreamFailure(parsed.error, "The upstream request failed.");
        logStreamFailure(requestId, "upstream_stream_error", failure.code, "error-frame");
        pending.push(renderStreamError(failure.message, failure.code));
        return false;
      }

      if (mode === "chat") {
        const candidate = chatUsageCandidate(parsed);
        if (candidate) chatUsage = candidate;
        const changed = rewriteModel(parsed, model.upstreamModel, model.id);
        pending.push(changed ? renderData(frame, JSON.stringify(parsed)) : renderFrame(frame));
        continue;
      }

      const response = isRecord(parsed.response) ? parsed.response : null;
      const changed = response ? rewriteModel(response, model.upstreamModel, model.id) : false;
      if (isTerminalEvent(parsed.type)) {
        const candidate = response ? responsesUsageCandidate(response) : null;
        const unsettled = await settleOutcome(env, requestId, candidate, disconnected || control.disconnected() ? "client_disconnected_settled" : null);
        if (unsettled === null) {
          pending.push(changed ? renderData(frame, JSON.stringify(parsed)) : renderFrame(frame));
        } else if (parsed.type === "response.completed") {
          pending.push(renderStreamError("The response could not be settled."));
        } else {
          const failure = upstreamFailure(response?.error, "The response could not be settled.");
          logStreamFailure(requestId, unsettled, failure.code, String(parsed.type));
          pending.push(renderStreamError(failure.message, failure.code));
        }
        return false;
      }
      pending.push(changed ? renderData(frame, JSON.stringify(parsed)) : renderFrame(frame));
    }
    return true;
  }

  let pumping: Promise<void> | undefined;
  async function pump(controller?: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      if (finished) return;
      if (disconnected) pending.length = 0;
      if (pending.length) {
        if (!controller || (controller.desiredSize ?? 0) <= 0) return;
        controller.enqueue(encoder.encode(pending.shift()!));
        continue;
      }
      if (terminal) {
        await shutdown();
        if (!disconnected) controller?.close();
        return;
      }
      if (!disconnected && (!controller || (controller.desiredSize ?? 0) <= 0)) return;
      try {
        const chunk = await reader!.read();
        if (finished) return;
        let frames: SseFrame[];
        try {
          frames = chunk.done ? sse.flush() : sse.push(decoder.decode(chunk.value, { stream: true }));
        } catch {
          await markReview(env, requestId, disconnected ? "client_disconnected" : "upstream_frame_too_large");
          pending.push(renderStreamError("The upstream response was malformed."));
          terminal = true;
          continue;
        }
        terminal = !(await processFrames(frames));
        if (chunk.done && !terminal) {
          await markReview(env, requestId, disconnected ? "client_disconnected" : "stream_ended_without_terminal_usage");
          pending.push(renderStreamError("The upstream stream ended unexpectedly."));
          terminal = true;
        }
      } catch {
        if (finished) return;
        await markReview(env, requestId, disconnected || control.disconnected() ? "client_disconnected" : control.timedOut() ? "upstream_timeout" : "upstream_stream_error");
        pending.push(renderStreamError("The upstream stream failed."));
        terminal = true;
      }
    }
  }
  function runPump(controller?: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (!pumping) pumping = pump(controller).finally(() => { pumping = undefined; });
    return pumping;
  }
  function disconnect() {
    if (finished || disconnected && drainTimer !== undefined) return;
    disconnected = true;
    drainTimer = setTimeout(() => {
      waitUntil(markReview(env, requestId, "client_disconnected").then(shutdown));
    }, DISCONNECT_DRAIN_MS);
    waitUntil(runPump().then(() => finished ? undefined : runPump()));
  }
  return new Response(new ReadableStream<Uint8Array>({
    start() {
      options.requestSignal.addEventListener("abort", disconnect, { once: true });
      if (disconnected || options.requestSignal.aborted) disconnect();
    },
    cancel() { disconnect(); },
    pull(controller) { return runPump(controller); },
  }), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    status: 200,
  });
}

async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new HTTPError(502, "upstream_error");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HTTPError(502, "upstream_error");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Usage a failed exchange still reported: a chat error body with usage, a
 * responses body, or a responses terminal `response.failed` event. Body read
 * failures propagate so a partial exchange never releases points. */
async function failureUsage(upstream: Response, mode: InferenceMode): Promise<UsageCandidate | null> {
  if (!upstream.body) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readLimitedBody(upstream, AI_JSON_RESPONSE_LIMIT_BYTES),
  );
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const sse = new SseReader(AI_SSE_FRAME_LIMIT_BYTES);
    let frames: SseFrame[];
    try {
      frames = [...sse.push(text), ...sse.flush()];
    } catch {
      return null;
    }
    let found: UsageCandidate | null = null;
    for (const frame of frames) {
      const data = frameData(frame);
      if (data === null || data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (mode === "chat") {
        const candidate = chatUsageCandidate(parsed);
        if (candidate) found = candidate;
        continue;
      }
      if (!isTerminalEvent(parsed.type) || !isRecord(parsed.response)) continue;
      const candidate = responsesUsageCandidate(parsed.response);
      if (candidate) found = candidate;
    }
    return found;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return mode === "chat" ? chatUsageCandidate(parsed) : responsesUsageCandidate(parsed);
  } catch {
    return null;
  }
}

/** A non-streaming completion is settled before any content reaches the
 * client, so an unsettleable response is never delivered as free. */
async function forwardJSON(options: {
  env: Env;
  mode: InferenceMode;
  model: AiModelConfig;
  requestId: string;
  upstream: Response;
  control: UpstreamControl;
}): Promise<Response> {
  const { env, mode, model, requestId, upstream } = options;
  let body: Record<string, unknown>;
  let text: string;
  try {
    const bytes = await readLimitedBody(upstream, AI_JSON_RESPONSE_LIMIT_BYTES);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    await markReview(env, requestId, options.control.disconnected() ? "client_disconnected" : "upstream_body_unreadable");
    return inferenceError(502, "upstream_error", "The upstream response could not be read.");
  }
  if (body.error !== undefined && body.error !== null) {
    const candidate = mode === "chat" ? chatUsageCandidate(body) : responsesUsageCandidate(body);
    if (candidate) await settleOutcome(env, requestId, candidate, options.control.disconnected() ? "client_disconnected_settled" : null);
    else await markReview(env, requestId, "upstream_error_body");
    return inferenceError(502, "upstream_error", "The upstream request failed.");
  }
  const candidate = mode === "chat" ? chatUsageCandidate(body) : responsesUsageCandidate(body);
  if (await settleOutcome(env, requestId, candidate, options.control.disconnected() ? "client_disconnected_settled" : null) !== null) {
    return inferenceError(502, "upstream_error", "The response could not be settled.");
  }
  const relayed = rewriteModel(body, model.upstreamModel, model.id) ? JSON.stringify(body) : text;
  return new Response(relayed, { headers: JSON_HEADERS, status: 200 });
}

async function reserve(options: {
  env: Env;
  mode: InferenceMode;
  prepared: PreparedRequest;
  ownerUserId: string;
  tokenId: string;
}): Promise<string> {
  const { env, mode, prepared, ownerUserId, tokenId } = options;
  const { model } = prepared;
  const result = await reserveRequest(env, {
    endpoint: mode,
    model: model.id,
    ownerUserId,
    pricing: {
      cachedRate: model.cachedInputMicroPointsPerMillion,
      inputRate: model.inputMicroPointsPerMillion,
      maxInputTokens: prepared.inputReserve ?? model.maxContextTokens,
      maxOutputTokens: prepared.outputCap,
      outputRate: model.outputMicroPointsPerMillion,
      pricingVersion: model.pricingVersion,
    },
    tokenId,
    ...(prepared.billing ? { billing: prepared.billing } : {}),
  });
  if (result.ok) return result.id;
  if (result.reason === "insufficient_balance") throw new HTTPError(402, "insufficient_balance");
  if (result.reason === "ai_busy") throw new HTTPError(429, "ai_busy");
  throw new HTTPError(403, "ai_not_enabled");
}

/** One reserved request, one upstream call, one settlement; the URL, key, and
 * headers come from operator configuration only, and a redirect is refused. */
async function dispatch(options: {
  aiConfig: AiConfig;
  env: Env;
  fetcher: typeof fetch;
  mode: InferenceMode;
  prepared: PreparedRequest;
  request: Request;
  requestId: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const { aiConfig, env, fetcher, mode, prepared, request, requestId, waitUntil } = options;
  const route = aiConfig.routes?.get(prepared.model.id);
  const base = aiConfig.routes ? route?.baseURL : aiConfig.upstreamBaseURL;
  const apiKey = aiConfig.routes ? route?.apiKey : aiConfig.upstreamApiKey;
  if (!base || !apiKey) {
    await markReview(env, requestId, "ai_unavailable");
    return inferenceError(503, "ai_unavailable", "The AI service is not available.");
  }
  const control = createUpstreamControl(request.signal);
  // A relayed stream owns the control until it closes.
  let streamOwned = false;

  try {
    const upstream = await fetcher(
      `${base.replace(/\/+$/, "")}${mode === "chat" ? "/chat/completions" : "/responses"}`,
      {
        body: JSON.stringify(prepared.upstream),
        headers: {
          accept: prepared.stream ? "text/event-stream" : "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: control.signal,
      },
    );
    await markRequestStreaming(env, requestId).catch(() => false);

    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
    const encoded = encoding !== "" && encoding !== "identity";
    if (upstream.status < 200 || upstream.status >= 300 || encoded) {
      const candidate = encoded ? null : await failureUsage(upstream, mode);
      await upstream.body?.cancel().catch(() => {});
      if (candidate) await settleUsage(env, requestId, candidate);
      else if (!encoded && UPSTREAM_REFUSAL_STATUSES.has(upstream.status)) {
        // This policy releases end-user points, not any upstream billing obligation.
        const released = await releaseRequest(env, requestId, `upstream_refused_${upstream.status}`);
        if (released) {
          return upstream.status === 429
            ? inferenceError(503, "ai_temporarily_busy", "The AI service is busy. No points were charged.")
            : inferenceError(503, "ai_temporarily_unavailable", "The AI service is temporarily unavailable. No points were charged.");
        }
        await markReview(env, requestId, "upstream_release_failed");
      } else await markReview(env, requestId, encoded ? "upstream_content_encoding" : `upstream_status_${upstream.status}`);
      return inferenceError(502, "upstream_error", "The upstream request failed.");
    }

    if (contentType.includes("text/event-stream")) {
      if (!prepared.stream) {
        // A non-streaming client cannot consume SSE; settle whatever terminal
        // usage the stream carries, then fail the call.
        const candidate = await failureUsage(upstream, mode);
        await upstream.body?.cancel().catch(() => {});
        if (candidate) await settleUsage(env, requestId, candidate);
        else await markReview(env, requestId, "upstream_unexpected_stream");
        return inferenceError(502, "upstream_error", "The upstream returned an unexpected stream.");
      }
      const response = forwardStream({ control, env, mode, model: prepared.model, requestId, upstream, waitUntil, requestSignal: request.signal });
      streamOwned = true;
      return response;
    }
    if (prepared.stream) {
      // A streaming client cannot consume a JSON body; the exchange still
      // consumed tokens, so settle what the body proves and fail the call.
      const candidate = await failureUsage(upstream, mode);
      await upstream.body?.cancel().catch(() => {});
      if (candidate) await settleUsage(env, requestId, candidate);
      else await markReview(env, requestId, "upstream_not_streaming");
      return inferenceError(502, "upstream_error", "The upstream did not stream the response.");
    }
    return await forwardJSON({ env, mode, model: prepared.model, requestId, upstream, control });
  } catch {
    // The request may have reached the upstream: never assume it did not.
    await markReview(env, requestId, control.disconnected() ? "client_disconnected" : control.timedOut() ? "upstream_timeout" : "upstream_unreachable");
    return inferenceError(502, "upstream_error", "The upstream request failed.");
  } finally {
    if (!streamOwned) control.dispose();
  }
}

/** Handles `/v1/ai/*` and returns `null` for any other path. Never throws:
 * every failure is already an inference envelope. */
export async function routeAiGateway(
  request: Request,
  env: Env,
  fetcher: typeof fetch = fetch,
  waitUntil: (promise: Promise<unknown>) => void = promise => { void promise.catch(() => {}); },
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== MODELS_PATH && pathname !== CHAT_PATH && pathname !== RESPONSES_PATH && pathname !== QUOTE_PATH) return null;

  let requestId: string | undefined;
  try {
    const aiConfig = await loadRuntimeAiConfig(env);
    // Authenticate before touching the (potentially 48 MiB) body.
    const admission = await authenticateModelToken(env, request, aiConfig);

    if (pathname === MODELS_PATH) {
      if (request.method !== "GET") throw invalid();
      const catalog = await applyBillingCatalog(env, aiConfig);
      return json({
        data: publicModels(catalog).map((model) => ({
          created: 0,
          id: model.id,
          object: "model",
          owned_by: "hezuo",
        })),
        object: "list",
      });
    }
    if (request.method !== "POST") throw invalid();
    if (pathname === QUOTE_PATH) {
      const body = await readInferenceBody(request);
      if ((body.endpoint !== "chat" && body.endpoint !== "responses") || !isRecord(body.request)
          || Object.keys(body).some((key) => key !== "endpoint" && key !== "request")) throw invalid();
      const prepared = await preparedRequest(env, body.request, aiConfig, body.endpoint);
      const snapshot = prepared.billing;
      if (!snapshot) throw new HTTPError(503, "dynamic_billing_disabled");
      return json({
        selectedModel: prepared.model.id, complexity: snapshot.complexity, score: snapshot.score,
        reasons: snapshot.reasons, estimatedInputTokens: snapshot.estimatedInputTokens,
        estimatedMicroPoints: estimateTaskMicroPoints(snapshot), reservedMicroPoints: snapshot.reservedMicroPoints,
        policyRevision: snapshot.policyRevision, currency: snapshot.currency, pointsPerCurrency: snapshot.pointsPerCurrency,
        rateSnapshot: { inputMicroPointsPerMillion: prepared.model.inputMicroPointsPerMillion,
          cachedInputMicroPointsPerMillion: prepared.model.cachedInputMicroPointsPerMillion,
          outputMicroPointsPerMillion: prepared.model.outputMicroPointsPerMillion },
        noPriceCommitment: true,
      });
    }

    const mode: InferenceMode = pathname === CHAT_PATH ? "chat" : "responses";
    const body = await readInferenceBody(request);
    const prepared = await preparedRequest(env, body, aiConfig, mode);
    if (!aiConfig.ready || (aiConfig.routes ? !aiConfig.routes.has(prepared.model.id) : !aiConfig.upstreamBaseURL || !aiConfig.upstreamApiKey)) {
      throw new HTTPError(503, "ai_unavailable");
    }
    requestId = await reserve({
      env,
      mode,
      ownerUserId: admission.ownerUserId,
      prepared,
      tokenId: admission.tokenId,
    });
    const exchange = dispatch({ aiConfig, env, fetcher, mode, prepared, request, requestId, waitUntil });
    waitUntil(exchange);
    const response = await exchange;
    response.headers.set("x-ai-request-id", requestId);
    response.headers.set("x-ai-model", prepared.model.id);
    response.headers.set("x-ai-pricing-version", prepared.model.pricingVersion);
    return response;
  } catch (error) {
    if (requestId) {
      await markReview(env, requestId, "upstream_unreachable");
      const response = inferenceError(502, "upstream_error", "The upstream request failed.");
      response.headers.set("x-ai-request-id", requestId);
      return response;
    }
    return failure(error);
  }
}
