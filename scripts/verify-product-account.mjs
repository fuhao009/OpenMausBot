#!/usr/bin/env node
// The real app, the real Worker, the real gateway, in one disposable place.
//
//   node scripts/verify-product-account.mjs
//   node scripts/verify-product-account.mjs --app "/absolute/Hezuo Product.app"
//   node scripts/verify-product-account.mjs --keep     (keep the disposable profile)
//   node scripts/verify-product-account.mjs --worker-project /path/to/gateway/control-plane
// The selected project supplies the Worker, migrations and pinned Wrangler runtime.
//
// Real here means:
//   * gateway/control-plane (this checkout unless --worker-project is explicit),
//     bundled with esbuild and run by its own Wrangler's Miniflare over TLS,
//     with a D1 database built from that project's migrations, the Worker's real EMAIL
//     binding (a disposable mailbox), and a real loopback upstream reached
//     through the Worker's own egress hook. Account sign-in, operator
//     enable/grant, model tokens, billing and the ledger are the production
//     Worker code; nothing fakes a status or injects a capability over HTTP.
//   * the desktop app itself: desktop/electron/main.mjs, its product auth gate, the
//     real account and workspace windows, its own server child, the product AI
//     provider, and a real stdio MCP server that writes one file.
//   * no personal key, engine CLI, Cloud account or operator secret is used.
//     The fixture's explicit test entry (OMB_PRODUCT_FIXTURE=1 plus a temp
//     root argument) is what lets a loopback HTTPS origin stand in for the
//     operator's own service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { electronBinary, packagedBinary, workerProjectPaths } from "./product-fixture/runtime.mjs";
import { fileURLToPath } from "node:url";
import { startWorkerFixture, trustFixtureCertificate, FIXTURE_CHARGE_MICRO_POINTS, MODELS } from "./product-fixture/worker-fixture.mjs";
import { signIn, signInWithPassword, operatorLookup, operatorSetAccount, operatorGrant } from "./product-fixture/operator.mjs";
import { attachPage, clickButtonByText, fillField, listPages, waitForPage } from "./product-fixture/cdp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_A = "person-a@fixture.test";
const ACCOUNT_B = "person-b@fixture.test";
const PASSWORD = "fixture password 2026";

