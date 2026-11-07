// The managed product's helper models: decisions and extraction run on the account's own model through the registered
// `product-ai` provider, never through a helper module's own fetch, URL or credential. The parent installs one callback
// whose generateText is the provider registry's one-off text call with the account's default model already chosen; this
// file only turns a seam into a prompt and reads the model's JSON answer with the same parsers the OpenRouter backends
// use. When product mode is on but no callback is installed, helpers are simply not ready: never a local key, the
// included relay or a free fallback, because in product mode the person has no local key to fall back to.
import type { DeciderBackend, DeciderFailure } from "./types.ts";
import { parseJevResponse } from "./jev.ts";
import { openrouterDeciderPrompt } from "./openrouter.ts";
import { parseExtractValues } from "../extractor/contract.ts";
import { extractorHelperPrompt } from "../extractor/remote.ts";
import type { ExtractBackendRequest, ExtractBackendResult } from "../extractor/types.ts";

/** One billed one-off text call on the account's managed model. The parent's closure names the model and reads the
 * account's per-request credential, so this module never sees either; it rejects when the account may not make a new
 * model call. */
export interface ProductHelper {
  generateText(prompt: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<string>;
}

let productMode = false;
let installed: ProductHelper | null = null;

/** A helper is a small side call; the seam's own timeout aborts it sooner when it has less. */
const PRODUCT_HELPER_TIMEOUT_MS = 15_000;

/** Product mode is a deployment fact, set once: helpers then have no local fallback, whether or not a callback exists. */
export function setProductHelperMode(on: boolean): void {
  productMode = on;
}

/** Installed on account sign-in and capability changes, cleared on sign-out; null means "waiting for the account". */
export function setProductHelperState(helper: ProductHelper | null): void {
  installed = helper;
}

export function productHelperMode(): boolean {
  return productMode;
}

export function productHelper(): ProductHelper | null {
  return productMode ? installed : null;
}

/** The JSON object a model answered with, with a ```json fence removed; undefined when it is not JSON. */
function jsonAnswer(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** A helper's refusal in the vocabulary the seams already use. Message text only: no key, URL or vendor body is kept. */
export function productHelperFailure(error: unknown): DeciderFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient[_ ]balance|available balance|\b402\b/i.test(message)) return "no_balance";
  if (/ai_busy|\b429\b|rate.?limit/i.test(message)) return "rate_limited";
  // The provider's own "no model is loaded right now" (the parent's closure) reads as not reachable, not as a busy model.
  if (/ai_unavailable/i.test(message)) return "unreachable";
  if (/\b503\b|overloaded/i.test(message)) return "overloaded";
  if (/ai_token_invalid|\b40[13]\b|not enabled|suspended|refused this (?:key|token)/i.test(message)) return "rejected";
  if (/expired|not available|no longer|sign in|account/i.test(message)) return "no_key";
  if (/timed? out|timeout|abort/i.test(message)) return "timeout";
  return "unreachable";
}

/** A decision on the account's model, through the same prompt and parser as the OpenRouter chat backend. */
export const productDeciderBackend: DeciderBackend = {
  id: "product",
  async decide(request) {
    const helper = productHelper();
    if (!helper) return { ok: false, reason: "no_key" };
    let text: string;
    try {
      text = await helper.generateText(openrouterDeciderPrompt(request.state, request.questions), { signal: request.signal, timeoutMs: PRODUCT_HELPER_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, reason: productHelperFailure(error) };
    }
    const parsed = parseJevResponse(jsonAnswer(text), request.questions);
    return parsed.ok ? parsed : { ok: false, reason: "malformed" };
  },
};

/** One extraction on the account's model. The one-off text call carries no images, so a request with one is refused
 * rather than answered from the text alone. */
export async function extractWithProductHelper(request: ExtractBackendRequest): Promise<ExtractBackendResult> {
  const helper = productHelper();
  if (!helper) return { ok: false, reason: "no_key" };
  if (request.input.images?.length) return { ok: false, reason: "misconfigured" };
  let text: string;
  try {
    text = await helper.generateText(extractorHelperPrompt({ fields: request.fields, input: request.input, referenceDate: request.referenceDate }), {
      signal: request.signal,
      timeoutMs: PRODUCT_HELPER_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, reason: productHelperFailure(error) };
  }
  const body = jsonAnswer(text);
  const values = body && typeof body === "object" && !Array.isArray(body)
    ? parseExtractValues((body as Record<string, unknown>).values, request.fields)
    : null;
  return values ? { ok: true, values } : { ok: false, reason: "malformed" };
}
