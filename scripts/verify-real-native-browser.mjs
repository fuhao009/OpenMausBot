#!/usr/bin/env node
// Real source main, normal account authentication, real utility child and native browser.
// No fixture flag, debug port, proxy server, injected account token or auth bypass.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, stat, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { electronBinary } from "./product-fixture/runtime.mjs";
import { normalizeProductTrust } from "../desktop/electron/product-ca.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
  resource: { type: "string", default: "/Applications/Hezuo.app/Contents/Resources/product-service.json" },
  credentials: { type: "string", default: join(repo, ".omb-scratch/development-test-credentials.md") },
  "prompt-file": { type: "string" },
  "timeout-seconds": { type: "string", default: "300" },
  "startup-only": { type: "boolean", default: false },
  "mock-keychain": { type: "boolean", default: false },
  "keep-open": { type: "boolean", default: false },
}, strict: true });
const binary = electronBinary();
if (!binary) throw new Error("Build/install the repository Electron runtime first");
for (const entry of ["dist/product-account.html", "dist/index.html", "dist-server/index.js"]) {
  await access(join(repo, entry)).catch(() => { throw new Error(`Build prerequisite missing: ${entry}`); });
}
const resourcePath = resolve(values.resource);
const resourceDirectory = dirname(resourcePath);
const resource = JSON.parse(await readFile(resourcePath, "utf8"));
await access(join(resourceDirectory, "skills")).catch(() => { throw new Error("The selected product resource directory has no bundled skills"); });
const trust = resource.version === 2 ? normalizeProductTrust(resource) : null;
if (!trust) throw new Error("A valid, hostname-bound version-2 product-service.json is required");
const credentialPath = resolve(values.credentials);
const credentials = await readFile(credentialPath, "utf8");
if (!/账号：`[^`]+`/.test(credentials) || !/密码：`[^`]+`/.test(credentials)) throw new Error("Credential document has no account/password pair");
const prompt = values["prompt-file"] ? await readFile(resolve(values["prompt-file"]), "utf8")
  : "请用内置浏览器打开淘股吧 https://www.taoguba.com.cn/ 并进入登录页。不要用HTTP、搜索或shell代替浏览器操作。请确认实际网页可见；如果需要淘股吧账号、密码、短信验证码或人工验证，请正常向我请求并停止等待，不能猜测或绕过，也不能把打开登录页声称为已登录。";
