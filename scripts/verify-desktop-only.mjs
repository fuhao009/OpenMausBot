import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--hezuo-desktop-only-fixture";

async function until(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

if (process.versions.electron) {
  console.log("[desktop-only] ESM fixture entered");
  assert.ok(process.argv.includes(flag));
  const [output, home, url] = process.argv.slice(process.argv.indexOf(flag) + 1);
  const token = process.env.HEZUO_FIXTURE_OWNER;
  delete process.env.HEZUO_FIXTURE_OWNER;
  assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
  const { app, BrowserWindow, session } = await import("electron");
  const { installServerSessions } = await import("../desktop/electron/server-session.mjs");
  console.log(`[desktop-only] Awaiting Electron ready (ready=${app.isReady()})`);
  try {
    await app.whenReady();
    console.log("[desktop-only] Installing owner session");
    installServerSessions({ app, defaultSession: session.defaultSession,
      serverPort: () => Number(new URL(url).port), ownerToken: () => token });
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      callback({ cancel: !request.url.startsWith(`${url}/`) && !request.url.startsWith("data:") });
    });
    const window = new BrowserWindow({ width: 1280, height: 900, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: join(root, "desktop/electron/preload.cjs"),
        additionalArguments: [`--omb-local-origin=${url}`, "--omb-app-version=desktop-only-fixture"] } });
    const failures = [];
    window.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
      failures.push({ code, description, url: failedUrl });
    });
    await window.loadURL(url);
    await until(() => window.webContents.executeJavaScript(
      `Boolean(document.querySelector('#root')?.children.length && document.body.innerText.includes('Fixture Starter'))`),
    "real desktop renderer with seeded bot");
    const observed = await window.webContents.executeJavaScript(`(async () => {
      const api = await fetch('/api/bots');
      const bots = await api.json();
      return { title: document.title, text: document.body.innerText, apiStatus: api.status,
        botCount: bots.bots.length, ownPage: window.ogb?.app?.ownPage,
        resources: performance.getEntriesByType('resource').map(item => item.name),
        scripts: [...document.scripts].map(item => item.src).filter(Boolean),
        styles: [...document.querySelectorAll('link[rel=stylesheet]')].map(item => item.href),
        capabilityInPage: document.documentElement.outerHTML.includes(${JSON.stringify(token)}) };
    })()`);
    assert.equal(observed.apiStatus, 200);
    assert.equal(observed.botCount, 1);
    assert.equal(observed.ownPage, true);
    assert.equal(observed.capabilityInPage, false);
    assert.ok(observed.scripts.some(value => value.startsWith(`${url}/assets/`)), "built application scripts loaded");
    assert.ok(observed.styles.some(value => value.startsWith(`${url}/assets/`)), "built application styles loaded");
    const screenshot = await window.webContents.capturePage();
    assert.equal(screenshot.isEmpty(), false);
    writeFileSync(join(output, "desktop-allowed.png"), screenshot.toPNG());
    const isolated = session.fromPartition("desktop-only-untrusted");
    await assert.rejects(isolated.fetch(`${url}/`), /ERR_BLOCKED_BY_CLIENT|Failed to fetch|net::/);
    writeFileSync(join(output, "electron.json"), JSON.stringify({ passed: true, ...observed, failures }, null, 2));
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
} else {
  const output = mkdtempSync(join(tmpdir(), "hezuo-desktop-only-evidence-"));
  const home = mkdtempSync(join(tmpdir(), "hdo-"));
  process.env.OMB_DATA_DIR = join(home, "module-data");
  const { launchVerificationServer } = await import("./control-omb.ts");
  const { waitForExit, removeTempDir } = await import("../desktop/server/testing/cleanup.ts");
  const { ensureUiBrowser, agentBrowser, sessionEnv } = await import("./testing/control-omb-ui.ts");
  const { closeBrowserSession } = await import("../desktop/server/browser-engine.ts");
  const staticDir = join(root, "dist");
  const token = randomBytes(32).toString("base64url");
  const startup = new AbortController();
  const stop = () => startup.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let fixture;
  let electron;
  let browser;
  let browserEnv;
  let watchdog;
  const checks = [];
  try {
    assert.ok(existsSync(join(staticDir, "index.html")), "Build the actual UI first: pnpm exec vite build desktop");
    browser = await ensureUiBrowser();
    if (startup.signal.aborted) throw new Error("Verification cancelled");
    fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: token },
      startup.signal, undefined, undefined, undefined, undefined, [], undefined, staticDir);
    const url = fixture.info.url;
    mkdirSync(join(home, "electron"), { recursive: true });
    const env = { ...process.env, HOME: join(home, "electron"), USERPROFILE: join(home, "electron"),
      APPDATA: join(home, "electron"), LOCALAPPDATA: join(home, "electron"), HEZUO_FIXTURE_OWNER: token };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = spawn(createRequire(import.meta.url)("electron"),
      [join(root, "scripts/verify-desktop-only.cjs"), flag, output, join(home, "electron"), url],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let electronLog = "";
    for (const stream of [electron.stdout, electron.stderr]) stream.on("data", chunk => {
      electronLog = (electronLog + String(chunk)).slice(-64_000);
    });
    watchdog = setTimeout(() => { void waitForExit(electron, { signal: "SIGTERM", graceMs: 3000 }); }, 60_000);
    const abortElectron = () => { void waitForExit(electron, { signal: "SIGTERM", graceMs: 3000 }); };
    startup.signal.addEventListener("abort", abortElectron, { once: true });
    const code = await new Promise((resolve, reject) => {
      electron.once("error", reject);
      electron.once("exit", value => resolve(value));
    });
    clearTimeout(watchdog);
    startup.signal.removeEventListener("abort", abortElectron);
    writeFileSync(join(output, "electron.log"), electronLog.replaceAll(token, "[redacted]"));
    assert.equal(code, 0, `Electron desktop failed; see ${join(output, "electron.log")}`);
    const desktop = JSON.parse(readFileSync(join(output, "electron.json"), "utf8"));
    assert.equal(desktop.passed, true);
    checks.push("Actual built renderer and API load in production owner session", "Isolated Electron session cannot reach the app");
    const resources = [...new Set([...desktop.scripts, ...desktop.styles])];
    const routes = ["/", "/index.html", "/rail.html", "/product-account.html", "/any/spa/route",
      ...resources.map(value => new URL(value).pathname)];
    for (const route of routes) {
      for (const method of ["GET", "HEAD"]) {
        for (const [capability, headers, expected] of [
          ["absent", {}, 403],
          ["wrong", { "X-Hezuo-Desktop-Owner": "wrong" }, 403],
          ["owner", { "X-Hezuo-Desktop-Owner": token, origin: url }, 200],
        ]) {
          if (method === "HEAD" && capability === "owner") continue;
          const response = await fetch(`${url}${route}`, { method, headers, signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, expected, `${method} ${route} capability=${capability}`);
          if (expected === 403) assert.match(response.headers.get("cache-control") ?? "", /no-store/);
          checks.push(`${method} ${route} capability=${capability}: ${response.status}`);
          await response.body?.cancel();
        }
      }
    }
    for (const headers of [{ "X-Hezuo-Desktop-Owner": "wrong" }, { origin: url }]) {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 403);
    }
    const native = await fetch(`${url}/api/bots`, { signal: AbortSignal.timeout(5000) });
    assert.equal(native.status, 200, "native API remains reachable without browser headers");
    checks.push("Wrong capability and spoofed Origin cannot load UI", "Native API remains available");
    browserEnv = sessionEnv({ home: join(home, "chrome"), session: "d", chrome: browser.chrome });
    mkdirSync(browserEnv.HOME, { recursive: true });
    mkdirSync(browserEnv.TMPDIR, { recursive: true });
    await agentBrowser(browser.binary, browserEnv, ["open", url]);
    const external = await agentBrowser(browser.binary, browserEnv, ["eval", `JSON.stringify({text: document.body.innerText,
      app: Boolean(document.querySelector('#root')), scripts: document.scripts.length})`]);
    const result = typeof external.result === "string" ? JSON.parse(external.result) : external.result;
    assert.equal(result.app, false, "ordinary Chrome must not receive the SPA");
    assert.equal(result.scripts, 0, "ordinary Chrome must not receive app scripts");
    assert.ok(result.text.length > 0, "Chrome renders the refusal");
    await agentBrowser(browser.binary, browserEnv, ["screenshot", join(output, "chrome-denied.png")]);
    const deniedApi = await agentBrowser(browser.binary, browserEnv,
      ["eval", "fetch('/api/bots').then(response => response.status)"]);
    assert.equal(deniedApi.result, 403, "ordinary Chrome cannot access browser API");
    checks.push("Ordinary Chrome receives refusal, no SPA/scripts, and API 403");
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ passed: true, checks,
      serverPid: fixture.info.pid, externalBrowser: result,
      limitation: "Isolated fake-engine server with built UI and production Electron session/preload; not a signed installer, live account or real-model browser task." }, null, 2));
  } finally {
    clearTimeout(watchdog);
    await waitForExit(electron, { signal: "SIGTERM", graceMs: 3000 });
    const browserClosed = !browserEnv || await closeBrowserSession(browser.binary, browserEnv).catch(() => false);
    await fixture?.close();
    await removeTempDir(home);
    assert.equal(browserClosed, true, "fixture Chrome cleanup");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    console.log(`Desktop-only evidence: ${output}`);
  }
}
