import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { requestTooLargeModel } from "../../../packages/shared/request-too-large";
import { PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE } from "../../../packages/shared/product-account";

const UNREACHABLE = /^(?:TypeError:\s*)?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/i;
const TIMED_OUT = /^(?:TimeoutError:\s*)?(?:The operation was aborted due to timeout|signal timed out|The operation timed out\.?)$/i;

const TECHNICAL: RegExp[] = [
  UNREACHABLE,
  TIMED_OUT,
  /^\d{3}(?: [A-Za-z][\w '-]*)?$/,
  /[{[]\s*"[\w$-]+"\s*:/,
  /\n\s+at \S/,
  /^[A-Z][a-z]+Error: /,
  /\b(?:E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|ACCES|PERM|NOENT|ADDRINUSE|HOSTUNREACH|NETUNREACH)|ERR_[A-Z_]{3,})\b/,
  /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b/i,
  /Unexpected token .* in JSON|is not valid JSON|Unexpected end of JSON input/,
  /^\S+(?: \S+){0,2} exited (?:with code )?(?:-?\d+|null|SIG[A-Z0-9]+)\b/,
  /^[a-z]+(?:_[a-z0-9]+)+$/,
];

const KINDS: Array<[RegExp, LocaleKey]> = [
  [UNREACHABLE, "error.plain.unreachable"],
  [/\b429\b|rate.?limit|too many requests/i, "error.plain.rateLimited"],
  [/overloaded|\b529\b|\b503\b|capacity|service unavailable/i, "error.plain.busy"],
  [/ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|connection (?:reset|refused)/i, "error.plain.connection"],
  [/timeout|timed out|ETIMEDOUT/i, "error.plain.timeout"],
  [/\b(?:EACCES|EPERM)\b/, "error.plain.permission"],
  [/\b40[13]\b|unauthori[sz]ed|forbidden/i, "error.plain.access"],
  [/\b404\b|not found|ENOENT/i, "error.plain.notFound"],
  [/\b413\b|too large/i, "error.plain.tooLarge"],
  [/\b5\d\d\b|internal server error|bad gateway/i, "error.plain.server"],
];

const PRODUCT_GATEWAY_LINES: Array<[RegExp, LocaleKey]> = [
  [/\b(?:ai_busy|ai_temporarily_busy)\b/, "product.error.ai.busy"],
  [/\b(?:ai_temporarily_unavailable|ai_unavailable)\b/, "product.error.ai.unavailable"],
  [/\bupstream_error\b|Stream ended before completion|streaming completion error/i, "product.error.ai.incomplete"],
  [/\binsufficient_balance\b/, "product.error.ai.noBalance"],
  [/\b(?:ai_not_enabled|ai_suspended)\b/, "product.error.ai.notEnabled"],
  [/\bai_token_invalid\b/, "product.error.ai.signIn"],
];

/** The line a product account reads for a gateway refusal named in a turn's error text; undefined for anything else. */
export function productGatewayLine(raw: string): string | undefined {
  const key = PRODUCT_GATEWAY_LINES.find(([pattern]) => pattern.test(raw))?.[1];
  return key ? t(key) : undefined;
}

export function isTechnicalError(raw: string): boolean {
  const text = raw.trim();
  return Boolean(text) && TECHNICAL.some((pattern) => pattern.test(text));
}

const STATUS_PREFIX = /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b[\s:.-]*/i;

const REASON_PHRASE = /^(?:[A-Z][a-z]+ ?){1,4}\.?$/;

export function plainErrorLine(raw: string): string | undefined {
  const balance = /product_insufficient_balance:(\d+)/.exec(raw);
  if (balance || raw.trim() === PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE || /\b402\b.*insufficient_balance/.test(raw)) return t("product.billing.insufficient", { n: Number(balance?.[1] ?? 0) / 1_000_000 });
  if (raw.includes("product_ai_session_expired")) return t("product.billing.expired");
  const tooLargeFor = requestTooLargeModel(raw);
  if (tooLargeFor) return t("chat.error.requestTooLarge", { model: tooLargeFor });
  if (!isTechnicalError(raw)) return undefined;
  const text = raw.trim();
  const rest = text.replace(STATUS_PREFIX, "").trim();
  if (rest !== text && /[A-Za-z]+\s+[A-Za-z]+/.test(rest) && !REASON_PHRASE.test(rest) && !isTechnicalError(rest)) return rest;
  const key = KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? "error.plain.generic";
  return t(key);
}