function parseCli() {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      keep: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      port: { type: "string" },
      // Exercise the password form against a deployment with no mail transport:
      // sign-up needs no code, and every later sign-in is the password alone.
      password: { type: "boolean", default: false },
      "bundled-trust": { type: "boolean", default: false },
      "worker-project": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

/** A temp root whose canonical path keeps the gate's own basename rule; macOS's
 * /var → /private/var means the argument must be the real path. */
function fixtureRoot() {
  const created = mkdtempSync(join(tmpdir(), "omb-product-verify-"));
  const root = realpathSync(created);
  for (const name of ["home", "evidence", "bin"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The app's environment: a disposable HOME, no engine/CLI on PATH, and no
 * account, key or operator secret inherited from this shell. TMPDIR is the
 * parent's own system temp, canonicalised exactly as main's fixture gate does,
 * so the app resolves the same temporary root this script created. */
function appEnvironment({ root, origin, certPath, verbose }) {
  const environment = {};
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "TERM", "USER"]);
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && keep.has(key)) environment[key] = value;
  environment.HOME = join(root, "home");
  environment.USERPROFILE = environment.HOME;
  environment.PATH = [join(root, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  const temporary = realpathSync(tmpdir());
  environment.TMPDIR = temporary;
  environment.TEMP = temporary;
  environment.TMP = temporary;
  if (certPath) environment.NODE_EXTRA_CA_CERTS = certPath;
  environment.OMB_PRODUCT_FIXTURE = "1";
  environment.OMB_PRODUCT_FIXTURE_ORIGIN = origin;
  if (verbose) environment.ELECTRON_ENABLE_LOGGING = "1";
  return environment;
}

function launchApp({ appBinary, devBinary, root, origin, certPath, debugPort, verbose }) {
  const common = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--lang=en-US",
    ...(process.platform === "linux" ? ["--disable-gpu"] : []),
    // The fixture's HOME is disposable, so there is no login keychain to unlock. Electron's own
    // mock keychain keeps `safeStorage` (and therefore the encrypted record store) real without
    // raising an OS permission prompt nobody is at the machine to answer.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ];
  const args = appBinary ? [...common, `--omb-product-fixture-root=${root}`]
    : [...common, `--omb-product-fixture-root=${root}`, ROOT];
  const child = spawn(appBinary ?? devBinary, args, {
    env: appEnvironment({ root, origin, certPath, verbose }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, logs: () => `${stdout}\n${stderr}`.trim().slice(-6_000) };
}

/** The same text the account pages render: points, six decimals, no currency. */
const points = microPoints => {
  const whole = Math.floor(microPoints / 1_000_000);
  return `${whole}.${String(microPoints - whole * 1_000_000).padStart(6, "0")}`;
};

const sleep = delay;

async function main() {
  const options = parseCli();
  if (options["bundled-trust"] && (!options.app || process.platform !== "darwin")) throw new Error("--bundled-trust requires a macOS --app bundle");
  const workerProject = workerProjectPaths(options["worker-project"]);
  let appBinary = options.app ? packagedBinary(options.app) : null;
  if (options.app && !appBinary) throw new Error(`no executable inside ${options.app}`);
  const devBinary = appBinary ? null : electronBinary();
  if (!appBinary && !devBinary) {
    throw new Error("no Electron binary: run `pnpm install` for this checkout, set ELECTRON_OVERRIDE_DIST_PATH/OMB_VERIFY_ELECTRON, or pass --app");
  }

  const root = fixtureRoot();
  const evidence = join(root, "evidence");
  const receipt = {
    startedAt: new Date().toISOString(),
    app: options.app ? "packaged" : "checkout",
    scope: { accountGateway: "real selected Worker project", modelUpstream: "synthetic loopback fixture", realModelAcceptance: false },
    workerProject,
    binary: appBinary ?? devBinary,
    origin: null,
    steps: [],
    screenshots: [],
    errors: [],
    accounts: {},
    balance: {},
    ledger: {},
    files: {},
    processes: {},
  };
  const record = (step, detail = {}) => receipt.steps.push({ step, at: Date.now(), ...detail });
  const capture = async (page, name) => {
    const file = join(evidence, `${name}.png`);
    writeFileSync(file, await page.screenshot());
    receipt.screenshots.push(file);
    return file;
  };
  /** The account bridge's own state, with no credential anywhere in it. */
  const accountSnapshot = async target => {
    if (!target) return null;
    return await target.evaluate(`window.ogb?.productAccount?.state?.().then(state => ({
      auth: state.auth,
      runtime: state.runtime,
      ai: state.ai ? { state: state.ai.state, unit: state.ai.unit, availableMicroPoints: state.ai.availableMicroPoints, reservedMicroPoints: state.ai.reservedMicroPoints } : null,
      errorCode: state.errorCode ?? null,
      email: state.user?.email ?? null,
    }))`).catch(() => null);
  };

  let worker, app, page, gate, liveGate;
  try {
    console.log("starting the real Worker (Miniflare + D1 + EMAIL + egress)…");
    worker = await startWorkerFixture({ root: join(root, "worker-run"), mail: !options.password, workerProject: workerProject.root,
      log: line => console.log(`  worker: ${line}`) });
    receipt.origin = worker.origin;
    trustFixtureCertificate(worker.certPath);
    if (options["bundled-trust"]) {
      const copy = join(root, "Hezuo Product.app");
      cpSync(options.app, copy, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(copy, "Contents", "Resources", "product-service.json"), JSON.stringify({
        version: 2, origin: worker.origin, ca: readFileSync(worker.certPath, "utf8"),
      }));
      appBinary = packagedBinary(copy);
      receipt.binary = appBinary;
      receipt.bundledTrust = { enabled: true, environmentCa: false };
    }

    const debugPort = Number(options.port) || await freePort();
    console.log(`launching ${appBinary ?? devBinary} (debugger on 127.0.0.1:${debugPort})…`);
    app = launchApp({ appBinary, devBinary, root, origin: worker.origin, certPath: options["bundled-trust"] ? null : worker.certPath, debugPort, verbose: options.verbose });

    // ---------- 1. The real account window: email → code → pending ----------
    const gateTarget = await waitForPage(debugPort, /\/product-account\.html/, { description: "account window" });
    gate = await attachPage(gateTarget);
    liveGate = gate;
    await gate.until("document.querySelector('[data-product-account-window]')", { label: "account window mounted" });
    assert.equal(await gate.evaluate("document.querySelector('[data-product-account-window]').dataset.productAccountWindow"), "sign-in");
    await capture(gate, "01-account-sign-in");

    if (options.password) {
      console.log(`creating ${ACCOUNT_A} through the password form (no mail transport)…`);
      await gate.click("Create an account", clickButtonByText("Create an account"));
      await gate.evaluate(fillField('input[type="email"]', ACCOUNT_A));
      await gate.evaluate(fillField('input[autocomplete="new-password"]', PASSWORD));
      await gate.evaluate(`(() => {
        const fields = document.querySelectorAll('input[autocomplete="new-password"]');
        const repeat = fields[1];
        if (!repeat) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(repeat, ${JSON.stringify(PASSWORD)});
        repeat.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      await gate.click("Create an account", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
    } else {
      console.log(`signing in as ${ACCOUNT_A} with the Worker's own email code…`);
      // The gate offers password first; this deployment has mail, so the emailed
      // sign-in form is one button away and stays the fixture's way in.
      await gate.click("Email me a sign-in code", clickButtonByText("Email me a sign-in code"));
      await gate.evaluate(fillField('input[type="email"]', ACCOUNT_A));
      await gate.click("Send code", clickButtonByText("Send code"));
      const codeA = await worker.mail.nextCode();
      await gate.until("Boolean(document.querySelector('input[inputmode=\"numeric\"]'))", { label: "the code field" });
      await gate.evaluate(fillField('input[inputmode="numeric"]', codeA));
      await gate.click("Verify and sign in", `(() => [...document.querySelectorAll("button[type=submit]")].find(button => !button.disabled))()`);
    }
    try {
      await gate.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
        label: "the account window becomes signed in", timeoutMs: 90_000,
      });
    } catch (error) {
      const state = await accountSnapshot(gate);
      throw new Error(`${error.message} (account state: ${JSON.stringify(state)})`);
    }
    record("signed in", { email: ACCOUNT_A, mailCount: worker.mail.count(), state: await accountSnapshot(gate) });

    // The workspace window replaces the gate; its own server child and provider load here.
    const workspaceTarget = await waitForPage(debugPort, /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/, { description: "workspace window", timeoutMs: 120_000 });
    page = await attachPage(workspaceTarget);
    await page.until("Boolean(window.ogb?.productAccount)", { label: "workspace product bridge", timeoutMs: 120_000 });
    await page.until("document.querySelector('[data-sidebar-product-account]')", { label: "the product sidebar", timeoutMs: 120_000 });
    await page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(ACCOUNT_A)}`, { label: "the signed-in email in the sidebar" });
    assert.equal(await page.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_A);
    assert.equal(await page.evaluate("Boolean(window.ogb.productAccount?.state)"), true, "the account bridge is the one main installed");
    receipt.workspaceUrl = workspaceTarget.url;
    receipt.accounts.a = { email: ACCOUNT_A };

    // Pending is the real status the Worker publishes for a never-enabled account.
    await openAccountSettings(page);
    await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account settings page" });
    // The account's own bridge reports the Worker's status; the page shows the same words.
    const pendingState = await page.untilValue("window.ogb.productAccount.state().then(state => state.ai ? state : null)", {
      label: "the Worker's pending status", timeoutMs: 60_000,
    });
    assert.equal(pendingState.ai.state, "pending", `new account status was ${pendingState.ai.state}`);
    const pendingNotice = await page.evaluate("document.querySelector('[data-product-account]')?.textContent ?? ''");
    assert.match(pendingNotice, /Waiting for administrator activation|waiting for.*administrator|等待管理员开通/i, `pending notice was ${JSON.stringify(pendingNotice)}`);
    assert.equal(await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()"), "0.000000");
    assert.match(await page.evaluate("document.querySelector('[data-product-ledger]')?.textContent ?? ''"), /No account activity yet|account history|暂无账户记录/i);
    await capture(page, "02-workspace-pending");
    record("pending status", { notice: pendingNotice, state: await accountSnapshot(page) });

    // ---------- 2. The operator's real bootstrap: whoami → operator id → restart ----------
    console.log("operator bootstrap through the real control plane…");
    const operatorSession = options.password
      ? await signInWithPassword(worker.origin, ACCOUNT_A, PASSWORD)
      : await signIn(worker.origin, ACCOUNT_A, worker.mail);
    const operatorId = operatorSession.user.id;
    await worker.restart([operatorId], { mail: !options.password });
    receipt.operator = { id: operatorId, email: operatorSession.user.email };
    record("operator bootstrap", { id: operatorId });

    // Enable and grant through /v1/operator/ai/*: the same calls the CLI makes.
    const enabled = await operatorSetAccount(operatorSession.client, operatorSession.token, {
      userId: operatorId, enabled: true, reason: "fixture verification enable",
    });
    assert.equal(enabled.account.enabled, true);
    assert.equal(enabled.account.state, "insufficient_balance", "enabled without funds is its own state");
    const granted = await operatorGrant(operatorSession.client, operatorSession.token, {
      userId: operatorId, amountMicroPoints: 1_000_000, reason: "fixture verification grant",
    });
    assert.equal(granted.account.availableMicroPoints, 1_000_000);
    record("operator enable and grant", { availableMicroPoints: granted.account.availableMicroPoints });


    // ---------- 3. Refresh in the app; the account becomes ready ----------
    await page.click("Refresh", clickButtonByText("Refresh"));
    const readyState = await page.untilValue("window.ogb.productAccount.state().then(state => state.ai?.state === 'ready' ? state : null)", {
      label: "the account becomes ready", timeoutMs: 90_000,
    });
    assert.equal(readyState.runtime, "ready", `runtime after readiness was ${readyState.runtime}`);
    // The account's own unit is points, from the gateway through the bridge: no currency ever reaches the page.
    assert.equal(readyState.ai.unit, "points", `the published unit (${JSON.stringify(readyState.ai)})`);
    await page.until("document.querySelector('[data-product-account]')?.textContent?.match(/Your account is ready/i)", {
      label: "the ready notice", timeoutMs: 30_000,
    });
    const readyBalance = await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()");
    assert.equal(readyBalance, points(1_000_000));
    const modelSurface = await page.evaluate("document.querySelector('[data-product-account]')?.textContent ?? ''");
    assert.ok(!modelSurface.includes(MODELS[0].label) && !modelSurface.includes(MODELS[0].id), "account page must not disclose execution models");
    await capture(page, "03-account-ready");
    record("ready status", { balance: readyBalance, state: await accountSnapshot(page) });
    assert.equal(await page.evaluate("window.ogb.computerUsePolicy.get()"), "ask");
    await page.evaluate("document.querySelector('[data-settings-page=computer], [data-settings-section=computer]').click()");
    await page.until("Boolean(document.querySelector('select[aria-label=\"Execute on this computer\"]:not(:disabled)'))", { label: "computer permission control" });
    await page.evaluate(`(() => {
      const select = document.querySelector('select[aria-label="Execute on this computer"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "allow");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await page.until("document.querySelector('select[aria-label=\"Execute on this computer\"]')?.value === 'allow' && !document.querySelector('select[aria-label=\"Execute on this computer\"]')?.disabled", { label: "saved computer permission" });
    assert.equal(await page.evaluate("window.ogb.computerUsePolicy.get()"), "allow");
    await capture(page, "03-computer-permission-allow");
    await page.evaluate("document.querySelector('[data-settings-page=botAccess], [data-settings-section=botAccess]').click()");
    await page.until("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Configure permissions')", { label: "per-bot permission settings" });
    await capture(page, "03-permissions-settings");
    await openAccountSettings(page);
    record("persistent computer permission", { policy: "allow" });

    // The workspace model catalog must be the account's, and the default bot is there.
    await closeSettings(page);
    await page.until("document.querySelectorAll('[data-sidebar-bot-row]').length > 0", { label: "the default Hezuo", timeoutMs: 90_000 });
    await page.until("Boolean(document.querySelector('textarea[aria-label]'))", { label: "the composer" });
    assert.equal(await page.evaluate("document.querySelectorAll('[data-tour=model], [data-testid=model-badge]').length"), 0, "managed chat has no model picker or provider badge");
    const botId = await page.evaluate(`(() => {
      const row = document.querySelector('[data-sidebar-bot-row]');
      return row?.getAttribute('data-sidebar-bot-row') ?? '';
    })()`);
    assert.ok(botId, "the default bot's id");
    receipt.botId = botId;

    // ---------- 4. One hello, billed by the gateway ----------
    const statusBefore = await operatorSession.client.aiStatus(operatorSession.token);
    assert.equal(statusBefore.state, "ready");
    console.log("sending 你好 through the real gateway…");
    await sendMessage(page, "你好");
    await waitForText(page, "Hello from your account.");
    await waitSettled(page);
    const statusAfter = await operatorSession.client.aiStatus(operatorSession.token);
    const helloLedger = await operatorSession.client.aiLedger(operatorSession.token);
    const requests = helloLedger.items.filter(item => item.kind === "request");
    assert.ok(requests.length >= 1, `at least one metered request (${JSON.stringify(requests)})`);
    // The person's own reply is one request at the fixture's exact price; any helper the app runs for itself
    // (a title, for instance) is a separate, separately billed request, never a free side channel.
    const helloRequest = requests.find(item => item.inputTokens === 12 && item.cachedInputTokens === 2 && item.outputTokens === 3);
    assert.ok(helloRequest, `the hello's own request (${JSON.stringify(requests)})`);
    assert.equal(helloRequest.chargedMicroPoints, FIXTURE_CHARGE_MICRO_POINTS, `exact billed amount (${JSON.stringify(helloRequest)})`);
    assert.ok(requests.every(item => item.state === "settled"), "no request is left unreviewed or reserved");
    const totalCharged = requests.reduce((sum, item) => sum + (item.chargedMicroPoints ?? 0), 0);
    assert.equal(statusAfter.availableMicroPoints, statusBefore.availableMicroPoints - totalCharged);
    assert.equal(statusAfter.reservedMicroPoints, 0);
    assert.equal(statusAfter.state, "ready");
    receipt.balance.hello = { before: statusBefore.availableMicroPoints, after: statusAfter.availableMicroPoints, chargedMicroPoints: totalCharged, requestCount: requests.length };
    receipt.ledger.hello = requests;
    receipt.upstream = worker.upstream.state.calls.slice();
    await capture(page, "04-chat-hello");
    record("hello billed", { chargedMicroPoints: helloRequest.chargedMicroPoints, requestCount: requests.length });

    // R01: restart the actual app process, keeping only this disposable profile and Worker.
    // macOS uses Electron's mock keychain here; this does not verify the user's OS keychain.
    const restart = receipt.accountRestart = {
      startedAtMs: Date.now(), finishedAtMs: null, durationMs: null, passed: false,
      credentialStorage: process.platform === "darwin" ? "electron-mock-keychain" : "isolated-platform-storage",
      realOsKeychainVerified: false, previousPid: app.child.pid,
    };
    record("account restart started", { startedAtMs: restart.startedAtMs });
    try {
      await waitSettled(page);
      const idleSnapshot = `(async () => {
        const response = await fetch('/api/bots');
        if (!response.ok) throw new Error('workspace snapshot HTTP ' + response.status);
        const snapshot = await response.json();
        if (snapshot.bots.some(bot => bot.busy) || snapshot.groups.some(group => group.working)) return null;
        return snapshot.bots.find(bot => bot.id === ${JSON.stringify(botId)}) ?? null;
      })()`;
      const beforeRestart = await page.untilValue(idleSnapshot, { label: "idle workspace before app restart", timeoutMs: 120_000 });
      const helloMessages = beforeRestart.messages.filter(message => message.text === "你好" || message.text === "Hello from your account.");
      assert.ok(helloMessages.some(message => message.role === "user" && message.text === "你好"), "saved hello user message");
      assert.ok(helloMessages.some(message => message.role === "bot" && message.text === "Hello from your account."), "saved hello bot message");
      restart.threadId = beforeRestart.threadId;
      restart.messageIds = helloMessages.map(message => message.id);
      restart.before = await accountSnapshot(page);
      await capture(page, "04-restart-before");
      app.child.kill("SIGTERM");
      const stopped = await Promise.race([app.exited, sleep(15_000).then(() => null)]);
      assert.ok(stopped, "app must exit normally before restarting; forced termination is not a pass");
      assert.equal(stopped.code, 0, `normal app exit (${JSON.stringify(stopped)})`);
      restart.exit = stopped;
      restart.previousAppLogTail = app.logs();
      page.close(); gate?.close();
      page = null; gate = null; liveGate = null;
      app = launchApp({ appBinary, devBinary, root, origin: worker.origin, certPath: options["bundled-trust"] ? null : worker.certPath, debugPort, verbose: options.verbose });
      restart.reopenedPid = app.child.pid;
      assert.notEqual(restart.reopenedPid, restart.previousPid, "a new app process was launched");
      const reopenedTarget = await waitForPage(debugPort, /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/, { description: "workspace restored after app restart", timeoutMs: 120_000 });
      page = await attachPage(reopenedTarget);
      await page.until(`window.ogb?.productAccount?.state().then(state => state.auth === 'signed_in' && state.runtime === 'ready' && state.user?.email === ${JSON.stringify(ACCOUNT_A)})`, {
        label: "same account restored without signing in", timeoutMs: 120_000,
      });
      await page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(ACCOUNT_A)}`, { label: "restored account sidebar" });
      await waitForText(page, "你好");
      await waitForText(page, "Hello from your account.");
      await waitSettled(page);
      const afterRestart = await page.untilValue(idleSnapshot, { label: "restored idle conversation", timeoutMs: 120_000 });
      assert.equal(afterRestart.threadId, restart.threadId, "restart restores the original thread");
      for (const expected of helloMessages) {
        assert.ok(afterRestart.messages.some(message => message.id === expected.id && message.role === expected.role && message.text === expected.text), `restart restores original message ${expected.id}`);
      }
      restart.after = await accountSnapshot(page);
      await capture(page, "04-restart-restored");
      restart.passed = true;
    } finally {
      restart.finishedAtMs = Date.now();
      restart.durationMs = restart.finishedAtMs - restart.startedAtMs;
      record("account restart finished", { ...restart });
    }
    // ---------- 5. Real MCP write, approval required ----------
    console.log("adding the fixture MCP server and asking for a file write…");
    const allowedArtifact = join(root, "allowed-artifact.txt");
    const startedMarker = join(root, "mcp-started.txt");
    const mcpScript = join(ROOT, "scripts", "product-fixture", "mcp-write-server.mjs");
    await workspaceApi(page, "POST", "/api/mcp/servers", {
      name: "fixture-writer", command: process.execPath, args: [mcpScript],
      env: { FIXTURE_MCP_ARTIFACT: allowedArtifact, FIXTURE_MCP_STARTED: startedMarker }, enabled: true,
    });
    // A new server is saved off until it answers; the person turns it on, as in Settings.
    await workspaceApi(page, "PATCH", "/api/mcp/servers/fixture-writer", { enabled: true });
    await workspaceApi(page, "PATCH", `/api/bots/${botId}`, { mcpServers: ["fixture-writer"], approvalMode: "ask" });
    worker.upstream.state.scenario = "tool";
    await sendMessage(page, "Write the verification artifact with the file tool.");
    await page.until("Boolean([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "the approval card", timeoutMs: 120_000 });
    assert.equal(existsSync(allowedArtifact), false, "no file exists before approval");
    assert.equal(existsSync(startedMarker), true, "the MCP server really started");
    await capture(page, "05-approval-pending");
    record("approval pending", { artifactExists: false });

    await page.click("Allow once", clickButtonByText("Allow once"));
    await waitForText(page, "The file is written.");
    await waitSettled(page);
    assert.equal(existsSync(allowedArtifact), true, "the tool wrote its file");
    assert.equal(readFileSync(allowedArtifact, "utf8"), "verified");
    receipt.files.allowed = { path: allowedArtifact, content: readFileSync(allowedArtifact, "utf8") };
    await capture(page, "06-chat-tool-allowed");
    record("tool allowed", { artifact: "verified" });

    // ---------- 6. Denial writes nothing ----------
    console.log("denying the same tool…");
    const deniedArtifact = join(root, "denied-artifact.txt");
    const deniedMarker = join(root, "mcp-denied-started.txt");
    await workspaceApi(page, "POST", "/api/mcp/servers", {
      name: "fixture-denier", command: process.execPath, args: [mcpScript],
      env: { FIXTURE_MCP_ARTIFACT: deniedArtifact, FIXTURE_MCP_STARTED: deniedMarker }, enabled: true,
    });
    await workspaceApi(page, "PATCH", "/api/mcp/servers/fixture-denier", { enabled: true });
    await workspaceApi(page, "PATCH", `/api/bots/${botId}`, { mcpServers: ["fixture-denier"], approvalMode: "ask" });
    worker.upstream.state.scenario = "deny";
    await sendMessage(page, "Write the verification artifact again.");
    await page.until("Boolean([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "the second approval card", timeoutMs: 120_000 });
    assert.equal(existsSync(deniedArtifact), false);
    await page.click("Deny", clickButtonByText("Deny"));
    await waitForText(page, "The write was denied.");
    await waitSettled(page);
    assert.equal(existsSync(deniedArtifact), false, "a denied call writes nothing");
    receipt.files.denied = { path: deniedArtifact, exists: false };
    await capture(page, "07-chat-tool-denied");
    record("tool denied", { artifactExists: false });

    // Every tool round is separate metered requests, not one chat charge.
    const toolLedger = await operatorSession.client.aiLedger(operatorSession.token);
    const metered = toolLedger.items.filter(item => item.kind === "request");
    assert.ok(metered.length >= 5, `each model request is billed separately (got ${metered.length})`);
    assert.ok(metered.every(item => item.state === "settled"));
    receipt.ledger.tool = metered.map(item => ({ id: item.id, state: item.state, chargedMicroPoints: item.chargedMicroPoints, model: item.model }));
    receipt.upstreamCalls = worker.upstream.state.calls.slice();
    record("separate metering", { requests: metered.length });

    // ---------- 7. The account page shows the gateway's own numbers ----------
    await openAccountSettings(page);
    await page.until("Boolean(document.querySelector('[data-product-ledger-entry]'))", { label: "ledger rows", timeoutMs: 60_000 });
    // The page's own Refresh re-reads the gateway; then the shown figures are the gateway's latest.
    await page.click("Refresh", clickButtonByText("Refresh"));
    await page.untilValue("window.ogb.productAccount.state().then(state => state.ai ? state : null)", { label: "the refreshed account status" });
    const current = await operatorSession.client.aiStatus(operatorSession.token);
    await page.untilValue(`window.ogb.productAccount.state().then(state => Math.abs((state.ai?.availableMicroPoints ?? -1) - ${current.availableMicroPoints}) <= 0)`, {
      label: "the page's balance equals the gateway's",
    });
    const shownBalance = await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()");
    const shownReserved = await page.evaluate("document.querySelector('[data-product-reserved]').textContent.trim()");
    assert.equal(shownBalance, points(current.availableMicroPoints));
    assert.equal(shownReserved, points(current.reservedMicroPoints));
    assert.equal(await page.evaluate("document.querySelectorAll('[data-product-ledger-review]').length"), 0, "no request is awaiting review");
    receipt.balance.final = { availableMicroPoints: current.availableMicroPoints, reservedMicroPoints: current.reservedMicroPoints };
    await capture(page, "08-account-ledger");
    record("account page", { balance: shownBalance, reserved: shownReserved });

    // ---------- 8. Sign out, account B: separate workspace, insufficient balance ----------
    console.log("signing out and signing in as a second account…");
    await signOutWorkspace(page);
    const gateTargetAfterA = await waitForPage(debugPort, /\/product-account\.html/, { description: "the account window after sign-out", timeoutMs: 120_000 });
    const gateAfterA = await attachPage(gateTargetAfterA);
    liveGate = gateAfterA;
    await gateAfterA.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'sign-in'", {
      label: "the gate after A", timeoutMs: 120_000,
    });
    await capture(gateAfterA, "09-signed-out");

    const openB = options.password
      ? await signUpThroughPasswordGate(gateAfterA, ACCOUNT_B, PASSWORD)
      : await signInThroughGate(gateAfterA, ACCOUNT_B, worker.mail);
    assert.equal(openB.workspace, true);
    const pageB = openB.page;
    await pageB.until("document.querySelector('[data-sidebar-product-email]')?.textContent?.trim()", { label: "B's sidebar" });
    assert.equal(await pageB.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_B);
    const bodyB = await pageB.evaluate("document.body.innerText");
    assert.equal(bodyB.includes("Hello from your account."), false, "B must not see A's transcript");
    // B is registered by signing in; the operator then enables it without funding, so the real
    // insufficient-balance state (no personal key, no SQL) is what B's own page shows.
    const lookupB = await operatorLookup(operatorSession.client, operatorSession.token, ACCOUNT_B);
    if (!lookupB) throw new Error("the operator lookup did not find the second fixture account");
    const enabledB = await operatorSetAccount(operatorSession.client, operatorSession.token, {
      userId: lookupB.account.userId, enabled: true, reason: "fixture verification enable without funds",
    });
    assert.equal(enabledB.account.state, "insufficient_balance", "enabled without funds is insufficient_balance");
    await openAccountSettings(pageB);
    await pageB.click("Refresh", clickButtonByText("Refresh"));
    await pageB.untilValue("window.ogb.productAccount.state().then(state => state.ai?.state === 'insufficient_balance' ? state : null)", {
      label: "B's insufficient-balance status", timeoutMs: 90_000,
    });
    const noticeB = await pageB.evaluate("document.querySelector('[data-product-account]').textContent.trim()");
    assert.equal(await pageB.evaluate("document.querySelector('[data-product-balance]').textContent.trim()"), "0.000000");
    assert.equal(await pageB.evaluate("window.ogb.computerUsePolicy.get()"), "ask", "B must not inherit A's computer permission");
    assert.equal((await pageB.evaluate("window.ogb.productAccount.operatorStatus()")).eligible, false);
    assert.equal((await pageB.evaluate("window.ogb.productAccount.grantMaximum()")).outcome, "failed");
    await capture(pageB, "10-account-b-insufficient");
    receipt.accounts.b = { email: ACCOUNT_B, notice: noticeB, seesA: false };
    await closeSettings(pageB);

    // A turn must be refused before any upstream call.
    const callsBeforeRefusal = worker.upstream.state.calls.length;
    await pageB.until("Boolean(document.querySelector('textarea[aria-label]'))", { label: "B's composer" });
    await sendMessage(pageB, "你好");
    await pageB.until("Boolean(document.querySelector('[role=alert]'))", {
      label: "the balance refusal", timeoutMs: 120_000,
    });
    const refusal = await pageB.evaluate("(document.querySelector('[role=alert]')?.textContent ?? document.body.innerText).slice(0, 600)");
    assert.equal(worker.upstream.state.calls.length, callsBeforeRefusal, "no upstream call for an unfunded account");
    receipt.balance.insufficient = { notice: noticeB, refusal, upstreamCalls: worker.upstream.state.calls.length };
    await capture(pageB, "11-chat-insufficient");
    record("insufficient balance", { refusal });

    // ---------- 9. Back to A: its own history returns ----------
    await signOutWorkspace(pageB);
    const gateAgain = await waitForPage(debugPort, /\/product-account\.html/, { description: "the gate after B", timeoutMs: 120_000 });
    const gatePage = await attachPage(gateAgain);
    liveGate = gatePage;
    await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'sign-in'", {
      label: "the gate after B", timeoutMs: 120_000,
    });
    const backA = options.password
      ? await signInThroughPasswordGate(gatePage, ACCOUNT_A, PASSWORD)
      : await signInThroughGate(gatePage, ACCOUNT_A, worker.mail);
    const pageA = backA.page;
    await pageA.until("document.querySelector('[data-sidebar-product-email]')?.textContent?.trim()", { label: "A's sidebar again" });
    assert.equal(await pageA.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_A);
    await pageA.until("document.body.innerText.includes('Hello from your account.')", { label: "A's own history", timeoutMs: 90_000 });
    assert.equal(await pageA.evaluate("window.ogb.computerUsePolicy.get()"), "allow", "A's permission persists across workspace restart");
    receipt.accounts.aRestored = true;
    await capture(pageA, "12-account-a-returned");
    record("account switch", { isolated: true, restored: true });

    // ---------- 10. Responsive layout: the widths, and the phone's bot list ----------
    // The product's three bands: the fixed 260/240px list, and below 800px a bot list that is off-screen until asked
    // for. Every assertion reads the real painted geometry, so a panel caught half-way out cannot pass as a layout.
    // A's settings sheet from the account page is a sheet over the workspace, not a column of it.
    assert.equal(await pageA.evaluate("Boolean(document.querySelector('[role=dialog] [data-product-account]'))"), false, "A's account sheet is closed before the layout is measured");
    // The bot panel holds details, activity, library and the computer, and the chat's avatar pill opens and closes it.
    // Whatever the workspace restored, a wide window still gives the chat its 420px beside the 260px list and the panel.
    const panelWasOpen = await pageA.evaluate("Boolean(document.querySelector('[data-bot-panel]'))");
    if (panelWasOpen) {
      await pageA.click("the chat's bot pill", `(() => document.querySelector('[data-chathead-pill]'))()`);
      await pageA.until("!document.querySelector('[data-bot-panel]')", { label: "the restored bot panel closed" });
    }
    receipt.botPanelRestored = panelWasOpen;
    const drawerState = `(() => {
      const list = document.querySelector('#product-bot-list');
      const menu = document.querySelector('button[aria-controls="product-bot-list"]');
      const box = list?.getBoundingClientRect();
      return {
        expanded: menu?.getAttribute('aria-expanded') ?? null,
        inert: list?.inert === true,
        right: box ? Math.round(box.right) : null,
        width: box ? Math.round(box.width) : null,
        scrim: Boolean(document.querySelector('[data-sidebar-drawer-scrim]')),
        focus: document.activeElement === menu ? "menu" : document.activeElement?.closest?.('[data-sidebar-drawer-close]') ? "close" : (document.activeElement?.tagName ?? ""),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`;
    for (const [width, height] of [[1440, 900], [1000, 800], [390, 844]]) {
      await pageA.setViewport(width, height);
      await pageA.until(`document.querySelector('[data-sidebar]')?.inert === ${width < 800}`, { label: "sidebar responsive focus state" });
      const overflow = await pageA.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      assert.ok(overflow <= 1, `no horizontal overflow at ${width}x${height} (overflow ${overflow}px)`);
      // The chat is what a person reads: the composer must be the thing under its own pixels, not a hidden panel's.
      const covered = await pageA.evaluate(`(() => {
        const chat = document.querySelector('[data-product-chat]');
        if (!chat) return "no chat";
        const field = [...chat.querySelectorAll('textarea')].find(node => node.getBoundingClientRect().width > 0);
        const box = field?.getBoundingClientRect();
        if (!box) return "no composer";
        const points = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + 6, box.bottom - 3], [box.right - 6, box.bottom - 3]];
        return points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && chat.contains(hit)); })
          ? "" : "the composer is behind another surface";
      })()`);
      assert.equal(covered, "", `${width}x${height}: ${covered}`);
      const list = await pageA.evaluate(drawerState);
      if (width < 800) {
        assert.equal(list.inert, true, "a phone's shut bot list takes no focus");
        assert.ok(list.right !== null && list.right <= 0, `a phone's shut bot list is off-screen (right ${list.right})`);
      }
      await capture(pageA, `13-layout-${width}x${height}`);
      record("viewport", { width, height, overflow, listWidth: list.width, composerClear: true });
    }

    // Wide: the bot panel is a real third column, opened from the chat's avatar pill and closed from it again. The
    // computer, tasks and library live in its tabs: the header carries no buttons of their own for them.
    await pageA.setViewport(1440, 900);
    await pageA.until(`!!document.querySelector('[data-chathead-pill]')`, { label: "the wide chat header" });
    assert.equal(await pageA.evaluate(`Boolean(document.querySelector('[data-product-work-entry]'))`), false, "the chat header has no work-panel buttons");
    const panelGeometry = `(() => {
      const panel = document.querySelector('[data-bot-panel]');
      const chat = document.querySelector('[data-product-chat]');
      if (!panel || !chat) return null;
      // Only once its entrance and width transition have finished: a panel mid-slide is not a layout.
      if (panel.getAnimations().some(animation => animation.playState === "running")) return null;
      const theirs = panel.getBoundingClientRect();
      const ours = chat.getBoundingClientRect();
      return { tab: panel.dataset.tab, role: panel.getAttribute('role'), width: Math.round(theirs.width), right: Math.round(theirs.right), chat: Math.round(ours.width), scrim: Boolean(document.querySelector('[data-product-work-scrim]')), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`;
    const pressEscape = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await pageA.connection.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
    };
    const openComputerTab = async label => {
      await pageA.click(`the chat's bot pill (${label})`, `(() => document.querySelector('[data-chathead-pill]'))()`);
      await pageA.until(`document.querySelector('[data-bot-panel]')?.dataset.tab === "details"`, { label: "the bot panel on its details tab" });
      await pageA.click("the computer tab", `(() => document.querySelector('[data-panel-tab="computer"]'))()`);
      await pageA.until(`document.querySelector('[data-bot-panel]')?.dataset.tab === "computer"`, { label: "the bot panel on its computer tab" });
    };
    await pageA.click("the chat's bot pill", `(() => document.querySelector('[data-chathead-pill]'))()`);
    await pageA.until(`document.querySelector('[data-bot-panel]')?.dataset.tab === "details"`, { label: "the bot panel on its details tab" });
    await pageA.untilValue(panelGeometry, { label: "the details tab settled" });
    await capture(pageA, "13-layout-1440x900-details-tab");
    await pageA.click("the activity tab", `(() => document.querySelector('[data-panel-tab="activity"]'))()`);
    await pageA.until(`document.querySelector('[data-bot-panel]')?.dataset.tab === "activity"`, { label: "the bot panel on its activity tab" });
    await pageA.untilValue(panelGeometry, { label: "the activity tab settled" });
    await capture(pageA, "13-layout-1440x900-activity-tab");
    await pageA.click("the computer tab", `(() => document.querySelector('[data-panel-tab="computer"]'))()`);
    await pageA.until(`document.querySelector('[data-bot-panel]')?.dataset.tab === "computer"`, { label: "the bot panel on its computer tab" });
    const docked = await pageA.untilValue(panelGeometry, { label: "the docked bot panel at 1440x900" });
    assert.ok(docked.right >= 1438, `the bot panel ends at the window's right edge (${docked.right})`);
    assert.ok(docked.width >= 440 && docked.width <= 480, `the computer tab is the 460px column (${docked.width}px)`);
    assert.ok(docked.chat >= 420, `the chat keeps its 420px beside the panel (${docked.chat}px)`);
    assert.ok(docked.overflow <= 1, `the docked panel adds no horizontal overflow (${docked.overflow}px)`);
    assert.equal(await pageA.evaluate(`Boolean(document.querySelector('[data-bot-panel] [data-computer-panel]'))`), true, "the computer tab embeds the computer panel");
    await capture(pageA, "13-layout-1440x900-work-panel");
    await pageA.click("the chat's bot pill again", `(() => document.querySelector('[data-chathead-pill]'))()`);
    await pageA.until("!document.querySelector('[data-bot-panel]')", { label: "the bot panel closed again" });
    receipt.botPanel = docked;
    record("bot panel", docked);

    // Mid: the computer tab is a drawer over the chat, and Escape gives the chat back.
    await pageA.setViewport(1000, 800);
    await pageA.until(`!!document.querySelector('[data-chathead-pill]')`, { label: "the medium chat header" });
    assert.equal(await pageA.evaluate(`Boolean(document.querySelector('[data-product-work-entry]'))`), false, "the medium chat header has no work-panel buttons");
    await openComputerTab("mid");
    const overlay = await pageA.untilValue(panelGeometry, { label: "the bot panel as a drawer at 1000x800" });
    assert.equal(overlay.role, "dialog", "below 1200px the bot panel is a dialog over the chat");
    assert.ok(overlay.right >= 998, `the drawer is flush with the window's right edge (${overlay.right})`);
    assert.ok(overlay.width >= 360 && overlay.width <= 1000 - 32, `the drawer keeps the computer tab's width, inside the window (${overlay.width}px)`);
    await capture(pageA, "13-layout-1000x800-work-panel");
    await pressEscape();
    await pageA.until("!document.querySelector('[data-bot-panel]')", { label: "Escape closed the mid-width bot panel drawer" });
    receipt.botPanelDrawer = overlay;
    record("bot panel drawer", overlay);

    // The phone's list opens over the chat, dims it, and both Escape and its own close button put it away again.
    await pageA.setViewport(390, 844);
    const shut = await pageA.evaluate(drawerState);
    assert.equal(shut.scrim, false, "a shut bot list paints no scrim");
    const openDrawer = async () => {
      await pageA.click("the bot list button", "document.querySelector('button[aria-controls=\"product-bot-list\"]')");
      // Fully out, not mid-slide: a panel caught half-way out is exactly the defect this checks for.
      return await pageA.untilValue(`(() => { const state = ${drawerState};
        return state.expanded === "true" && state.width >= 200 && state.right >= state.width - 1 ? state : null; })()`, { label: "the bot list drawn over the chat" });
    };
    const openedByButton = await openDrawer();
    assert.equal(openedByButton.scrim, true, "an open bot list dims the chat behind it");
    assert.equal(openedByButton.inert, false, "an open bot list takes focus");
    assert.ok(openedByButton.width < 390 - 24, `the drawer leaves the chat visibly beside it (${openedByButton.width}px)`);
    assert.ok(openedByButton.overflow <= 1, `the open drawer adds no horizontal overflow (${openedByButton.overflow}px)`);
    await capture(pageA, "13-layout-390x844-drawer-open");
    const closeDrawerWith = async (how) => {
      if (how === "Escape") {
        for (const type of ["keyDown", "keyUp"]) {
          await pageA.connection.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        }
      } else {
        await pageA.click("the bot list's close button", "document.querySelector('[data-sidebar-drawer-close]')");
      }
      const closed = await pageA.untilValue(`(() => { const state = ${drawerState};
        return state.expanded === "false" && state.right <= 0 && state.inert ? state : null; })()`, { label: `the bot list closed by ${how}` });
      // The button that opened it takes focus back, so the keyboard is where it was.
      const refocused = await pageA.untilValue(`(() => { const state = ${drawerState}; return state.focus === "menu" ? state : null; })()`, { label: `focus returned after ${how}`, timeoutMs: 5_000 }).catch(() => null);
      return { ...closed, refocused: refocused?.focus ?? null };
    };
    const afterEscape = await closeDrawerWith("Escape");
    assert.equal(afterEscape.refocused, "menu", "Escape returns focus to the bot list button");
    await openDrawer();
    const afterCloseButton = await closeDrawerWith("close button");
    assert.equal(afterCloseButton.refocused, "menu", "the close button returns focus to the bot list button");
    receipt.drawer = { width: openedByButton.width, scrim: openedByButton.scrim, escape: afterEscape.refocused, closeButton: afterCloseButton.refocused };
    record("viewport drawer", receipt.drawer);
    await pageA.setViewport(1440, 900);

    const operatorCredit = await pageA.evaluate("window.ogb.productAccount.operatorStatus()");
    assert.equal(operatorCredit.eligible, true);
    const maximumCredit = await pageA.evaluate("window.ogb.productAccount.grantMaximum()");
    assert.equal(maximumCredit.outcome, "granted");
    assert.equal(maximumCredit.amountMicroPoints, operatorCredit.maxGrantMicroPoints);
    const afterMaximum = await operatorSession.client.aiStatus(operatorSession.token);
    assert.equal(BigInt(afterMaximum.availableMicroPoints) + BigInt(afterMaximum.reservedMicroPoints), BigInt(Number.MAX_SAFE_INTEGER));
    const repeatedMaximum = await pageA.evaluate("window.ogb.productAccount.grantMaximum()");
    assert.equal(repeatedMaximum.outcome, "already_max");
    receipt.operatorCredit = { outcome: maximumCredit.outcome, amountMicroPoints: maximumCredit.amountMicroPoints, repeated: repeatedMaximum.outcome };

    // ---------- 11. Sign-out revokes live model tokens ----------
    await signOutWorkspace(pageA);
    await waitForPage(debugPort, /\/product-account\.html/, { description: "the gate after the final sign-out", timeoutMs: 120_000 });
    // The account session itself is gone now; the token check below reads the database, not an API.
    // Revocation is a network call main starts as it stops the runtime; poll briefly for it.
    let tokens = { n: 1 };
    for (let attempt = 0; attempt < 60 && tokens.n !== 0; attempt++) {
      tokens = await worker.db().prepare(
        "SELECT COUNT(*) AS n FROM account_ai_tokens WHERE owner_user_id = ? AND revoked_at IS NULL AND expires_at > ?",
      ).bind(operatorId, Date.now()).first();
      if (tokens.n !== 0) await sleep(250);
    }
    receipt.processes.liveModelTokens = tokens.n;
    assert.equal(tokens.n, 0, "sign-out left no usable model token");
    const sessions = await worker.db().prepare(
      'SELECT COUNT(*) AS n FROM "session" WHERE id IN (SELECT session_id FROM account_ai_tokens WHERE owner_user_id = ?)'
    ).bind(operatorId).first();
    receipt.processes.liveAccountSessions = sessions.n;
    assert.equal(sessions.n, 0, "sign-out invalidated every application account session");

    // ---------- 12. Storage facts: encrypted login, per-account roots, untouched legacy ----------
    const userData = join(root, "user-data");
    assert.equal(existsSync(join(userData, "product-account.bin")), false, "sign-out removed the encrypted login record");
    const accountRoots = (await import("node:fs")).readdirSync(join(userData, "product-accounts"));
    assert.equal(accountRoots.length, 2, `one workspace root per account (${accountRoots.join(", ")})`);
    assert.equal(existsSync(join(root, "home", ".hezuo")), false, "no legacy ~/.hezuo was created or read");
    receipt.userData = { loginRecordRemoved: true, accountRoots: accountRoots.length, legacyUntouched: true };

    receipt.mailCount = worker.mail.count();
    receipt.models = MODELS;
    record("finished");
  } catch (error) {
    receipt.errors.push(error?.stack ?? String(error));
    const failed = await accountSnapshot(page) ?? await accountSnapshot(liveGate ?? gate);
    if (page) await capture(page, "failure-workspace").catch(() => {});
    if (failed) receipt.failureState = failed;
    receipt.failureStorage = {
      loginRecord: existsSync(join(root, "user-data", "product-account.bin")),
      accountRoots: existsSync(join(root, "user-data", "product-accounts")),
    };
    if (app) receipt.processes.appLogTail = app.logs();
  } finally {
    gate?.close(); page?.close();
    if (app && app.child.exitCode === null) {
      app.child.kill("SIGTERM");
      const stopped = await Promise.race([app.exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!stopped) app.child.kill("SIGKILL");
      receipt.processes.appExit = await Promise.race([app.exited, sleep(3_000).then(() => null)]);
      receipt.processes.appLogTail = app.logs();
    }
    await worker?.close().catch(() => {});
    if (worker) {
      receipt.inferenceRequests = worker.inferenceRequests;
      receipt.inferenceLog = worker.inferenceLog;
      const rejectedBilling = worker.inferenceRequests.find(request => request.status === 400
        && request.errorCode === "invalid_request" && request.fields.includes("billing"));
      if (rejectedBilling) receipt.compatibilityDiagnostic = "The desktop sent billing, but this checkout Worker rejected the request. Check the gateway billing contract; do not strip the desktop budget to make this fixture pass.";
    }
    receipt.passed = receipt.errors.length === 0;
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (!options.keep) {
      for (const name of ["user-data", "home", "bin"]) {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    console.log(`\nevidence: ${evidence}`);
    console.log(`receipt: ${join(evidence, "receipt.json")}`);
    console.log(`result: ${receipt.passed ? "passed" : "failed"}`);
    if (!receipt.passed) console.log(receipt.errors.join("\n"));
  }
  if (!receipt.passed) process.exitCode = 1;
}

/** Opens Settings → Your account from the product sidebar's account button. */
async function openAccountSettings(page) {
  // The account button main marks for this purpose, never "the first button in the footer" (that is Automations).
  await page.until("Boolean(document.querySelector('[data-product-account-open]'))", { label: "the product account button" });
  if (!await page.evaluate("Boolean(document.querySelector('[role=dialog]'))")) {
    await page.evaluate("(() => { document.querySelector('[data-product-account-open]').click(); return true; })()");
  }
  await page.until("Boolean(document.querySelector('[role=dialog]'))", { label: "the settings dialog" });
  // Simple mode lists pages (Usage & billing) rather than the advanced per-section rail; either way the
  // account page must end up rendered, and opening the sidebar account button normally lands there.
  await page.until("Boolean(document.querySelector('[data-settings-section=account], [data-settings-page]'))", { label: "the settings navigation" });
  if (!await page.evaluate("Boolean(document.querySelector('[data-product-account]'))")) {
    const clicked = await page.evaluate(`(() => {
      const direct = document.querySelector('[data-settings-section=account]');
      if (direct) { direct.click(); return "section"; }
      if (document.querySelector('[data-product-account]')) return "already";
      const pageButton = [...document.querySelectorAll('[data-settings-page]')]
        .find(button => button.getAttribute("data-settings-page") === "billing");
      if (!pageButton) return "";
      pageButton.click();
      return "billing";
    })()`);
    if (clicked === "billing") {
      // Usage & billing opens on Usage; the account page is its own section in the mobile selector.
      const selected = await page.evaluate(`(() => {
        const select = document.querySelector('[role=dialog] select');
        const option = [...(select?.options ?? [])].find(item => item.value === "account");
        if (!select || !option) return false;
        select.value = "account";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      if (!selected) {
        await page.evaluate(`(() => {
          const section = document.querySelector('[data-settings-section=account]');
          if (section) section.click();
          return true;
        })()`);
      }
    }
  }
  await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account page" });
}

async function closeSettings(page) {
  await page.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return true;
    const close = [...dialog.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Close settings");
    if (!close) return false;
    close.click();
    return true;
  })()`);
  await page.until("!document.querySelector('[role=dialog]')", { label: "settings closed", timeoutMs: 20_000 });
}

/** Types and sends through the app's own composer (its Enter handler). */
async function sendMessage(page, text) {
  const filled = await page.evaluate(`(() => {
    const field = document.querySelector("textarea[aria-label]");
    if (!field) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.focus();
    return true;
  })()`);
  if (!filled) throw new Error("the composer is not on screen");
  await page.evaluate(`(() => {
    const field = document.querySelector("textarea[aria-label]");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await page.until('(document.querySelector("textarea[aria-label]")?.value ?? "").length === 0', {
    label: "the composer clears after send", timeoutMs: 30_000,
  });
}

async function waitForText(page, text, timeoutMs = 120_000) {
  await page.until(`document.body.innerText.includes(${JSON.stringify(text)})`, { label: `the text ${JSON.stringify(text)}`, timeoutMs });
}

/** No pending approval and no Stop control: the turn is over. */
async function waitSettled(page, timeoutMs = 120_000) {
  await page.until("!([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "no pending approval", timeoutMs });
  await page.until("!document.querySelector('[data-composer-stop], button[aria-label=\"Stop this turn\"]')", {
    label: "the turn finished", timeoutMs,
  });
}

/** A mutating workspace call through the app's own page (the account session
 * adds the desktop owner header), never a direct Node request. */
async function workspaceApi(page, method, path, body) {
  const result = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    return { status: response.status, text: (await response.text()).slice(0, 600) };
  })()`);
  if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${path} refused (${result.status}): ${result.text}`);
  return result;
}

/** Sign out from the workspace: the account page owns that button. */
async function signOutWorkspace(page) {
  await openAccountSettings(page);
  await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account page" });
  // The page's own Sign out (the sidebar has none in a product workspace).
  await page.evaluate(`(() => {
    const scope = document.querySelector('[data-product-account]');
    const button = [...scope.querySelectorAll("button")].find(candidate => candidate.textContent.trim() === "Sign out");
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Completes the real email-code form in the account window, then waits for the
 * workspace window that main opens for that account. */
/** Creates an account through the password form of a deployment that asks for
 * no emailed code, then waits for that account's workspace window. */
async function signUpThroughPasswordGate(gatePage, email, password) {
  await gatePage.click("Create an account", clickButtonByText("Create an account"));
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.evaluate(fillField('input[autocomplete="new-password"]', password));
  await gatePage.evaluate(`(() => {
    const repeat = document.querySelectorAll('input[autocomplete="new-password"]')[1];
    if (!repeat) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(repeat, ${JSON.stringify(password)});
    repeat.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await gatePage.click("Create an account", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `password sign-up for ${email}`, timeoutMs: 120_000,
  });
  return await workspaceAfterGate(gatePage, email);
}

/** Signs in through the password form itself (the default first screen). */
async function signInThroughPasswordGate(gatePage, email, password) {
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.evaluate(fillField('input[autocomplete="current-password"]', password));
  await gatePage.click("Sign in", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `password sign-in for ${email}`, timeoutMs: 120_000,
  });
  return await workspaceAfterGate(gatePage, email);
}

/** The workspace window main opened for a gate that just signed in, proved by
 * that account's own sidebar line. */
async function workspaceAfterGate(gatePage, email) {
  const debugPort = Number(new URL(gatePage.target.webSocketDebuggerUrl.replace(/^ws:/, "http:")).port);
  const deadline = Date.now() + 150_000;
  const tried = new Set();
  while (Date.now() < deadline) {
    const pages = (await listPages(debugPort).catch(() => []))
      .filter(target => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(target.url) && !tried.has(target.id));
    for (const target of pages) {
      tried.add(target.id);
      const page = await attachPage(target).catch(() => null);
      if (!page) continue;
      const ok = await page.until("Boolean(window.ogb?.productAccount)", { label: `${email}'s bridge`, timeoutMs: 15_000 })
        .then(() => page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(email)}`, {
          label: `${email}'s sidebar`, timeoutMs: 45_000,
        }))
        .then(() => true, () => false);
      if (ok) return { page, url: target.url, workspace: true };
      page.close();
    }
    await sleep(400);
  }
  throw new Error(`no workspace window ever showed ${email}`);
}

async function signInThroughGate(gatePage, email, mailbox) {
  await gatePage.click("Email me a sign-in code", clickButtonByText("Email me a sign-in code"));
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.click("Send code", clickButtonByText("Send code"));
  const code = await mailbox.nextCode();
  await gatePage.until("Boolean(document.querySelector('input[inputmode=\"numeric\"]'))", { label: "the code field" });
  await gatePage.evaluate(fillField('input[inputmode="numeric"]', code));
  await gatePage.click("Verify and sign in", `(() => [...document.querySelectorAll("button[type=submit]")].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `sign-in for ${email}`, timeoutMs: 120_000,
  });
  const debugPort = Number(new URL(gatePage.target.webSocketDebuggerUrl.replace(/^ws:/, "http:")).port);
  // Sign-out closes the previous workspace, so one of the matching pages belongs to this sign-in; the
  // sidebar's own account line is what proves which (both accounts share the same loopback origin).
  const deadline = Date.now() + 150_000;
  // A closed account's page can linger in the debugger list while its window is torn down; never retry the same target.
  const tried = new Set();
  while (Date.now() < deadline) {
    const pages = (await listPages(debugPort).catch(() => []))
      .filter(target => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(target.url) && !tried.has(target.id));
    for (const target of pages) {
      tried.add(target.id);
      const page = await attachPage(target).catch(() => null);
      if (!page) continue;
      const ok = await page.until("Boolean(window.ogb?.productAccount)", { label: `${email}'s bridge`, timeoutMs: 15_000 })
        .then(() => page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(email)}`, {
          label: `${email}'s sidebar`, timeoutMs: 45_000,
        }))
        .then(() => true, () => false);
      if (ok) return { page, url: target.url, workspace: true };
      page.close();
    }
    await sleep(400);
  }
  throw new Error(`no workspace window ever showed ${email}`);
}

await main();
