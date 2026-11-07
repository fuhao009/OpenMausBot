import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { formatPointsMicros, productAccountNotice, productLedgerLine, useProductAccount, useProductLedger } from "@/lib/use-product-account";
import { Card, SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

const MODEL_PRICE = (model: { inputMicroPointsPerMillion: number; cachedInputMicroPointsPerMillion: number; outputMicroPointsPerMillion: number }) =>
  t("product.modelPrices", {
    input: formatPointsMicros(model.inputMicroPointsPerMillion),
    cached: formatPointsMicros(model.cachedInputMicroPointsPerMillion),
    output: formatPointsMicros(model.outputMicroPointsPerMillion),
  });

const tokens = (value: number) => new Intl.NumberFormat(activeLocale()).format(value);

/**
 * The account page: the verified email, the point balance the gateway holds, the
 * models it offers and their prices, and the request history with anything
 * awaiting review. There is no purchase, top-up or personal-key action here:
 * an account is opened and funded by its administrator.
 */
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
              <div className="flex flex-col items-end gap-0.5 text-[14px] tabular-nums text-ink">
                <span data-product-balance>{formatPointsMicros(ai?.availableMicroPoints ?? 0)}</span>
                <span data-product-reserved className="text-[12px] text-ink-secondary">{formatPointsMicros(ai?.reservedMicroPoints ?? 0)}</span>
              </div>
            </SettingRow>
          </SettingsRows>
        </SettingsGroup>
      )}

      {ai && ai.models.length > 0 && (
        <SettingsGroup label={t("product.models")}>
          <SettingsRows>
            {ai.models.map(model => (
              <SettingRow key={model.id} title={model.label} subtitle={MODEL_PRICE(model)}>
                <div className="flex flex-col items-end gap-0.5 text-right text-[12px] leading-4 text-ink-secondary">
                  <span>{t("product.modelLimits", { context: tokens(model.maxContextTokens), output: tokens(model.maxOutputTokens) })}</span>
                  {model.id === ai.defaultModel && <span className="text-ink-secondary">{t("product.modelManaged")}</span>}
                </div>
              </SettingRow>
            ))}
          </SettingsRows>
        </SettingsGroup>
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
