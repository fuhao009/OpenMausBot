import { authenticateModelToken } from "./account-ai";
import { findModel, publicModels, readAiConfig, type AiConfig, type AiModelConfig } from "./ai-config";
import { markRequestStreaming, reserveRequest, reviewRequest, settleRequest } from "./ai-wallet";
import { HTTPError, JSON_HEADERS, json, readBoundedJSON } from "./http";

/** Screenshots and tool context ride in this body; still bounded. */
export const AI_REQUEST_LIMIT_BYTES = 48 * 1024 * 1024;
/** One SSE event, so a desynchronised stream cannot exhaust memory. */
export const AI_SSE_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
/** A non-streaming completion. */
export const AI_JSON_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
/** One upstream exchange; a tool follow-up is a separate request with its own
 * reservation. */
export const AI_UPSTREAM_TIMEOUT_MS = 300_000;

const MODELS_PATH = "/v1/ai/models";
const CHAT_PATH = "/v1/ai/chat/completions";
const RESPONSES_PATH = "/v1/ai/responses";

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
]);

type InferenceMode = "chat" | "responses";

interface UsageCandidate {
  cached: unknown;
  input: unknown;
  output: unknown;
}

interface PreparedRequest {
  model: AiModelConfig;
  outputCap: number;
  stream: boolean;
  upstream: Record<string, unknown>;
}

