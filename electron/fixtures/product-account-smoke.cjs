// window.ogb.productAccount as a real preload in a real Electron process: the
// isolation flags, the exact exposed surface, the sender guard and the pushed
// state, with no stubbed ipcRenderer or BrowserWindow.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const say = message => console.log(message);

// A disposable profile, chosen before any session or window exists, so
// nothing in this fixture can touch the person's own Electron data.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "omb-product-account-smoke-profile-"));
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.commandLine.appendSwitch("disable-features", "MediaRouter");
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const allowed = /^(?:file|data|blob|about|devtools):/.test(details.url)
      || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(details.url);
    callback({ cancel: !allowed });
  });
});
// The fixture's own lifetime is the script's: a closed window mid-run must not quit it.
app.on("window-all-closed", () => {});

const ownedDirs = [];
function cleanUp() {
  for (const dir of ownedDirs) fs.rmSync(dir, { recursive: true, force: true });
  ownedDirs.length = 0;
  fs.rmSync(profile, { recursive: true, force: true });
}

async function accountWindow() {
  const { createProductAccountWindow } = await import("../product-account-window.mjs");
  const { installProductAccountIpc } = await import("../product-account-ipc.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-product-account-smoke-"));
  ownedDirs.push(dir);
  const page = path.join(dir, "product-account.html");
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Account</title>
    <script>
      window.results = {};
      window.results.bridgeKeys = Object.keys(window.ogb ?? {});
      window.results.hasNode = typeof require !== "undefined" || typeof process !== "undefined";
      window.results.accountKeys = Object.keys(window.ogb?.productAccount ?? {});
      window.results.hasClose = typeof window.ogb?.productAccount?.close === "function";
      window.ogb?.productAccount?.onState(state => { window.results.event = state; });
      window.ogb?.productAccount?.state().then(state => { window.results.state = state; },
        error => { window.results.stateError = String(error?.message ?? error); });
      window.ogb?.productAccount?.requestCode({ token: "forged" }).catch(error => { window.results.badEmail = String(error?.message ?? error); });
      window.ogb?.productAccount?.ledger("not a cursor").catch(error => { window.results.badCursor = String(error?.message ?? error); });
    </script>`);
  const state = {
    auth: "signed_in", runtime: "ready", user: { id: "user-1", email: "person@example.test" },
    accountToken: "account-bearer", dataDir: "/Users/person/Library/Product",
    ai: { state: "ready", unit: "points", availableMicroPoints: 3000, reservedMicroPoints: 0, defaultModel: "maus-default",
      upstreamBaseUrl: "https://upstream.invalid",
      models: [{ id: "maus-default", label: "MausBot", protocol: "chat", pricingVersion: "v1", upstreamModel: "vendor/model",
        inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000, outputMicroPointsPerMillion: 4_000_000,
        maxContextTokens: 1000, maxOutputTokens: 100 }] },
  };
  const calls = [];
  const service = {
    state: async () => state,
    requestCode: async email => { calls.push(["requestCode", email]); return { auth: "signing_in", runtime: "stopped" }; },
    verifyCode: async (email, code) => { calls.push(["verifyCode", email, code]); return state; },
    refresh: async () => state,
    ledger: async cursor => { calls.push(["ledger", cursor]); return { items: [], nextCursor: null }; },
    signOut: async () => ({ auth: "signed_out", runtime: "stopped" }),
  };
  const handle = createProductAccountWindow({ BrowserWindow, url: `file://${page}`, show: false, partition: "persist:product-fixture" });
  const installed = installProductAccountIpc({ ipcMain, service, authWindow: () => handle });
  await handle.loaded;
  const contents = handle.window.webContents;
  const prefs = contents.getLastWebPreferences();
  say(`flags ${JSON.stringify({ sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, partition: prefs.partition })}`);
  say(`renderer ${JSON.stringify(await contents.executeJavaScript("window.results"))}`);
  const sent = handle.sendState({ ...state, verifyCode: "never" });
  say(`minted ${JSON.stringify({ keys: Object.keys(sent ?? {}), accountToken: "accountToken" in sent, dataDir: "dataDir" in sent, verifyCode: "verifyCode" in sent })}`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const results = await contents.executeJavaScript("window.results");
  const eventText = JSON.stringify(results.event ?? {});
  const leaked = ["never", "bearer", "upstream.invalid", "/Users/person"].some((secret) => eventText.includes(secret));
  say(`event ${JSON.stringify({ auth: results.event?.auth, email: results.event?.user?.email, leaked })}`);
  say(`guards ${JSON.stringify({ calls })}`);
  await contents.executeJavaScript("location.href = 'https://evil.example.test/'").catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 200));
  const stayed = contents.getURL().startsWith(`file://${page}`);
  // Main itself moving the window to another local page: that page is not the account page.
  const otherPage = path.join(path.dirname(page), "index.html");
  fs.writeFileSync(otherPage, "<!doctype html><title>Elsewhere</title>");
  await contents.loadURL(`file://${otherPage}`).catch(() => {});
  say(`navigation ${JSON.stringify({ stayed, state: handle.sendState(state) })}`);
  installed.dispose();
  handle.close();
  for (let i = 0; i < 100 && !handle.window.isDestroyed(); i++) await new Promise(resolve => setTimeout(resolve, 20));
}

async function workspacePreload() {
  const http = await import("node:http");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><meta charset=utf-8><title>Workspace</title>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const preload = path.join(__dirname, "..", "preload.cjs");
  const opened = [];
  const make = args => new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
    preload, additionalArguments: [`--omb-local-origin=${origin}`, ...args] } });
  const inspect = win => win.webContents.executeJavaScript(
    "({ hasAccount: typeof window.ogb?.productAccount?.state, own: window.ogb?.app?.ownPage, keys: Object.keys(window.ogb?.productAccount ?? {}) })");
  const managed = make(["--omb-product-managed=1"]);
  await managed.loadURL(`${origin}/`);
  opened.push(["managed", await inspect(managed)]);
  const ordinary = make([]);
  await ordinary.loadURL(`${origin}/`);
  opened.push(["ordinary", await inspect(ordinary)]);
  const guarded = make(["--omb-product-managed=1"]);
  await guarded.loadURL("data:text/html,<title>elsewhere</title>");
  opened.push(["other-page", await inspect(guarded)]);
  say(`workspace ${JSON.stringify(opened)}`);
  for (const win of [managed, ordinary, guarded]) win.destroy();
  await new Promise(resolve => server.close(resolve));
}

const watchdog = setTimeout(() => {
  console.error("fixture-timeout");
  cleanUp();
  app.exit(2);
}, 75_000);
watchdog.unref?.();

app.whenReady().then(async () => {
  try {
    await accountWindow();
    await workspacePreload();
    say("fixture-complete");
    cleanUp();
    app.exit(0);
  } catch (error) {
    console.error(`fixture-failed ${error?.stack ?? error}`);
    cleanUp();
    app.exit(1);
  }
});
