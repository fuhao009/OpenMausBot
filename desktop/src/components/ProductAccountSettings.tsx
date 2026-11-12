import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { formatPointsMicros, productAccountNotice, productLedgerLine, useProductAccount, useProductLedger } from "@/lib/use-product-account";
import { Card, SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import type { ProductOperatorStatus, ProductMaximumGrantResult } from "../../../packages/shared/product-account";

export function ProductAccountSettings() {
  const state = useProductAccount();
  const signedIn = state.auth === "signed_in";
  const ledger = useProductLedger(signedIn);
  const notice = productAccountNotice(state);
  const lines = useMemo(() => ledger.entries.map(entry => productLedgerLine(entry, activeLocale())), [ledger.entries]);
  const ai = state.ai;

  return (
    <div data-product-account className="flex flex-col gap-4">
      <Card title={t("product.accountSection")} subtitle={t("product.usageNote")}>
        <div className="flex flex-col gap-3">
          <p data-product-account-email className="text-[14px] font-medium text-ink">{state.user?.email ?? "—"}</p>
          {notice && (
            <p data-product-account-notice={notice.tone} role={notice.tone === "error" ? "alert" : "status"}
              className="text-[13px] leading-[18px] text-ink-secondary">
              {t(notice.key)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ui-button" disabled={!window.ogb?.productAccount}
              onClick={() => { void window.ogb?.productAccount?.refresh().finally(ledger.reload); }}>
              <RefreshCw size={14} aria-hidden="true" className="mr-1.5 inline align-[-2px]" />
              {t("product.refresh")}
            </button>
            <button type="button" className="ui-button" disabled={!window.ogb?.productAccount}
              onClick={() => { void window.ogb?.productAccount?.signOut(); }}>
              {t("product.signOut")}
            </button>
          </div>
        </div>
      </Card>

      {signedIn && (
        <SettingsGroup label={t("product.balance")}>
          <SettingsRows>
            <SettingRow title={t("product.balance")} subtitle={t("product.balanceReserved")}>
              <div className="flex flex-col items-end gap-0.5 tabular-nums text-ink">
                <span data-product-balance className="text-[22px] font-semibold tracking-tight">{ai ? formatPointsMicros(ai.availableMicroPoints) : "—"}</span>
                <span data-product-reserved className="text-[12px] text-ink-secondary">{ai ? formatPointsMicros(ai.reservedMicroPoints) : "—"}</span>
              </div>
            </SettingRow>
          </SettingsRows>
        </SettingsGroup>
      )}

      {signedIn && state.user && (
        <CurrentAccountOperator key={state.user.email} email={state.user.email} onRefresh={ledger.reload} />
      )}

      {signedIn && (
        <SettingsGroup label={t("product.ledger")} footnote={t("product.ledger.note")}>
          <div data-product-ledger className="rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu">
            {ledger.status === "loading" && ledger.entries.length === 0 && (
              <p role="status" className="px-4 py-3 text-[13px] text-ink-secondary">{t("product.ledger.loading")}</p>
            )}
            {ledger.status === "error" && (
              <p role="alert" className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-ink-secondary">
                <span>{t("product.ledger.error")}</span>
                <button type="button" className="ui-button" onClick={ledger.reload}>{t("product.ledger.retry")}</button>
              </p>
            )}
            {ledger.status !== "error" && ledger.entries.length === 0 && ledger.status === "ready" && (
              <p className="px-4 py-3 text-[13px] text-ink-secondary">{t("product.ledger.empty")}</p>
            )}
            {lines.length > 0 && (
              <ul className="flex flex-col">
                {lines.map(line => (
                  <li key={line.id} data-product-ledger-entry={line.id} data-product-ledger-review={line.state?.review || undefined}
                    className="flex flex-col gap-0.5 border-b border-hairline/30 px-4 py-2.5 last:border-b-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[13px] text-ink">{line.title}</span>
                      {line.amount && <span className="shrink-0 tabular-nums text-[13px] text-ink">{line.amount}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-4 text-ink-secondary">
                      {line.detail && <span className="min-w-0 truncate">{line.detail}</span>}
                      {line.state && <span data-product-ledger-state={line.state.review ? "review" : undefined}>{line.state.label}</span>}
                      {line.at && <time dateTime={new Date(line.createdAt).toISOString()}>{line.at}</time>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {ledger.nextCursor && (
              <div className="px-4 py-2">
                <button type="button" className="ui-button" disabled={ledger.loadingMore} onClick={ledger.loadMore}>
                  {t("product.ledger.more")}
                </button>
              </div>
            )}
          </div>
        </SettingsGroup>
      )}
    </div>
  );
}

function CurrentAccountOperator({ email, onRefresh }: { email: string; onRefresh: () => void }) {
  const bridge = window.ogb?.productAccount;
  const [status, setStatus] = useState<ProductOperatorStatus>();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ProductMaximumGrantResult>();
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    void bridge?.operatorStatus().then(next => { if (active) setStatus(next); }).catch(() => {
      // Eligibility is never inferred from local account data or an unsuccessful lookup.
      if (active) setStatus(undefined);
    });
    return () => { active = false; };
  }, [bridge]);

  async function grant() {
    if (!bridge || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const next = await bridge.grantMaximum();
      setResult(next);
      if (next.outcome === "failed") setError(next.errorCode ?? "request_failed");
      setConfirming(false);
      onRefresh();
      try {
        setStatus(await bridge.operatorStatus());
      } catch {
        setError(current => current ?? "capability_unavailable");
      }
    } catch {
      // A rejected IPC response does not prove that the server rejected the mutation.
      setError("request_failed");
      setConfirming(false);
      onRefresh();
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (!status?.eligible) return null;
  const amount = status.maxGrantMicroPoints;
  const validAmount = amount !== undefined && Number.isSafeInteger(amount) && amount >= 0;
  const granted = result?.outcome === "granted";
  const refreshed = result?.state.ai;
  return (
    <Card title={t("product.operator.title")} subtitle={t("product.operator.note")}>
      <div data-product-operator className="flex flex-col gap-3 text-[13px] leading-[18px]">
        {validAmount && <p data-product-operator-amount className="tabular-nums text-ink">{t("product.operator.amount", { amount: formatPointsMicros(amount) })}</p>}
        {confirming && validAmount && (
          <p data-product-operator-confirmation className="text-ink-secondary">
            {t("product.operator.confirmNote", { amount: formatPointsMicros(amount), email })}
          </p>
        )}
        {pending && <p data-product-operator-pending role="status">{t("product.operator.pending")}</p>}
        {granted && refreshed && !result.state.errorCode && (
          <p data-product-operator-result role="status" className="tabular-nums">{t("product.operator.success", {
            amount: formatPointsMicros(result.amountMicroPoints),
            available: formatPointsMicros(refreshed.availableMicroPoints),
            reserved: formatPointsMicros(refreshed.reservedMicroPoints),
          })}</p>
        )}
        {granted && (!refreshed || result.state.errorCode) && (
          <p data-product-operator-result role="alert">
            {t("product.operator.granted", { amount: formatPointsMicros(result.amountMicroPoints) })} {t("product.operator.refreshError")}
          </p>
        )}
        {(result?.outcome === "already_max" || amount === 0) && <p role="status">{t("product.operator.limitReached")}</p>}
        {error && <p data-product-operator-error role="alert">{t("product.operator.error", { code: error })}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <button data-product-operator-confirm type="button" className="ui-button" disabled={pending || !validAmount || amount === 0} onClick={() => { void grant(); }}>
                {t("product.operator.confirm")}
              </button>
              <button type="button" className="ui-button" disabled={pending} onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
            </>
          ) : (
            <button data-product-operator-open type="button" className="ui-button" disabled={pending || !validAmount || amount === 0} onClick={() => setConfirming(true)}>
              {t("product.operator.open")}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