const timeoutMs = Number(values["timeout-seconds"]) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid timeout");
const root = await mkdtemp(join(tmpdir(), "hezuo-real-native-"));
console.log(JSON.stringify({ stage: "evidence", root }));
await mkdir(join(root, "home"), { mode: 0o700 });
await mkdir(join(root, "user-data"), { mode: 0o700 });
for (const entry of ["dist", "dist-server"]) await symlink(join(repo, entry), join(root, entry));
await writeFile(join(root, "trust.pem"), trust.ca, { mode: 0o600 });
await writeFile(join(root, "package.json"), JSON.stringify({ name: "hezuo-isolated-native-verification", version: "1.0.0", type: "module", main: "bootstrap.cjs" }), { mode: 0o600 });
// The bootstrap runs only in the isolated harness. executeJavaScript calls the same
// preload account method as the form; the service validates credentials normally.
await writeFile(join(root, "bootstrap.cjs"), `
const { app, dialog, safeStorage } = require('electron');
const { readFile } = require('node:fs/promises');
const stage = value => console.log('[native-runner] ' + value);
const { BrowserWindow, desktopCapturer } = require('electron');
const { existsSync, unlinkSync, writeFileSync } = require('node:fs');
const displayTimer = setInterval(async () => {
  const marker = ${JSON.stringify(join(root, "show-login"))};
  if (!existsSync(marker)) return;
  unlinkSync(marker);
  const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
  const native = windows.find(w => w.contentView.children.some(v => {
    if (!v.webContents) return false;
    try { return ['www.tgb.cn', 'tgb.cn', 'www.taoguba.com.cn'].includes(new URL(v.webContents.getURL()).hostname); } catch { return false; }
  }));
  const win = native ?? windows.at(-1);
  if (!win) return;
  win.show(); win.moveTop(); win.focus(); app.focus({ steal: true });
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } });
    const source = sources.find(s => s.id === win.getMediaSourceId());
    if (source && !source.thumbnail.isEmpty()) writeFileSync(${JSON.stringify(join(root, "login-window.png"))}, source.thumbnail.toPNG());
  } catch {}
}, 500);
displayTimer.unref();
app.setAppUserModelId('com.hezuo.isolated-native-verification');
stage('bootstrap-start');
// Source main uses process.resourcesPath for bundled skills and native helpers;
// point it at the installed product's real resource tree, not Electron's own distribution.
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resourceDirectory)}, configurable: true });
app.setPath('home', ${JSON.stringify(join(root, "home"))});
app.setPath('userData', ${JSON.stringify(join(root, "user-data"))});
app.setPath('sessionData', ${JSON.stringify(join(root, "user-data"))});
app.setAppLogsPath(${JSON.stringify(join(root, "logs"))});
stage('paths-ready');
process.on('uncaughtException', () => { stage('uncaught-exception'); app.exit(1); });
process.on('unhandledRejection', () => { stage('unhandled-rejection'); app.exit(1); });
dialog.showErrorBox = () => { stage('error-dialog'); app.exit(1); };
for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync']) {
  const original = safeStorage[name].bind(safeStorage);
  safeStorage[name] = async (...args) => {
    stage('keychain-' + name + '-start');
    try { const value = await original(...args); stage('keychain-' + name + '-done'); return value; }
    catch (error) { stage('keychain-' + name + '-error'); throw error; }
  };
}
let submitted = false;
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, details) => {
    const value = details?.message;
    if (typeof value === 'string' && /^native-state:(signed_out|signing_in|signed_in|unavailable)\\/(stopped|starting|ready|error|stopping)\\/[a-z0-9_]{1,80}$/.test(value)) stage(value);
  });
  contents.on('did-finish-load', async () => {
    if (submitted || !contents.getURL().startsWith('file:') || !contents.getURL().includes('/product-account.html')) return;
    submitted = true;
    stage('auth-document');
    try {
      const document = await readFile(${JSON.stringify(credentialPath)}, 'utf8');
      const email = document.match(/账号：\x60([^\x60]+)\x60/)[1];
      const password = document.match(/密码：\x60([^\x60]+)\x60/)[1];
      await contents.executeJavaScript("window.ogb.productAccount.onState(state => { if (['signed_out','signing_in','signed_in','unavailable'].includes(state.auth) && ['stopped','starting','ready','error','stopping'].includes(state.runtime)) console.log('native-state:' + state.auth + '/' + state.runtime + '/' + (/^[a-z0-9_]{1,80}$/.test(state.errorCode || '') ? state.errorCode : 'none')); }); null");
      stage('auth-submitted');
      const state = await contents.executeJavaScript('window.ogb.productAccount.signInWithPassword(' + JSON.stringify(email) + ',' + JSON.stringify(password) + ')');
      stage(state?.auth === 'signed_in' ? 'auth-signed-in' : 'auth-not-signed-in');
      if (state?.auth !== 'signed_in') {
        if (/^[a-z0-9_]{1,80}$/.test(state?.errorCode ?? '')) stage('auth-code:' + state.errorCode);
        app.exit(1);
      }
    } catch { stage('auth-error'); app.exit(1); }
  });
});
stage(app.isReady() ? 'main-import-after-ready' : 'main-import-before-ready');
import(${JSON.stringify(new URL("../desktop/electron/main.mjs", import.meta.url).href)}).then(() => stage('main-imported'), () => { stage('main-import-error'); app.exit(1); });
`, { mode: 0o600 });
const env = {};
for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "USER", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), OMB_PRODUCT_SERVICE_URL: trust.origin, NODE_EXTRA_CA_CERTS: join(root, "trust.pem") });
let child, runId, descriptor;
const report = { mode: "real-electron-normal-account", root, status: "starting", run: null };
const save = () => writeFile(join(root, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const call = async (route, body) => {
  const response = await fetch(descriptor.url + route, { method: body ? "POST" : "GET", redirect: "error", headers: { Authorization: `Bearer ${descriptor.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Bot test API returned HTTP ${response.status}`);
  return response.json();
};
try {
  child = spawn(binary, [root, "--bot-test-api", ...(values["mock-keychain"] ? ["--use-mock-keychain"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stages = new Set(["bootstrap-start", "paths-ready", "uncaught-exception", "unhandled-rejection", "error-dialog", "auth-document", "auth-submitted", "auth-signed-in", "auth-not-signed-in", "auth-error", "main-import-after-ready", "main-import-before-ready", "main-imported", "main-import-error"]);
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = "";
    stream.on("data", chunk => {
      buffered = (buffered + chunk.toString()).slice(-65536);
      const lines = buffered.split("\n"); buffered = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("[native-runner] ")) continue;
        const value = line.slice(16).trim();
        if (stages.has(value) || /^auth-code:[a-z0-9_]{1,80}$/.test(value) || /^keychain-(isAsyncEncryptionAvailable|encryptStringAsync)-(start|done|error)$/.test(value) || /^native-state:(signed_out|signing_in|signed_in|unavailable)\/(stopped|starting|ready|error|stopping)\/[a-z0-9_]{1,80}$/.test(value)) console.log(JSON.stringify({ stage: value }));
      }
    });
  }
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (!descriptor && Date.now() < deadline) {
    if (exited) throw new Error("Electron exited before normal account runtime became ready");
    const accounts = join(root, "user-data/product-accounts");
    for (const entry of await readdir(accounts).catch(() => [])) {
      const file = join(accounts, entry, "bot-test-api.json");
      try {
        const info = await stat(file);
        if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Unsafe descriptor permissions");
        descriptor = JSON.parse(await readFile(file, "utf8"));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!descriptor) await delay(250);
  }
  if (!descriptor) throw new Error("Account/runtime startup timed out; inspect isolated app logs");
  const url = new URL(descriptor.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("Invalid private API descriptor");
  while ((await call("/v1/status")).status !== "ready") {
    if (Date.now() >= deadline) throw new Error("Account model capability did not become ready");
    await delay(250);
  }
  if (values["startup-only"]) {
    report.status = "ready";
    await save();
    console.log(JSON.stringify({ status: "ready", evidence: join(root, "result.json") }));
  } else {
  const accepted = await call("/v1/runs", { text: prompt });
  runId = accepted.run.id;
  while (Date.now() < deadline) {
    const { run } = await call(`/v1/runs/${runId}`);
    // Results contain no descriptor token or account credentials. Keep the full
    // conversation report local/private: a custom prompt may itself contain secrets.
    report.run = run;
    report.status = run.status;
    await save();
    if (["completed", "failed", "stopped", "needs-user"].includes(run.status)) break;
    if (exited) throw new Error("Electron exited during the model run");
    await delay(500);
  }
  if (!["completed", "failed", "stopped", "needs-user"].includes(report.status)) {
    await call(`/v1/runs/${runId}/stop`, {});
    throw new Error("Model run timed out and was stopped");
  }
  console.log(JSON.stringify({ status: report.status, evidence: join(root, "result.json"), note: "Completion is not proof of website login; inspect native page and model evidence." }));
  if (values["keep-open"] && report.status === "needs-user") {
    await writeFile(join(root, "show-login"), "show", { mode: 0o600 });
    console.log(JSON.stringify({ status: "window-retained", evidence: join(root, "result.json"), screenshot: join(root, "login-window.png") }));
    await new Promise(resolve => child.once("exit", resolve));
  }
  }
} catch (error) {
  report.status = "error";
  report.error = error.message;
  await save();
  console.error(JSON.stringify({ status: "error", evidence: join(root, "result.json"), error: error.message }));
  process.exitCode = 1;
} finally {
  if (runId && descriptor && !["completed", "failed", "stopped"].includes(report.status)) {
    await call(`/v1/runs/${runId}/stop`, {}).catch(() => {});
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const exited = new Promise(resolve => child.once("exit", resolve));
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([exited, delay(2000)]);
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    await Promise.all(["home", "user-data", "logs"].map(name => rm(join(root, name), { recursive: true, force: true })));
    console.log(JSON.stringify({ stage: "private-data-removed" }));
  } else throw new Error("Owned Electron did not exit; private data retained to avoid deleting a live profile");
}
