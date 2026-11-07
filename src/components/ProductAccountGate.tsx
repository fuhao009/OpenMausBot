import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { ProductAccountState } from "../../shared/product-account";
import { formatPointsMicros, productAccountNotice, useProductAccount } from "@/lib/use-product-account";

const CODE = /^[0-9]{8}$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = "password" | "sign-up" | "confirm" | "reset-request" | "reset" | "code";

/**
 * The account window. Signing in is the only way into a managed product: no
 * engine list, model address or key is offered, and nothing here can change an
 * account's AI permission or balance, which its administrator holds.
 *
 * A password is typed into this page and passed straight through main to the
 * Worker: it is never stored by the page, echoed back, or shown again. The
 * emailed-code form stays for deployments that configured mail, and is the
 * only way to confirm an address when verification is required.
 */
export function ProductAccountGate() {
  const state = useProductAccount();
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.productAccount;
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const notice = productAccountNotice(state);

  const methods = state.authMethods;
  const emailCodeAvailable = methods?.emailCode.enabled === true;
  const minLength = methods?.password.minLength ?? MIN_PASSWORD;
  const maxLength = methods?.password.maxLength ?? MAX_PASSWORD;

  // The service names the address awaiting a code. The form adopts it (so a
  // reset or sign-up needs no second typing) and never keeps a second source of
  // truth for which address it is.
  useEffect(() => {
    if (state.pendingEmail) setEmail(state.pendingEmail);
  }, [state.pendingEmail]);

  const methodsRead = useRef(false);
  useEffect(() => {
    // One read per mount: the ways in do not change while this window is open.
    if (!bridge || methodsRead.current) return;
    methodsRead.current = true;
    void bridge.methods().catch(() => {});
  }, [bridge]);

  const passwordProblem = password.length > 0 && password.length < minLength
    ? t("product.passwordTooShort", { min: minLength })
    : password.length > maxLength ? t("product.passwordTooLong", { max: maxLength }) : null;
  const passwordReady = password.length >= minLength && password.length <= maxLength;

  async function run(work: () => Promise<void>) {
    if (!bridge || busy) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      await work();
    } catch {
      setFailure(t("product.error"));
    } finally {
      setBusy(false);
    }
  }

  const keepOrExplain = (next: ProductAccountState) => {
    if (next.auth === "signed_in" || next.auth === "signing_in") {
      setFailure(null);
      return;
    }
    const reason = productAccountNotice(next);
    setFailure(t(reason?.key ?? "product.error"));
  };

  const signInWithPassword = () => run(async () => {
    if (!bridge) return;
    const next = await bridge.signInWithPassword(email, password);
    keepOrExplain(next);
    if (next.auth === "signed_in" || next.auth === "signing_in") setPassword("");
  });

  const createAccount = () => run(async () => {
    if (!bridge) return;
    if (password !== confirm) {
      setFailure(t("product.passwordMismatch"));
      return;
    }
    const next = await bridge.signUp(email, password);
    if (next.auth === "signed_in" || next.auth === "signing_in") {
      setFailure(null);
      setPassword(""); setConfirm("");
      return;
    }
    if (next.pendingEmail) {
      setEmail(next.pendingEmail);
      setStep("confirm");
      setNote(t("product.verifySent", { email: next.pendingEmail }));
      return;
    }
    keepOrExplain(next);
  });

  const confirmAddress = () => run(async () => {
    if (!bridge) return;
    const next = await bridge.confirmEmail(email, code, password);
    if (next.auth === "signed_in" || next.auth === "signing_in") {
      setFailure(null);
      setPassword(""); setConfirm(""); setCode("");
      return;
    }
    keepOrExplain(next);
  });

  const requestReset = () => run(async () => {
    if (!bridge) return;
    const next = await bridge.requestPasswordReset(email);
    if (next.errorCode) {
      keepOrExplain(next);
      return;
    }
    setStep("reset");
    setNote(t("product.resetSent", { email }));
  });

  const resetPassword = () => run(async () => {
    if (!bridge) return;
    if (password !== confirm) {
      setFailure(t("product.passwordMismatch"));
      return;
    }
    const next = await bridge.resetPassword(email, code, password);
    if (next.errorCode) {
      keepOrExplain(next);
      return;
    }
    setPassword(""); setConfirm(""); setCode("");
    setStep("password");
    setNote(t("product.resetDone"));
  });

  const sendCode = () => run(async () => {
    if (!bridge) return;
    const next = await bridge.requestCode(email);
    // A refusal keeps the form: there is no code to type when the address was refused or the service is gone.
    if (next.errorCode || next.auth === "unavailable") {
      keepOrExplain(next);
    } else {
      setStep("code");
      setCodeSent(true);
    }
  });

  const verifyCode = () => run(async () => {
    if (!bridge) return;
    const next = await bridge.verifyCode(email, code);
    keepOrExplain(next);
    if (next.auth === "signed_in" || next.auth === "signing_in") setCode("");
  });

  if (!bridge) {
    return (
      <main data-product-account-window="unavailable" className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-3 bg-menu px-6 py-10 text-[13px] text-ink">
        <h1 className="text-[22px] font-semibold leading-7">{t("product.signIn")}</h1>
        <p role="alert" className="text-[14px] leading-relaxed text-ink-secondary">{t("product.windowUnavailable")}</p>
      </main>
    );
  }

  if (state.auth === "signed_in") {
    const ai = state.ai;
    return (
      <main data-product-account-window="signed-in" data-product-runtime={state.runtime} data-product-ai={ai?.state}
        className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-5 bg-menu px-6 py-10 text-[13px] text-ink">
        <h1 className="text-[22px] font-semibold leading-7">{t("product.accountSection")}</h1>
        <p data-product-account-email className="text-[14px] font-medium text-ink">{state.user?.email}</p>
        {ai && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[14px]">
            <dt className="text-ink-secondary">{t("product.balance")}</dt>
            <dd data-product-balance className="tabular-nums text-ink">{formatPointsMicros(ai.availableMicroPoints)}</dd>
            <dt className="text-ink-secondary">{t("product.balanceReserved")}</dt>
            <dd data-product-reserved className="tabular-nums text-ink-secondary">{formatPointsMicros(ai.reservedMicroPoints)}</dd>
          </dl>
        )}
        {state.runtime === "starting" && (
          <p role="status" className="flex items-center gap-2 text-[14px] text-ink-secondary">
            <Loader2 size={15} aria-hidden="true" className="animate-spin" />
            {t("product.starting")}
          </p>
        )}
        {notice && notice.key !== "product.starting" && (
          <p data-product-notice={notice.tone} role={notice.tone === "error" ? "alert" : "status"} className="text-[14px] leading-relaxed text-ink-secondary">
            {t(notice.key)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-button" disabled={busy} onClick={() => { setBusy(true); void bridge.refresh().catch(() => {}).finally(() => setBusy(false)); }}>
            {busy ? t("common.checking") : t("product.refresh")}
          </button>
          <button type="button" className="ui-button" disabled={busy} onClick={() => { setBusy(true); void bridge.signOut().catch(() => {}).finally(() => setBusy(false)); }}>
            {t("product.signOut")}
          </button>
        </div>
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("product.permissions")}</p>
      </main>
    );
  }

  const field = "h-10 rounded-lg border border-hairline/40 bg-raised/50 px-3 text-[13px] font-normal text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/60";
  const label = "flex flex-col gap-1.5 text-[13px] font-medium text-ink";

  const emailField = (disabled: boolean) => (
    <label className={label}>
      {t("product.email")}
      <input type="email" autoComplete="email" required value={email} disabled={disabled}
        onChange={(event) => setEmail(event.target.value)} className={field} />
    </label>
  );
  const passwordField = (autoComplete: "current-password" | "new-password", hint = false) => (
    <label className={label}>
      {t("product.password")}
      <input type="password" autoComplete={autoComplete} required value={password} disabled={busy}
        minLength={autoComplete === "new-password" ? minLength : undefined}
        maxLength={maxLength}
        aria-describedby={hint ? "product-password-hint" : undefined}
        onChange={(event) => setPassword(event.target.value)} className={field} />
      {hint && (
        <span id="product-password-hint" className="text-[12px] font-normal leading-4 text-ink-secondary">
          {t("product.passwordHint", { min: minLength, max: maxLength })}
        </span>
      )}
    </label>
  );
  const confirmField = () => (
    <label className={label}>
      {t("product.passwordConfirm")}
      <input type="password" autoComplete="new-password" required value={confirm} disabled={busy}
        minLength={minLength} maxLength={maxLength}
        onChange={(event) => setConfirm(event.target.value)} className={field} />
    </label>
  );
  const codeField = () => (
    <label className={label}>
      {t("product.code")}
      <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required
        value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
        className={`${field} tracking-[0.3em]`} />
    </label>
  );

  return (
    <main data-product-account-window="sign-in" data-product-auth={state.auth} data-product-step={step}
      className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-5 bg-menu px-6 py-10 text-[13px] text-ink [&_.ui-button]:min-h-9 [&_.ui-button]:rounded-full [&_.ui-button-primary]:bg-ink [&_.ui-button-primary]:text-menu">
      <h1 className="text-[22px] font-semibold leading-7">{t("product.signIn")}</h1>

      {step === "password" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void signInWithPassword(); }}>
          {emailField(busy)}
          {passwordField("current-password")}
          <button type="submit" className="ui-button ui-button-primary" disabled={busy || !EMAIL.test(email) || password.length === 0}>
            {busy ? t("product.working") : t("product.signInAction")}
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-button" disabled={busy} onClick={() => { setStep("sign-up"); setFailure(null); setNote(null); }}>
              {t("product.createAccount")}
            </button>
            <button type="button" className="ui-button" disabled={busy} onClick={() => { setStep("reset-request"); setFailure(null); setNote(null); }}>
              {t("product.forgotPassword")}
            </button>
            {emailCodeAvailable && (
              <button type="button" className="ui-button" disabled={busy}
                onClick={() => { setStep("code"); setCode(""); setCodeSent(false); setFailure(null); setNote(null); }}>
                {t("product.useEmailCode")}
              </button>
            )}
          </div>
        </form>
      )}

      {step === "sign-up" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void createAccount(); }}>
          {emailField(busy)}
          {passwordField("new-password", true)}
          {confirmField()}
          {passwordProblem && <p role="alert" className="text-[12px] leading-4 text-ink-secondary">{passwordProblem}</p>}
          {methods?.emailVerification === "required" && (
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("product.verifyNeeded")}</p>
          )}
          <button type="submit" className="ui-button ui-button-primary"
            disabled={busy || !EMAIL.test(email) || !passwordReady || confirm.length === 0}>
            {busy ? t("product.working") : t("product.createAccount")}
          </button>
          <button type="button" className="ui-button" disabled={busy}
            onClick={() => { setStep("password"); setPassword(""); setConfirm(""); setFailure(null); }}>
            {t("product.backToSignIn")}
          </button>
        </form>
      )}

      {step === "confirm" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void confirmAddress(); }}>
          <p className="text-[14px] leading-relaxed text-ink">{t("product.confirmAddress", { email })}</p>
          {codeField()}
          {passwordField("current-password")}
          <button type="submit" className="ui-button ui-button-primary" disabled={busy || !CODE.test(code) || password.length === 0}>
            {busy ? t("product.working") : t("product.confirmAction")}
          </button>
          <button type="button" className="ui-button" disabled={busy}
            onClick={() => { setStep("password"); setCode(""); setPassword(""); setFailure(null); setNote(null); }}>
            {t("product.backToSignIn")}
          </button>
        </form>
      )}

      {step === "reset-request" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void requestReset(); }}>
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("product.resetHint")}</p>
          {emailField(busy)}
          <button type="submit" className="ui-button ui-button-primary" disabled={busy || !EMAIL.test(email)}>
            {busy ? t("product.working") : t("product.sendCode")}
          </button>
          <button type="button" className="ui-button" disabled={busy}
            onClick={() => { setStep("password"); setFailure(null); setNote(null); }}>
            {t("product.backToSignIn")}
          </button>
        </form>
      )}

      {step === "reset" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void resetPassword(); }}>
          {codeField()}
          {passwordField("new-password", true)}
          {confirmField()}
          {passwordProblem && <p role="alert" className="text-[12px] leading-4 text-ink-secondary">{passwordProblem}</p>}
          <button type="submit" className="ui-button ui-button-primary" disabled={busy || !CODE.test(code) || !passwordReady || confirm.length === 0}>
            {busy ? t("product.working") : t("product.resetAction")}
          </button>
          <button type="button" className="ui-button" disabled={busy}
            onClick={() => { setStep("password"); setCode(""); setPassword(""); setConfirm(""); setFailure(null); setNote(null); }}>
            {t("product.backToSignIn")}
          </button>
        </form>
      )}

      {step === "code" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void (codeSent ? verifyCode() : sendCode()); }}>
          {emailField(codeSent || busy)}
          {codeSent && codeField()}
          <button type="submit" className="ui-button ui-button-primary" disabled={busy || !EMAIL.test(email) || (codeSent && !CODE.test(code))}>
            {busy ? t("product.working") : t(codeSent ? "product.verify" : "product.sendCode")}
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-button" disabled={busy}
              onClick={() => { setStep("password"); setCode(""); setCodeSent(false); setFailure(null); setNote(null); }}>
              {t("product.changeEmail")}
            </button>
            {codeSent && (
              <button type="button" className="ui-button" disabled={busy} onClick={() => void sendCode()}>
                {t("product.resendCode")}
              </button>
            )}
          </div>
        </form>
      )}

      {note && <p role="status" className="text-[13px] leading-[18px] text-ink-secondary">{note}</p>}
      {!note && step === "code" && codeSent && !failure && (
        <p role="status" className="text-[13px] leading-[18px] text-ink-secondary">{t("product.codeSent")}</p>
      )}
      {failure && <p role="alert" className="text-[13px] leading-[18px] text-ink-secondary">{failure}</p>}
      {!failure && notice && (notice.tone === "error" || notice.key === "product.serviceUnavailable") && (
        <p role="alert" className="text-[13px] leading-[18px] text-ink-secondary">{t(notice.key)}</p>
      )}
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("product.permissions")}</p>
    </main>
  );
}
