// The account bridge main registers: only the account window's own top frame
// on its exact page, or the current owned workspace's top frame on its exact
// page, may read state or change the account; nothing else reaches the service.
import assert from "node:assert/strict";
import test from "node:test";
import { installProductAccountIpc } from "./product-account-ipc.mjs";
import { createProductAccountWindow, normalizeAccountDocumentUrl, normalizeLocalDocumentUrl } from "./product-account-window.mjs";

const ACCOUNT_URL = "file:///Applications/OpenMausBot.app/Contents/Resources/ui/product-account.html";
const OTHER_ACCOUNT_URL = "file:///Users/person/Downloads/product-account.html";
const WORKSPACE_URL = "http://127.0.0.1:8799/";

const model = (id = "maus-default") => ({ id, label: id, protocol: "chat", pricingVersion: "v1",
  inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 1000, maxOutputTokens: 100 });
const status = () => ({ state: "ready", unit: "points", availableMicroPoints: 3000, reservedMicroPoints: 0, defaultModel: "maus-default", models: [model()] });
const accountState = () => ({ auth: "signed_in", runtime: "ready", user: { id: "user-1", email: "person@example.test" }, ai: status() });

function fakeWindow(url) {
  const contents = {
    sent: [],
    isDestroyed: () => false,
    send: (channel, ...args) => contents.sent.push([channel, ...args]),
    getURL: () => contents.mainFrame.url,
  };
  contents.mainFrame = { url };
  const win = {
    webContents: contents,
    destroyed: false,
    closes: 0,
    isDestroyed() { return win.destroyed; },
    close() { win.closes++; win.destroyed = true; },
  };
  return win;
}

