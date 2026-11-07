// Two account windows and two workspaces in one main process still cannot see
// each other's account: a replaced window, a stale handle and a closed window
// receive nothing, and every call is checked against the page as it is now.
import assert from "node:assert/strict";
import test from "node:test";
import { installProductAccountIpc } from "./product-account-ipc.mjs";
import { createProductAccountWindow } from "./product-account-window.mjs";

const ACCOUNT_URL = "file:///Applications/OpenMausBot.app/Contents/Resources/ui/product-account.html";
const WORKSPACE_A = "http://127.0.0.1:8801/";
const WORKSPACE_B = "http://127.0.0.1:8802/";

const accountState = email => ({ auth: "signed_in", runtime: "ready", user: { id: `user-${email}`, email } });

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
    documentUrl: contents.mainFrame.url,
    destroyed: false,
    isDestroyed() { return win.destroyed; },
    close() { win.destroyed = true; },
  };
  return win;
}

const eventFrom = (win, url = win.webContents.mainFrame.url) => {
  win.webContents.mainFrame.url = url;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
};

function install({ account = () => null, workspace = () => null } = {}) {
  const handlers = new Map();
  const service = {
    state: async () => accountState("a@example.test"),
    requestCode: async email => ({ auth: "signing_in", runtime: "stopped", user: { id: "user-a", email } }),
    verifyCode: async () => accountState("a@example.test"),
    refresh: async () => (account() ? accountState("a@example.test") : { auth: "signed_out", runtime: "stopped" }),
    ledger: async () => ({ items: [], nextCursor: null }),
    signOut: async () => ({ auth: "signed_out", runtime: "stopped" }),
  };
  const installed = installProductAccountIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    service,
    authWindow: account,
    authDocumentUrl: () => account()?.documentUrl ?? ACCOUNT_URL,
    workspaceWindow: workspace,
    workspaceDocumentUrl: () => workspace()?.documentUrl ?? WORKSPACE_A,
  });
  return { handlers, installed };
}

test("a replaced account window receives no more state, and its old page can no longer call", async () => {
  let current = fakeWindow(ACCOUNT_URL);
  const first = current;
  const { handlers, installed } = install({ account: () => current });
  installed.publish(accountState("a@example.test"));
  assert.equal(first.webContents.sent.length, 1);

  current = fakeWindow(ACCOUNT_URL);
  installed.publish(accountState("b@example.test"));
  assert.equal(first.webContents.sent.length, 1, "the replaced window is never written to again");
  assert.equal(current.webContents.sent.length, 1);
  // The first window is still a real page, but it is no longer the account window.
  await assert.rejects(async () => handlers.get("product-account:sign-out")(eventFrom(first)), /only available/);
  assert.deepEqual(await handlers.get("product-account:state")(eventFrom(current)), accountState("a@example.test"));
});

test("A's workspace loses its voice when B replaces it; each page only reads its own session's state", async () => {
  const account = fakeWindow(ACCOUNT_URL);
  let workspace = fakeWindow(WORKSPACE_A);
  const a = workspace;
  const { handlers, installed } = install({ account: () => account, workspace: () => workspace });
  await handlers.get("product-account:state")(eventFrom(a));
  installed.publish(accountState("a@example.test"));
  assert.equal(a.webContents.sent.length, 1);

  workspace = fakeWindow(WORKSPACE_B);
  const b = workspace;
  installed.publish(accountState("b@example.test"));
  assert.equal(a.webContents.sent.length, 1, "A's window is not written to after B signs in");
  assert.deepEqual(JSON.parse(JSON.stringify(b.webContents.sent.at(-1)[1])), accountState("b@example.test"));
  await assert.rejects(async () => handlers.get("product-account:refresh")(eventFrom(a)), /only available/);
  await handlers.get("product-account:refresh")(eventFrom(b));
});

test("a closed window is never written to, even before its owner clears the getter", async () => {
  const account = fakeWindow(ACCOUNT_URL), workspace = fakeWindow(WORKSPACE_A);
  const { installed } = install({ account: () => account, workspace: () => workspace });
  installed.publish(accountState("a@example.test"));
  assert.equal(workspace.webContents.sent.length, 1);
  workspace.destroyed = true;
  account.destroyed = true;
  assert.doesNotThrow(() => installed.publish(accountState("a@example.test")));
  assert.equal(workspace.webContents.sent.length, 1);
  assert.equal(account.webContents.sent.length, 1);
});

test("a window's handle reports its own page, not another handle's, and a hand-off close is silent", () => {
  const made = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.webContents = {
        url: "",
        sent: [],
        send: (channel, ...args) => this.webContents.sent.push([channel, ...args]),
        getURL: () => this.webContents.url,
        setWindowOpenHandler() {},
        on: (event, handler) => (this.handlers[event] ??= []).push(handler),
        once: (event, handler) => (this.handlers[event] ??= []).push(handler),
        mainFrame: { url: "" },
      };
      made.push(this);
    }
    setMenu() {}
    loadURL(url) { this.webContents.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
    once(event, handler) { (this.handlers[event] ??= []).push(handler); }
    close() { this.closed = true; }
    isDestroyed() { return this.destroyed === true; }
  }
  let quits = 0;
  const a = createProductAccountWindow({ BrowserWindow, url: ACCOUNT_URL, show: false, onClose: () => { quits++; } });
  const b = createProductAccountWindow({ BrowserWindow, url: ACCOUNT_URL, show: false, onClose: () => { quits++; } });
  const ownA = { sender: a.window.webContents, senderFrame: a.window.webContents.mainFrame };
  const ownB = { sender: b.window.webContents, senderFrame: b.window.webContents.mainFrame };
  assert.equal(a.owns(ownA), true);
  assert.equal(a.owns(ownB), false, "the other account window is another page");
  assert.equal(b.owns(ownB), true);
  // Sending A's state through B's handle never happens: B is still on its page.
  assert.equal(b.sendState(accountState("a@example.test")).auth, "signed_in");
  b.window.webContents.mainFrame.url = "https://evil.example.test/";
  assert.equal(b.sendState(accountState("b@example.test")), null, "a navigated page receives nothing");
  // Each window's own close asks main; a hand-off close does not.
  b.window.handlers.close[0]();
  assert.equal(quits, 1);
  b.close();
  assert.equal(quits, 1, "a hand-off's close never reaches the quit hook");
});