interface UpstreamControl {
  abort: () => void;
  dispose: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
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
    return inferenceError(402, "insufficient_balance", "Available points cannot cover another request.");
  }
  if (error.status === 429) {
    return inferenceError(429, "ai_busy", "Too many requests are in flight for this account.");
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
  if (error.status === 503) return inferenceError(503, "ai_unavailable", "The AI service is not available.");
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

function preparedRequest(body: Record<string, unknown>, aiConfig: AiConfig, mode: InferenceMode): PreparedRequest {
  const modelId = body.model;
  if (!isString(modelId) || modelId.length === 0) throw invalid();
  const model = findModel(aiConfig, modelId);
  if (!model || !model.enabled || model.protocol !== mode) throw new HTTPError(403, "model_not_allowed");
  return mode === "chat" ? prepareChat(body, model) : prepareResponses(body, model);
}

/** A completion body may carry token counts either directly or under `usage`. */
function usageSource(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  const nested = isRecord(record.usage) ? record.usage : null;
  if (nested && keys.some((key) => key in nested)) return nested;
  return keys.some((key) => key in record) ? record : null;
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
  if (!candidate) {
    await markReview(env, requestId, "usage_missing");
    return false;
  }
  const { cached, input, output } = candidate;
  if (!isCount(input) || !isCount(output) || (cached !== null && (!isCount(cached) || cached > input))) {
    await markReview(env, requestId, "usage_invalid");
    return false;
  }
  try {
    const result = await settleRequest(env, requestId, {
      cachedInputTokens: cached === null ? null : cached,
      inputTokens: input,
      outputTokens: output,
    });
    return result.status === "settled";
  } catch {
    return false;
  }
}

function createUpstreamControl(requestSignal: AbortSignal): UpstreamControl {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_UPSTREAM_TIMEOUT_MS);
  const onClientAbort = () => controller.abort();
  if (requestSignal.aborted) controller.abort();
  else requestSignal.addEventListener("abort", onClientAbort, { once: true });
  return {
    abort: () => controller.abort(),
    dispose: () => {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", onClientAbort);
    },
    signal: controller.signal,
    timedOut: () => timedOut,
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

const renderStreamError = (message: string): string =>
  `event: error\ndata: ${JSON.stringify({ error: { code: "upstream_error", message, type: "upstream_error" } })}\n\n`;

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
}

/** Relays upstream SSE with backpressure. The wallet settles before the
 * terminal frame is released; a disconnect or a stream without terminal usage
 * is an unknown outcome and stays a reviewable reservation. */
function forwardStream(options: StreamOptions): Response {
  const { control, env, mode, model, requestId, upstream } = options;
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

  async function shutdown() {
    if (finished) return;
    finished = true;
    try {
      await reader?.cancel();
    } catch {
      // Already closed.
    }
    control.abort();
    control.dispose();
  }

  async function processFrames(frames: SseFrame[]): Promise<boolean> {
    for (const frame of frames) {
      const data = frameData(frame);
      if (data === null) {
        pending.push(renderFrame(frame));
        continue;
      }
      if (mode === "chat" && data === "[DONE]") {
        if (await settleUsage(env, requestId, chatUsage)) pending.push(renderFrame(frame));
        else pending.push(renderStreamError("The response could not be settled."));
        return false;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        await markReview(env, requestId, "upstream_stream_malformed");
        pending.push(renderStreamError("The upstream response was malformed."));
        return false;
      }
      if (!isRecord(parsed)) {
        pending.push(renderFrame(frame));
        continue;
      }
      if (parsed.error !== undefined && parsed.error !== null) {
        await markReview(env, requestId, "upstream_stream_error");
        pending.push(renderStreamError("The upstream request failed."));
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
        if (await settleUsage(env, requestId, candidate)) {
          pending.push(changed ? renderData(frame, JSON.stringify(parsed)) : renderFrame(frame));
        } else {
          pending.push(renderStreamError("The response could not be settled."));
        }
        return false;
      }
      pending.push(changed ? renderData(frame, JSON.stringify(parsed)) : renderFrame(frame));
    }
    return true;
  }

  return new Response(new ReadableStream<Uint8Array>({
    async cancel() {
      if (finished) return;
      await markReview(env, requestId, "client_disconnected");
      await shutdown();
    },
    async pull(controller) {
      for (;;) {
        if (finished) return;
        if (pending.length > 0) {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          const text = pending.shift();
          if (text !== undefined) controller.enqueue(encoder.encode(text));
          continue;
        }
        if (terminal) {
          await shutdown();
          controller.close();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;

        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          await markReview(env, requestId, control.timedOut() ? "upstream_timeout" : "upstream_stream_error");
          pending.push(renderStreamError("The upstream stream failed."));
          terminal = true;
          continue;
        }
        if (chunk.done) {
          let frames: SseFrame[];
          try {
            frames = sse.flush();
          } catch {
            await markReview(env, requestId, "upstream_frame_too_large");
            pending.push(renderStreamError("The upstream response was malformed."));
            terminal = true;
            continue;
          }
          if (await processFrames(frames)) {
            // A stream that ends without a terminal usage is unknown: keep the
            // reservation for review, and never fabricate a successful end.
            await markReview(env, requestId, "stream_ended_without_terminal_usage");
            pending.push(renderStreamError("The upstream stream ended unexpectedly."));
          }
          terminal = true;
          continue;
        }
        let frames: SseFrame[];
        try {
          frames = sse.push(decoder.decode(chunk.value, { stream: true }));
        } catch {
          await markReview(env, requestId, "upstream_frame_too_large");
          pending.push(renderStreamError("The upstream response was malformed."));
          terminal = true;
          continue;
        }
        if (!(await processFrames(frames))) terminal = true;
      }
    },
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
 * responses body, or a responses terminal `response.failed` event. Anything
 * else is untrusted and leaves the reservation for review. */
async function failureUsage(upstream: Response, mode: InferenceMode): Promise<UsageCandidate | null> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readLimitedBody(upstream, AI_JSON_RESPONSE_LIMIT_BYTES),
    );
  } catch {
    return null;
  }
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
    await markReview(env, requestId, "upstream_body_unreadable");
    return inferenceError(502, "upstream_error", "The upstream response could not be read.");
  }
  if (body.error !== undefined && body.error !== null) {
    const candidate = mode === "chat" ? chatUsageCandidate(body) : responsesUsageCandidate(body);
    if (candidate) await settleUsage(env, requestId, candidate);
    else await markReview(env, requestId, "upstream_error_body");
    return inferenceError(502, "upstream_error", "The upstream request failed.");
  }
  const candidate = mode === "chat" ? chatUsageCandidate(body) : responsesUsageCandidate(body);
  if (!(await settleUsage(env, requestId, candidate))) {
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
      maxInputTokens: model.maxContextTokens,
      maxOutputTokens: prepared.outputCap,
      outputRate: model.outputMicroPointsPerMillion,
      pricingVersion: model.pricingVersion,
    },
    tokenId,
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
}): Promise<Response> {
  const { aiConfig, env, fetcher, mode, prepared, request, requestId } = options;
  const base = aiConfig.upstreamBaseURL;
  const apiKey = aiConfig.upstreamApiKey;
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
      // A failed exchange that still reported trustworthy usage is settled;
      // anything else keeps the reservation for review.
      if (candidate) await settleUsage(env, requestId, candidate);
      else await markReview(env, requestId, encoded ? "upstream_content_encoding" : `upstream_status_${upstream.status}`);
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
      const response = forwardStream({ control, env, mode, model: prepared.model, requestId, upstream });
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
    return await forwardJSON({ env, mode, model: prepared.model, requestId, upstream });
  } catch {
    // The request may have reached the upstream: never assume it did not.
    await markReview(env, requestId, control.timedOut() ? "upstream_timeout" : "upstream_unreachable");
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
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== MODELS_PATH && pathname !== CHAT_PATH && pathname !== RESPONSES_PATH) return null;

  try {
    const aiConfig = readAiConfig(env);
    // Authenticate before touching the (potentially 48 MiB) body.
    const admission = await authenticateModelToken(env, request, aiConfig);

    if (pathname === MODELS_PATH) {
      if (request.method !== "GET") throw invalid();
      return json({
        data: publicModels(aiConfig).map((model) => ({
          created: 0,
          id: model.id,
          object: "model",
          owned_by: "hezuo",
        })),
        object: "list",
      });
    }
    if (request.method !== "POST") throw invalid();

    const mode: InferenceMode = pathname === CHAT_PATH ? "chat" : "responses";
    const body = await readInferenceBody(request);
    const prepared = preparedRequest(body, aiConfig, mode);
    if (!aiConfig.ready || !aiConfig.upstreamBaseURL || !aiConfig.upstreamApiKey) {
      throw new HTTPError(503, "ai_unavailable");
    }
    const requestId = await reserve({
      env,
      mode,
      ownerUserId: admission.ownerUserId,
      prepared,
      tokenId: admission.tokenId,
    });
    return await dispatch({ aiConfig, env, fetcher, mode, prepared, request, requestId });
  } catch (error) {
    return failure(error);
  }
}
