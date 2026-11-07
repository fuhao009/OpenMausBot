import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProductAccountBridge,
  ProductAccountState,
  ProductLedgerEntry,
  ProductLedgerPage,
} from "../../shared/product-account";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/**
 * The account state this window may show. It carries no account bearer, model
 * token, upstream address or data directory: main keeps those.
 */
export function useProductAccount(): ProductAccountState {
  const [state, setState] = useState<ProductAccountState>({ auth: "signed_out", runtime: "stopped" });
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.ogb?.productAccount;
    if (!bridge) return;
    let active = true;
    let changed = false;
    const unsubscribe = bridge.onState(next => { changed = true; if (active) setState(next); });
    void bridge.state().then(next => { if (active && !changed) setState(next); }).catch(() => {
      if (active && !changed) setState({ auth: "unavailable", runtime: "stopped", errorCode: "account_unavailable" });
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}

/** The bridge itself: undefined in a source build or a page that is not the product's. */
export function useProductAccountBridge(): ProductAccountBridge | undefined {
  const [bridge] = useState(() => (typeof window === "undefined" ? undefined : window.ogb?.productAccount));
  return bridge;
}

/**
 * One point is 1,000,000 micro-points. Integer arithmetic only, and always six
 * decimals, so a tiny real charge never reads as zero and no float rounds a
 * balance the gateway charged. Points are the product's own service credit, so
 * no currency symbol is ever shown.
 */
export function formatPointsMicros(microPoints: number): string {
  if (!Number.isSafeInteger(microPoints) || microPoints < 0) return "0.000000";
  const whole = Math.floor(microPoints / 1_000_000);
  const fraction = microPoints - whole * 1_000_000;
  return `${whole}.${String(fraction).padStart(6, "0")}`;
}

export interface ProductAccountNotice {
  tone: "info" | "success" | "warning" | "error";
  key: LocaleKey;
}

const RUNTIME_ERRORS: Readonly<Record<string, LocaleKey>> = {
  workspace_start_failed: "product.runtimeError",
  workspace_stop_failed: "product.error.signOutBlocked",
  sign_out_blocked: "product.error.signOutBlocked",
  sign_out_required: "product.error.signOutRequired",
  login_locked: "product.error.locked",
  login_unreadable: "product.error.unreadable",
  login_unwritable: "product.error.unreadable",
  login_invalid: "product.error.unreadable",
};

const SERVICE_ERRORS: Readonly<Record<string, true>> = {
  network_unavailable: true,
  control_plane_unavailable: true,
  rate_limited: true,
  internal_error: true,
  request_failed: true,
  invalid_response: true,
  ai_unavailable: true,
  account_unavailable: true,
  state_unavailable: true,
  capability_unavailable: true,
  ai_catalog_invalid: true,
  sign_in_unavailable: true,
  service_unavailable: true,
};

const SIGN_IN_ERRORS: Readonly<Record<string, LocaleKey>> = {
  invalid_email: "product.error.invalidEmail",
  invalid_otp: "product.error.invalidCode",
  invalid_code: "product.error.invalidCode",
  invalid_credentials: "product.error.invalidCredentials",
  invalid_password: "product.error.invalidCredentials",
  email_taken: "product.error.emailTaken",
  email_not_verified: "product.error.emailNotVerified",
  password_too_short: "product.error.passwordTooShort",
  password_too_long: "product.error.passwordTooLong",
  email_unavailable: "product.error.emailUnavailable",
  sign_up_unavailable: "product.error.signUpUnavailable",
  session_expired: "product.error.expired",
};

const AI_NOTICES: Readonly<Record<string, LocaleKey>> = {
  pending: "product.pending",
  ready: "product.ready",
  insufficient_balance: "product.insufficient_balance",
  suspended: "product.suspended",
  unavailable: "product.unavailable",
};

/**
 * The first thing this account state says to its person. Runtime trouble (the
 * local app) and service trouble (the account service) never share a line: one
 * asks for a restart or an unlock, the other for a connection and a refresh.
 */
export function productAccountNotice(state: ProductAccountState): ProductAccountNotice | null {
  const code = state.errorCode;
  if (code && RUNTIME_ERRORS[code]) return { tone: "error", key: RUNTIME_ERRORS[code]! };
  if (code && SIGN_IN_ERRORS[code]) return { tone: "error", key: SIGN_IN_ERRORS[code]! };
  if (state.runtime === "error") return { tone: "error", key: "product.runtimeError" };
  if (state.auth === "unavailable") return { tone: "error", key: "product.serviceUnavailable" };
  if (code && SERVICE_ERRORS[code] === true) return { tone: "error", key: "product.serviceUnavailable" };
  if (state.auth === "signed_in" && state.runtime === "starting") return { tone: "info", key: "product.starting" };
  if (state.auth === "signed_in" && state.runtime === "stopped") return { tone: "info", key: "product.runtimeStopped" };
  if (state.ai && AI_NOTICES[state.ai.state]) {
    const tone = state.ai.state === "ready" ? "success"
      : state.ai.state === "pending" || state.ai.state === "unavailable" ? "info" : "warning";
    return { tone, key: AI_NOTICES[state.ai.state]! };
  }
  if (code) return { tone: "error", key: "product.error" };
  return null;
}

export type ProductLedgerStatus = "idle" | "loading" | "ready" | "error";

export interface ProductLedgerView {
  entries: ProductLedgerEntry[];
  nextCursor: string | null;
  status: ProductLedgerStatus;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * The account's request and adjustment history, newest first, fifty at a
 * time. A page is appended only while it belongs to the same account session:
 * a late answer after sign-out or a switch is dropped.
 */
export function useProductLedger(enabled: boolean): ProductLedgerView {
  const bridge = useProductAccountBridge();
  const [entries, setEntries] = useState<ProductLedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ProductLedgerStatus>("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (cursor: string | undefined, append: boolean) => {
    if (!bridge || !enabled) return;
    const stamp = generation.current;
    if (append) setLoadingMore(true);
    else setStatus("loading");
    try {
      const page: ProductLedgerPage = await bridge.ledger(cursor);
      if (generation.current !== stamp) return;
      setEntries(current => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch {
      // A failed page keeps what was already read and clears the cursor, so "Load more" cannot ask for a page the
      // service just refused; Try again starts from the newest entry.
      if (generation.current === stamp) {
        if (!append) {
          setEntries([]);
          setNextCursor(null);
        }
        setStatus("error");
      }
    } finally {
      if (generation.current === stamp) setLoadingMore(false);
    }
  }, [bridge, enabled]);

  useEffect(() => {
    generation.current += 1;
    if (!enabled || !bridge) {
      setEntries([]);
      setNextCursor(null);
      setStatus("idle");
      setLoadingMore(false);
      return;
    }
    void load(undefined, false);
    return () => { generation.current += 1; };
  }, [bridge, enabled, load]);

  return {
    entries,
    nextCursor,
    status,
    loadingMore,
    loadMore: () => { if (nextCursor && status === "ready") void load(nextCursor, true); },
    reload: () => { void load(undefined, false); },
  };
}

export interface ProductLedgerLine {
  id: string;
  title: string;
  amount: string | null;
  detail: string | null;
  state: { label: string; review: boolean } | null;
  createdAt: number;
  at: string;
}

const KIND_KEYS: Readonly<Record<ProductLedgerEntry["kind"], LocaleKey>> = {
  request: "product.kind.request",
  grant: "product.kind.grant",
  enable: "product.kind.enable",
  disable: "product.kind.disable",
  settle: "product.kind.settle",
};

const STATE_KEYS: Readonly<Record<NonNullable<ProductLedgerEntry["state"]>, LocaleKey>> = {
  reserved: "product.state.reserved",
  streaming: "product.state.streaming",
  review: "product.state.review",
  settled: "product.state.settled",
};

export function formatProductLedgerTime(createdAt: number, locale = "en"): string {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt));
}

/** What one ledger entry says, from the fields the account service published. */
export function productLedgerLine(entry: ProductLedgerEntry, locale = "en"): ProductLedgerLine {
  const title = t(KIND_KEYS[entry.kind]);
  let amount: string | null = null;
  if (entry.kind === "grant" || entry.kind === "settle") {
    if (entry.amountMicroPoints !== undefined) amount = t("product.grantedAmount", { amount: formatPointsMicros(entry.amountMicroPoints) });
    else if (entry.chargedMicroPoints !== undefined) amount = t("product.charged", { amount: formatPointsMicros(entry.chargedMicroPoints) });
  } else if (entry.kind === "request") {
    if (entry.chargedMicroPoints !== undefined) amount = t("product.charged", { amount: formatPointsMicros(entry.chargedMicroPoints) });
    else if (entry.reservedMicroPoints !== undefined) amount = t("product.reservedAmount", { amount: formatPointsMicros(entry.reservedMicroPoints) });
  }
  const detail: string[] = [];
  if (entry.inputTokens !== undefined || entry.cachedInputTokens !== undefined || entry.outputTokens !== undefined) {
    detail.push(t("product.tokens", {
      input: String(entry.inputTokens ?? 0),
      cached: String(entry.cachedInputTokens ?? 0),
      output: String(entry.outputTokens ?? 0),
    }));
  }
  const stateKey = entry.state ? STATE_KEYS[entry.state] : undefined;
  return {
    id: entry.id,
    title,
    amount,
    detail: detail.length ? detail.join(" · ") : null,
    state: stateKey ? { label: t(stateKey), review: entry.state === "review" } : null,
    createdAt: entry.createdAt,
    at: formatProductLedgerTime(entry.createdAt, locale),
  };
}
