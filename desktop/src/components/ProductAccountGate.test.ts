// The account window's own behavior, rendered with the same static-render hook
// harness other settings surfaces use (no DOM environment, so the suite's shared
// Node setup is untouched). Every assertion is on what the person's click sends
// to the bridge and what the page then says.
import type * as ReactModule from "react";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductAccountBridge, ProductAccountState } from "../../../packages/shared/product-account";
import { setLocale } from "@/lib/i18n";

interface HookState {
  values: unknown[];
  index: number;
  effects: EffectCallback[];
}

const hooks = vi.hoisted<HookState>(() => ({ values: [], index: 0, effects: [] }));

vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (previous: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: (effect: EffectCallback) => { hooks.effects.push(effect); },
}));

// The react mock above must be registered before the component imports react,
// so this module is loaded after it rather than by a static import.
const { ProductAccountGate } = await import("./ProductAccountGate");

const ai = {
  state: "ready" as const,
  unit: "points" as const,
  availableMicroPoints: 3_000_000,
  reservedMicroPoints: 2_400,
  defaultModel: "hezuo-1",
  models: [],
};
const SIGNED_IN: ProductAccountState = {
  auth: "signed_in", runtime: "ready", user: { id: "user-1", email: "person@example.test" }, ai,
};
const METHODS = {
  password: { enabled: true as const, minLength: 10, maxLength: 128 },
  emailCode: { enabled: true },
  emailVerification: "required" as const,
};
const SIGNED_OUT: ProductAccountState = { auth: "signed_out", runtime: "stopped", authMethods: METHODS };

let bridge: ProductAccountBridge;

function makeBridge(): ProductAccountBridge {
  return {
    state: vi.fn().mockResolvedValue(SIGNED_OUT),
    methods: vi.fn().mockResolvedValue(SIGNED_OUT),
    requestCode: vi.fn().mockResolvedValue({ auth: "signed_out", runtime: "stopped" }),
    verifyCode: vi.fn().mockResolvedValue({ auth: "signed_in", runtime: "starting", user: SIGNED_IN.user, ai }),
    signInWithPassword: vi.fn().mockResolvedValue({ auth: "signed_in", runtime: "starting", user: SIGNED_IN.user, ai }),
    signUp: vi.fn().mockResolvedValue({ auth: "signed_out", runtime: "stopped", pendingEmail: "person@example.test" }),
    confirmEmail: vi.fn().mockResolvedValue({ auth: "signed_in", runtime: "starting", user: SIGNED_IN.user, ai }),
    requestPasswordReset: vi.fn().mockResolvedValue({ auth: "signed_out", runtime: "stopped", pendingEmail: "person@example.test" }),
    resetPassword: vi.fn().mockResolvedValue({ auth: "signed_out", runtime: "stopped" }),
    refresh: vi.fn().mockResolvedValue(SIGNED_IN),
    ledger: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    operatorStatus: vi.fn().mockResolvedValue({ eligible: false }),
    grantMaximum: vi.fn().mockResolvedValue({ outcome: "failed", amountMicroPoints: 0, errorCode: "forbidden", state: SIGNED_IN }),
    signOut: vi.fn().mockResolvedValue({ auth: "signed_out", runtime: "stopped" }),
    onState: vi.fn(() => () => {}),
  };
}

type Node = ReactElement<Record<string, unknown>>;

function all(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children as ReactNode).flatMap(all)];
}