/** The window's own top frame, on the URL it has navigated to. */
function eventFor(win, url = win.webContents.mainFrame.url) {
  win.webContents.mainFrame.url = url;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/** A child frame inside the same window: the same sender, a different frame. */
function childEvent(win, url = WORKSPACE_URL) {
  return { sender: win.webContents, senderFrame: { url } };
}

function service(overrides = {}) {
  const calls = [];
  const fake = {
    state: async () => { calls.push(["state"]); return accountState(); },
    requestCode: async email => { calls.push(["requestCode", email]); return { auth: "signing_in", runtime: "stopped", user: { id: "user-1", email } }; },
    verifyCode: async (email, code) => { calls.push(["verifyCode", email, code]); return accountState(); },
    refresh: async () => { calls.push(["refresh"]); return accountState(); },
    ledger: async cursor => { calls.push(["ledger", cursor]); return { items: [{ id: "r1", kind: "request", createdAt: 5, model: "maus-default", state: "settled", chargedMicroPoints: 2100, prompt: "private words", accountToken: "secret" }], nextCursor: null }; },
    signOut: async () => { calls.push(["signOut"]); return { auth: "signed_out", runtime: "stopped" }; },
    methods: async () => { calls.push(["methods"]); return { auth: "signed_out", runtime: "stopped", authMethods: { password: { enabled: true, minLength: 10, maxLength: 128 }, emailCode: { enabled: true }, emailVerification: "required" } }; },
    signInWithPassword: async (email, password) => { calls.push(["signInWithPassword", email, password]); return accountState(); },
    signUp: async (email, password) => { calls.push(["signUp", email, password]); return { auth: "signed_out", runtime: "stopped", pendingEmail: email }; },
    confirmEmail: async (email, code, password) => { calls.push(["confirmEmail", email, code, password]); return accountState(); },
    requestPasswordReset: async email => { calls.push(["requestPasswordReset", email]); return { auth: "signed_out", runtime: "stopped", pendingEmail: email }; },
    resetPassword: async (email, code, password) => { calls.push(["resetPassword", email, code, password]); return { auth: "signed_out", runtime: "stopped" }; },
    ...overrides,
  };
  return { fake, calls };
}

function harness({ account = fakeWindow(ACCOUNT_URL), accountUrl = ACCOUNT_URL, workspace, close = () => {}, override } = {}) {
  const handlers = new Map(), published = [], { fake, calls } = service(override);
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const installed = installProductAccountIpc({
    ipcMain,
    service: fake,
    authWindow: () => account,
    authDocumentUrl: accountUrl,
    workspaceWindow: workspace === undefined ? undefined : () => workspace,
    workspaceDocumentUrl: workspace === undefined ? undefined : () => WORKSPACE_URL,
    onClose: close,
    onStateChanged: state => published.push(state),
  });
  return { handlers, calls, published, installed, account };
}

test("operator bridge checks owned top frame, strips private fields, and never forwards targets", async () => {
  const workspace = fakeWindow(WORKSPACE_URL);
  const calls = [];
  const h = harness({ workspace, override: {
    operatorStatus: async (...args) => {
      calls.push(args);
      return { eligible: true, availableMicroPoints: 0, reservedMicroPoints: 0,
        maxGrantMicroPoints: Number.MAX_SAFE_INTEGER, accountToken: "secret", endpoint: "private" };
    },
    grantMaximum: async (...args) => {
      calls.push(args);
      return { outcome: "already_max", amountMicroPoints: 0, accountToken: "secret",
        state: { ...accountState(), accountToken: "secret" } };
    },
  } });
  for (const channel of ["product-account:operator-status", "product-account:grant-maximum"]) {
    const handler = h.handlers.get(channel);
    await assert.rejects(() => handler(childEvent(workspace)), /only available/);
    await assert.rejects(() => handler(eventFor(fakeWindow(WORKSPACE_URL))), /only available/);
    await assert.rejects(() => handler(eventFor(workspace, "https://evil.example/")), /only available/);
    const result = await handler(eventFor(workspace, WORKSPACE_URL), { userId: "other", accountToken: "forged" });
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  assert.deepEqual(calls, [[], []]);
});

test("the account page's exact top frame alone reaches the service", async () => {
  const { handlers, calls, account } = harness();
  assert.deepEqual(await handlers.get("product-account:state")(eventFor(account)), accountState());
  await handlers.get("product-account:request-code")(eventFor(account), "  person@example.test ");
  await handlers.get("product-account:verify-code")(eventFor(account), "person@example.test", " 12345678 ");
  await handlers.get("product-account:refresh")(eventFor(account));
  assert.deepEqual(await handlers.get("product-account:ledger")(eventFor(account), "abc_DEF-123"),
    { items: [{ id: "r1", kind: "request", createdAt: 5, model: "maus-default", state: "settled", chargedMicroPoints: 2100 }], nextCursor: null });
  await handlers.get("product-account:sign-out")(eventFor(account));
  assert.deepEqual(calls, [["state"], ["requestCode", "person@example.test"], ["verifyCode", "person@example.test", "12345678"], ["refresh"], ["ledger", "abc_DEF-123"], ["signOut"]]);
});

test("password calls reach the service only from the account page, and never come back in the state", async () => {
  const { handlers, calls, account } = harness();
  const password = "correct horse battery staple";
  await handlers.get("product-account:methods")(eventFor(account));
  const signedIn = await handlers.get("product-account:sign-in-password")(eventFor(account), "person@example.test", password);
  assert.equal(JSON.stringify(signedIn).includes(password), false);
  await handlers.get("product-account:sign-up")(eventFor(account), "person@example.test", password);
  await handlers.get("product-account:confirm-email")(eventFor(account), "person@example.test", "12345678", password);
  await handlers.get("product-account:request-password-reset")(eventFor(account), "person@example.test");
  await handlers.get("product-account:reset-password")(eventFor(account), "person@example.test", "12345678", password);
  assert.deepEqual(calls, [
    ["methods"],
    ["signInWithPassword", "person@example.test", password],
    ["signUp", "person@example.test", password],
    ["confirmEmail", "person@example.test", "12345678", password],
    ["requestPasswordReset", "person@example.test"],
    ["resetPassword", "person@example.test", "12345678", password],
  ]);

  // The account's own workspace may read state and history, but a password
  // never travels from there: the form lives in the account window.
  const workspace = fakeWindow(WORKSPACE_URL);
  const scoped = harness({ workspace });
  for (const channel of [
    "product-account:sign-in-password", "product-account:sign-up", "product-account:confirm-email",
    "product-account:request-password-reset", "product-account:reset-password",
  ]) {
    await assert.rejects(async () => scoped.handlers.get(channel)(eventFor(workspace), "person@example.test", "correct horse battery staple"),
      /only available/);
  }
  await assert.rejects(async () => scoped.handlers.get("product-account:sign-in-password")(childEvent(account), "person@example.test", password),
    /only available/);
});

test("a password outside the published range and a malformed code never reach the service", async () => {
  const { handlers, calls, account } = harness();
  for (const password of ["", "short", "x".repeat(129), 7, { password: "correct horse battery staple" }]) {
    await assert.rejects(async () => handlers.get("product-account:sign-in-password")(eventFor(account), "person@example.test", password),
      /password of 10 to 128 characters/);
    await assert.rejects(async () => handlers.get("product-account:sign-up")(eventFor(account), "person@example.test", password),
      /password of 10 to 128 characters/);
  }
  for (const code of ["", "1234567", "123456789", "abcdefgh"]) {
    await assert.rejects(async () => handlers.get("product-account:confirm-email")(eventFor(account), "person@example.test", code, "correct horse battery staple"),
      /code from the email/);
  }
  assert.deepEqual(calls, []);
});

test("a child frame, another window, another page and a remote address never reach the service", async () => {
  const { handlers, calls, account } = harness();
  const other = fakeWindow(OTHER_ACCOUNT_URL);
  const refused = [
    // A child frame in the same window, even with the account page's address.
    childEvent(account),
    // Another window entirely, even on the same page.
    eventFor(other),
    // The same window navigated to a remote address.
    eventFor(account, "https://evil.example.test/product-account.html"),
    // The workspace page, though it is this app's own page.
    eventFor(account, "http://127.0.0.1:8799/"),
    // A different local page.
    { sender: account.webContents, senderFrame: { url: "file:///tmp/product-account.html" } },
    // A sender with no frame of its own.
    { sender: {}, senderFrame: account.webContents.mainFrame },
    { sender: account.webContents },
  ];
  for (const event of refused) {
    await assert.rejects(async () => handlers.get("product-account:state")(event), /only available in this app's account window/);
  }
  assert.deepEqual(calls, []);
  assert.throws(() => handlers.get("product-account:close")(childEvent(account)), /only available/);
});

test("the workspace's exact approved page reads and refreshes, but never closes the account window", async () => {
  const account = fakeWindow(ACCOUNT_URL), workspace = fakeWindow(WORKSPACE_URL);
  let closed = 0;
  const { handlers, calls } = harness({ account, workspace, close: () => { closed++; } });
  await handlers.get("product-account:state")(eventFor(workspace));
  await handlers.get("product-account:refresh")(eventFor(workspace));
  assert.deepEqual(calls, [["state"], ["refresh"]]);
  assert.throws(() => handlers.get("product-account:close")(eventFor(workspace)), /only available/);
  assert.equal(closed, 0);
  // A workspace cannot begin a new sign-in: only the account window may.
  await assert.rejects(async () => handlers.get("product-account:request-code")(eventFor(workspace), "person@example.test"), /only available/);
  await assert.rejects(async () => handlers.get("product-account:verify-code")(eventFor(workspace), "person@example.test", "12345678"), /only available/);
  await handlers.get("product-account:state")(eventFor(workspace, `${WORKSPACE_URL}?desktop-settings=cloud`));
  // A getter that tracks a page already carrying a query is exact, not a prefix.
  assert.deepEqual(await handlers.get("product-account:state")(eventFor(workspace, `${WORKSPACE_URL}?desktop-settings=cloud`)), accountState());
  await handlers.get("product-account:state")(eventFor(workspace, `${WORKSPACE_URL}?desktop-settings=workspaces&share-computer=abc`));
  for (const event of [
    eventFor(workspace, `${WORKSPACE_URL}?other=1`),
    eventFor(workspace, `${WORKSPACE_URL}?desktop-settings=x&other=1`),
    eventFor(workspace, "http://127.0.0.1:8800/?desktop-settings=cloud"),
    eventFor(workspace, `${WORKSPACE_URL}index.html`),
    childEvent(workspace),
  ]) await assert.rejects(async () => handlers.get("product-account:state")(event), /only available/);
});

test("state and ledger are copied field by field: no account bearer, model token, address or directory crosses", async () => {
  const win = fakeWindow(ACCOUNT_URL);
  const leaked = {
    ...accountState(),
    accountToken: "account-bearer",
    ai: { ...status(), upstreamBaseUrl: "https://upstream.invalid", models: [{ ...model(), upstreamModel: "vendor/model", enabled: true }] },
    dataDir: "/Users/person/Library/Product/workspace",
  };
  const { handlers, published } = harness({
    account: win,
    workspace: fakeWindow(WORKSPACE_URL),
    override: { state: async () => leaked, refresh: async () => leaked, requestCode: async () => leaked },
  });
  const state = await handlers.get("product-account:state")(eventFor(win));
  for (const secret of ["account-bearer", "upstream.invalid", "vendor/model", "/Users/person"]) assert.equal(JSON.stringify(state).includes(secret), false);
  assert.deepEqual(Object.keys(state).sort(), ["ai", "auth", "runtime", "user"]);
  await handlers.get("product-account:refresh")(eventFor(win));
  assert.equal(JSON.stringify(published.at(-1)).includes("account-bearer"), false);
  const ledger = await handlers.get("product-account:ledger")(eventFor(win));
  assert.equal(JSON.stringify(ledger).includes("private words"), false);
  assert.deepEqual(Object.keys(ledger.items[0]).sort(), ["chargedMicroPoints", "createdAt", "id", "kind", "model", "state"]);
});

test("an unreadable state is reported as unavailable; a malformed mutation or page is refused", async () => {
  const win = fakeWindow(ACCOUNT_URL);
  const { handlers } = harness({
    account: win,
    override: {
      state: async () => ({ auth: "signed_in", runtime: "ready" }),
      refresh: async () => ({ auth: "bogus" }),
      ledger: async () => ({ items: "not a list" }),
    },
  });
  assert.deepEqual(await handlers.get("product-account:state")(eventFor(win)), { auth: "signed_in", runtime: "ready" }, "unknown fields are dropped, never passed through");
  const broken = harness({ account: win, override: { state: async () => ({ auth: "signed_in" }) } });
  assert.deepEqual(await broken.handlers.get("product-account:state")(eventFor(win)), { auth: "unavailable", runtime: "stopped", errorCode: "state_unavailable" });
  await assert.rejects(async () => handlers.get("product-account:refresh")(eventFor(win)), /invalid_account_state/);
  await assert.rejects(async () => handlers.get("product-account:ledger")(eventFor(win)), /invalid_ledger_page/);
});

test("a malformed cursor and address are refused before the service sees them", async () => {
  const win = fakeWindow(ACCOUNT_URL);
  const { handlers, calls } = harness({ account: win });
  for (const cursor of ["x".repeat(257), "not a cursor", 7, {}]) await assert.rejects(async () => handlers.get("product-account:ledger")(eventFor(win), cursor), /no longer available/);
  for (const email of ["", "person", "person@example", 7, `${"a".repeat(310)}@example.test`]) await assert.rejects(async () => handlers.get("product-account:request-code")(eventFor(win), email), /email address/);
  for (const code of ["", "12", "1234567", "123456789", "abcdefgh"]) await assert.rejects(async () => handlers.get("product-account:verify-code")(eventFor(win), "person@example.test", code), /code from the email/);
  assert.deepEqual(calls, []);
});

test("a change is published to both pages with only safe fields, and a page close asks main", async () => {
  const account = fakeWindow(ACCOUNT_URL), workspace = fakeWindow(WORKSPACE_URL);
  let closed = 0;
  const { handlers, installed } = harness({ account, workspace, close: () => { closed++; } });
  await handlers.get("product-account:request-code")(eventFor(account), "person@example.test");
  assert.deepEqual(account.webContents.sent.at(-1)[0], "product-account:state-changed");
  for (const win of [account, workspace]) {
    const [, state] = win.webContents.sent.at(-1);
    assert.equal(state.auth, "signing_in");
    assert.equal(JSON.stringify(state).includes("token"), false);
  }
  handlers.get("product-account:close")(eventFor(account));
  assert.equal(closed, 1);
  assert.equal(account.closes, 0, "main decides what a page close means");
  installed.publish({ auth: "signed_out", runtime: "stopped" });
  assert.deepEqual(workspace.webContents.sent.at(-1)[1], { auth: "signed_out", runtime: "stopped" });
  // A page that navigated away — a stale window or a remote address — is never sent the account state.
  for (const win of [account, workspace]) win.webContents.mainFrame.url = "https://evil.example.test/";
  installed.publish({ auth: "signed_in", runtime: "ready", user: { id: "user-1", email: "person@example.test" } });
  for (const win of [account, workspace]) assert.equal(win.webContents.sent.at(-1)[0], "product-account:state-changed");
  assert.deepEqual(account.webContents.sent.at(-1)[1], { auth: "signed_out", runtime: "stopped" });
  assert.deepEqual(workspace.webContents.sent.at(-1)[1], { auth: "signed_out", runtime: "stopped" });
  installed.dispose();
  assert.equal(handlers.size, 0);
});

test("the window builds a sandboxed local account page, denies navigation, and closes silently when handed off", () => {
  const made = [];
  class BrowserWindow {
    constructor(options) { this.options = options; this.handlers = {}; this.webContents = { sent: [], send: (channel, ...args) => this.webContents.sent.push([channel, ...args]), setWindowOpenHandler: handler => (this.opener = handler), on: (event, handler) => (this.contentsHandlers ??= {}, (this.contentsHandlers[event] ??= []).push(handler)), once: (event, handler) => (this.contentsHandlers ??= {}, (this.contentsHandlers[event] ??= []).push(handler)), getURL: () => this.loaded }; made.push(this); }
    setMenu(value) { this.menu = value; }
    loadURL(url) { this.loaded = url; return Promise.resolve(); }
    once(event, handler) { (this.handlers[event] ??= []).push(handler); }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
    close() { this.closed = true; }
    isDestroyed() { return false; }
  }
  let quits = 0;
  const handle = createProductAccountWindow({ BrowserWindow, url: `${ACCOUNT_URL}#form`, partition: "persist:product-abc", onClose: () => { quits++; } });
  assert.equal(handle.loaded instanceof Promise, true);
  assert.equal(made[0].options.webPreferences.sandbox, true);
  assert.equal(made[0].options.webPreferences.contextIsolation, true);
  assert.equal(made[0].options.webPreferences.nodeIntegration, false);
  assert.equal(made[0].options.webPreferences.partition, "persist:product-abc");
  assert.ok(made[0].options.webPreferences.preload.endsWith("product-account-preload.cjs"));
  assert.equal(made[0].loaded, ACCOUNT_URL, "the fragment is not part of the page");
  assert.deepEqual(made[0].opener(), { action: "deny" });
  // Any link away from the account page is stopped; the account page may stay.
  const prevented = [];
  made[0].contentsHandlers["will-navigate"][0]({ preventDefault: () => prevented.push("stopped") }, "https://evil.example.test/");
  assert.deepEqual(prevented, ["stopped"]);
  made[0].contentsHandlers["will-navigate"][0]({ preventDefault: () => prevented.push("stopped") }, ACCOUNT_URL);
  assert.deepEqual(prevented, ["stopped"]);
  // Dismissing the window asks main; a hand-off's close does not.
  made[0].handlers.close[0]();
  assert.equal(quits, 1);
  handle.close();
  assert.equal(quits, 1);
  assert.equal(made[0].closed, true);
  assert.throws(() => createProductAccountWindow({ BrowserWindow, url: "https://operator.example/product-account.html" }), /packaged local page/);
  assert.throws(() => createProductAccountWindow({ BrowserWindow, url: "file:///tmp/elsewhere.html" }), /packaged local page/);
});

test("document addresses: only the account page, locally, without credentials or a fragment", () => {
  assert.equal(normalizeAccountDocumentUrl(ACCOUNT_URL), ACCOUNT_URL);
  assert.equal(normalizeAccountDocumentUrl(`${ACCOUNT_URL}?x=1#y`), `${ACCOUNT_URL}?x=1`);
  assert.equal(normalizeAccountDocumentUrl("http://127.0.0.1:5199/product-account.html"), "http://127.0.0.1:5199/product-account.html");
  assert.equal(normalizeAccountDocumentUrl("http://localhost:5199/product-account.html"), "http://localhost:5199/product-account.html");
  for (const bad of ["https://127.0.0.1/product-account.html", "file:///tmp/index.html", "http://127.0.0.1:5199/", "file://u:p@/tmp/product-account.html"]) {
    assert.equal(normalizeAccountDocumentUrl(bad), null, bad);
  }
  assert.equal(normalizeLocalDocumentUrl(WORKSPACE_URL), WORKSPACE_URL);
  assert.equal(normalizeLocalDocumentUrl("https://bots.example.test/"), null);
});