function render() {
  hooks.index = 0;
  hooks.effects = [];
  let tree: ReactNode;
  function Capture() { tree = ProductAccountGate(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, tree };
}

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

/** First paint plus the effects it scheduled: the account state and the ways in
 * are read from the bridge the way the window reads them, then a later render
 * shows what those answers changed. */
async function mount() {
  render();
  for (const effect of hooks.effects.splice(0)) effect();
  await flush();
}

function button(label: string): Node | undefined {
  return all(render().tree).find(node => node.type === "button"
    && String((node.props.children as ReactNode) ?? "").trim() === label);
}
function hasButton(label: string): boolean {
  return all(render().tree).some(node => node.type === "button"
    && String((node.props.children as ReactNode) ?? "").trim() === label);
}
async function click(label: string) {
  const target = button(label);
  expect(target, `the ${label} button`).toBeTruthy();
  (target!.props.onClick as () => void)();
  await flush();
}
async function submit() {
  const form = all(render().tree).find(node => node.type === "form");
  expect(form, "the form").toBeTruthy();
  (form!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  await flush();
}
function input(match: (props: Record<string, unknown>) => boolean): Node {
  const found = all(render().tree).find(node => node.type === "input" && match(node.props));
  expect(found, "the input").toBeTruthy();
  return found!;
}
async function type(target: Node, value: string) {
  (target.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  await flush();
}
const emailBox = () => input(props => props.type === "email");
const codeBox = () => input(props => props.autoComplete === "one-time-code");
const passwordBox = () => input(props => props.autoComplete === "current-password");
const newPasswordBoxes = () => all(render().tree).filter(node => node.type === "input" && node.props.autoComplete === "new-password");
const text = () => render().html.replace(/<[^>]+>/g, " ");
const step = () => all(render().tree).find(node => node.props["data-product-step"] !== undefined)?.props["data-product-step"];
const windowKind = () => all(render().tree).find(node => node.props["data-product-account-window"] !== undefined)?.props["data-product-account-window"];

beforeEach(() => {
  setLocale("en");
  bridge = makeBridge();
  vi.stubGlobal("window", { ogb: { productAccount: bridge } });
  hooks.values = [];
  hooks.index = 0;
  hooks.effects = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLocale("en");
});

describe("the account window", () => {
  it("signs in with a password and never asks for a model or a key", async () => {
    await mount();
    expect(windowKind()).toBe("sign-in");
    expect(step()).toBe("password");
    expect(text()).not.toMatch(/API key|provider|model address/i);
    // The ways in are read once from the service.
    expect(bridge.methods).toHaveBeenCalledOnce();

    await type(emailBox(), "person@example.test");
    await type(passwordBox(), "correct horse battery staple");
    await submit();
    expect(bridge.signInWithPassword).toHaveBeenCalledExactlyOnceWith("person@example.test", "correct horse battery staple");
    expect(bridge.requestCode).not.toHaveBeenCalled();
  });

  it("asks a new account for the password twice, then for the emailed code", async () => {
    await mount();
    await click("Create an account");
    expect(step()).toBe("sign-up");
    await type(emailBox(), "person@example.test");
    await type(newPasswordBoxes()[0]!, "correct horse battery staple");
    await submit();
    expect(text()).toContain("The two passwords do not match.");
    expect(bridge.signUp).not.toHaveBeenCalled();

    await type(newPasswordBoxes()[1]!, "correct horse battery staple");
    await submit();
    expect(bridge.signUp).toHaveBeenCalledExactlyOnceWith("person@example.test", "correct horse battery staple");

    // The service named the address awaiting its code; the form must adopt it.
    for (const effect of hooks.effects.splice(0)) effect();
    await flush();
    expect(text()).toContain("Confirm person@example.test");
    await type(codeBox(), "12345678");
    await type(passwordBox(), "correct horse battery staple");
    await submit();
    expect(bridge.confirmEmail).toHaveBeenCalledExactlyOnceWith("person@example.test", "12345678", "correct horse battery staple");
  });

  it("explains a rejected password and keeps the form", async () => {
    vi.mocked(bridge.signInWithPassword).mockResolvedValue({
      auth: "signed_out", runtime: "stopped", errorCode: "invalid_credentials",
    });
    await mount();
    await type(emailBox(), "person@example.test");
    await type(passwordBox(), "not the right password");
    await submit();
    expect(windowKind()).toBe("sign-in");
    expect(step()).toBe("password");
    expect(text()).toContain("That email and password did not match an account.");
  });

  it("asks for a code only when this deployment can send email", async () => {
    vi.mocked(bridge.state).mockResolvedValue({
      auth: "signed_out", runtime: "stopped",
      authMethods: { password: METHODS.password, emailCode: { enabled: false }, emailVerification: "off" },
    });
    await mount();
    expect(hasButton("Email me a sign-in code")).toBe(false);
    expect(text()).not.toContain("Email me a sign-in code");
  });

  it("resets a forgotten password with an emailed code", async () => {
    await mount();
    await click("Forgot your password?");
    expect(step()).toBe("reset-request");
    // The reset form's own submit asks the service for a code.
    await type(emailBox(), "person@example.test");
    await submit();
    expect(bridge.requestPasswordReset).toHaveBeenCalledExactlyOnceWith("person@example.test");
    // The service named the address awaiting its code; the form adopts it.
    for (const effect of hooks.effects.splice(0)) effect();
    await flush();
    expect(step()).toBe("reset");

    await type(codeBox(), "12345678");
    await type(newPasswordBoxes()[0]!, "a brand new passphrase");
    await type(newPasswordBoxes()[1]!, "a brand new passphrase");
    await submit();
    expect(bridge.resetPassword).toHaveBeenCalledExactlyOnceWith("person@example.test", "12345678", "a brand new passphrase");
    expect(text()).toContain("Your password is updated. Sign in with the new one.");
  });

  it("still signs in with an emailed code where mail is configured", async () => {
    await mount();
    await click("Email me a sign-in code");
    expect(step()).toBe("code");
    expect(codeBox).toBeTruthy();
    await type(emailBox(), "person@example.test");
    await submit();
    expect(bridge.requestCode).toHaveBeenCalledExactlyOnceWith("person@example.test");
    await type(codeBox(), "12345678");
    await submit();
    expect(bridge.verifyCode).toHaveBeenCalledExactlyOnceWith("person@example.test", "12345678");
    expect(bridge.signInWithPassword).not.toHaveBeenCalled();
  });

  it("goes back to the email with the same address when the person chooses another one", async () => {
    await mount();
    await click("Email me a sign-in code");
    await type(emailBox(), "person@example.test");
    await submit();
    await click("Use another email");
    expect(step()).toBe("password");
    expect(emailBox().props.value).toBe("person@example.test");
  });

  it("shows the verified email, the exact point balance and the account's state once signed in", async () => {
    vi.mocked(bridge.state).mockResolvedValue(SIGNED_IN);
    await mount();
    expect(windowKind()).toBe("signed-in");
    expect(text()).toContain("person@example.test");
    expect(text()).toContain("3.000000");
    expect(text()).toContain("0.002400");
    // Points are not currency: the account window never shows a dollar sign.
    expect(text()).not.toContain("$");
    expect(text()).toContain("Your account is ready.");
    // No purchase, top-up or personal-key way out exists here.
    expect(text()).not.toMatch(/buy|upgrade|add funds|API key/i);
    await click("Refresh");
    expect(bridge.refresh).toHaveBeenCalledOnce();
  });

  it("keeps a wrong code on the form with a reason instead of signing the person in", async () => {
    await mount();
    await click("Email me a sign-in code");
    await type(emailBox(), "person@example.test");
    await submit();
    expect(codeBox).toBeTruthy();

    await type(codeBox(), "1234567");
    expect(hasButton("Verify and sign in")).toBe(true);

    vi.mocked(bridge.verifyCode).mockResolvedValue({ auth: "signed_out", runtime: "stopped", errorCode: "invalid_otp" });
    await type(codeBox(), "12345678");
    await submit();
    expect(windowKind()).toBe("sign-in");
    expect(text()).toContain("That code did not match. Check the email and try again.");
  });

  it("names a missing service rather than an unknown failure", async () => {
    vi.mocked(bridge.signInWithPassword).mockResolvedValue({ auth: "unavailable", runtime: "stopped", errorCode: "network_unavailable" });
    await mount();
    await type(emailBox(), "person@example.test");
    await type(passwordBox(), "correct horse battery staple");
    await submit();
    expect(windowKind()).toBe("sign-in");
    expect(text()).toContain("The account service could not be reached. Check your connection, then refresh.");
  });

  it("says the window is unavailable in a build without the account bridge", async () => {
    vi.stubGlobal("window", { ogb: {} });
    await mount();
    expect(windowKind()).toBe("unavailable");
    expect(text()).toContain("The account window is not available in this build");
  });
});
