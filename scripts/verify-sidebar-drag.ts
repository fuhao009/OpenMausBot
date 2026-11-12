// Fewer buttons, more dragging, in the real app against a disposable fake-engine server: a conversation dragged into
// and out of a folder, a bot dragged into a chat, a file dropped on a bot, and the row menus a right-click opens now
// that no row draws ⋯, + or folder buttons.
// Run: node --experimental-strip-types scripts/verify-sidebar-drag.ts [--shots <dir>]
// With --shots it drives a headless Chrome in a throwaway profile (OMB_CDP_CHROME, else the installed Google Chrome),
// checks each step against the fixture's API, saves a picture of each and exits; without, it prints the preview's
// address and waits. Drags are the page's own DragEvents with a DataTransfer.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
const shots = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT] = [1280, 800];

type Bot = { id: string; name: string; threadId: string; tasks?: Array<{ threadId: string; title: string; projectId?: string | null }>; projects?: Array<{ id: string; name: string }> };
type Group = { id: string; name: string; memberIds: string[]; dm?: boolean };

const helpers = `
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const q = (selector) => document.querySelector(selector);
  const drag = (window.__drag ??= { dt: null, source: null });
  const fire = (node, type, fraction = 0.5) => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: drag.dt, clientX: box.left + box.width / 2, clientY: box.top + box.height * fraction }));
  };
  const start = (node) => { drag.dt = new DataTransfer(); drag.source = node; fire(node, "dragstart"); };
  const over = (node, fraction) => { fire(node, "dragenter", fraction); fire(node, "dragover", fraction); };
  const end = () => { if (drag.source?.isConnected) fire(drag.source, "dragend"); drag.source = null; };
  const drop = (node, fraction) => { fire(node, "drop", fraction); end(); };
  const file = (name, type, text) => { drag.dt = new DataTransfer(); drag.dt.items.add(new File([text], name, { type })); drag.source = null; };
  const menu = (node) => { const box = node.getBoundingClientRect(); node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + box.height / 2 })); };
`;

async function openChrome(profile: string) {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} got no answer`)); }, 30_000);
    waiting.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return {
    async open(url: string, ready: string) {
      await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      await this.until(ready, `${url}: ${ready}`);
      await delay(900);
    },
    run: (script: string) => evaluate(`(async () => { ${helpers}\n${script}; })()`),
    async until(selector: string, what: string) {
      const end = Date.now() + 30_000;
      while (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false))) {
        if (Date.now() > end) throw new Error(`${what} never showed`);
        await delay(200);
      }
    },
    async shoot(file: string) {
      await delay(500);
      const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(file);
    },
    close() { socket.close(); chrome.kill(); },
  };
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`FAILED: ${what}`);
    await delay(250);
  }
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  for (const name of ["Research", "Writer"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  await api("PATCH", "/api/config", { language: "en" });
  const listBots = async () => (await api("GET", "/api/bots?messages=0") as { bots: Bot[] }).bots;
  const byName = async (name: string) => (await listBots()).find((bot) => bot.name === name)!;
  let research = await byName("Research");
  const writer = await byName("Writer");
  const folder = (await api("POST", `/api/bots/${research.id}/projects`, { name: "Launch" }) as { project: { id: string } }).project;
  await api("POST", `/api/bots/${research.id}/tasks`, {});
  await api("POST", `/api/bots/${research.id}/tasks`, {});
  research = await byName("Research");
  const loose = research.tasks!.find((task) => task.threadId !== research.threadId && !task.projectId)!;
  ui = await mountPreview(fixture, { entry: "/scripts/testing/sidebar-groups-preview.tsx", route: "/__sidebar-drag.html", title: "Isolated sidebar dragging", logLevel: "warn" });
  if (!shots) {
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, research: research.id, writer: writer.id, folder: folder.id }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "omb-drag-chrome-"));
    const chrome = await openChrome(profile);
    const row = (id: string) => `[data-sidebar-bot-row="${id}"]`;
    try {
      await chrome.open(`${ui.previewUrl}?mode=advanced`, row(research.id));

      const buttons = await chrome.run(`return { actions: document.querySelectorAll("[data-bot-actions]").length,
        plus: [...document.querySelectorAll("[data-sidebar] button")].filter((b) => b.getAttribute("aria-label") === "New thread").length }`) as { actions: number; plus: number };
      check(buttons.actions === 0 && buttons.plus === 0, "no row draws ⋯ or + buttons");

      await chrome.run(`q('${row(research.id)}').click(); await pause(300); const t = q('button[aria-label="Expand Research threads"]'); if (t) t.click()`);
      await chrome.until(`[data-sidebar-folder-row="${folder.id}"]`, "the Launch folder");
      await chrome.shoot(join(shots, "1-rest.png"));

      await chrome.run(`menu(q('[data-sidebar-folder-label="${folder.id}"]'))`);
      await chrome.until('[role="menu"][aria-label="Actions for Launch folder"]', "the folder menu");
      await chrome.shoot(join(shots, "2-folder-menu.png"));
      await chrome.run(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

      await chrome.run(`start(q('[data-sidebar-thread-row="${loose.threadId}"]')); over(q('[data-sidebar-folder-row="${folder.id}"]'))`);
      await chrome.until(`[data-sidebar-folder-row="${folder.id}"][data-thread-drop]`, "the folder lit up under a dragged conversation");
      await chrome.shoot(join(shots, "3-thread-over-folder.png"));
      await chrome.run(`drop(q('[data-sidebar-folder-row="${folder.id}"]'))`);
      await until(() => byName("Research"), (bot) => bot.tasks!.find((task) => task.threadId === loose.threadId)?.projectId === folder.id, "the dropped conversation is saved in the folder");
      check(true, "a conversation dragged onto a folder is saved in it");

      await chrome.run(`await pause(400); start(q('[data-sidebar-thread-row="${loose.threadId}"]')); await pause(200); over(q('[data-sidebar-unfiled]'))`);
      await chrome.until("[data-sidebar-unfiled][data-thread-drop]", "the out-of-folder place lit up");
      await chrome.shoot(join(shots, "4-thread-out-of-folder.png"));
      await chrome.run(`drop(q('[data-sidebar-unfiled]'))`);
      await until(() => byName("Research"), (bot) => !bot.tasks!.find((task) => task.threadId === loose.threadId)?.projectId, "the conversation is taken out of the folder");
      check(true, "a conversation dragged out of its folder is saved with none");

      await chrome.run(`file("notes.txt", "text/plain", "hello"); over(q('${row(writer.id)}'))`);
      await chrome.until(`${row(writer.id)}`, "Writer");
      const lit = await chrome.run(`return Boolean(q('${row(writer.id)}').closest("[data-file-drop]"))`);
      check(lit, "a bot lights up under dragged files");
      await chrome.shoot(join(shots, "5-file-over-bot.png"));
      await chrome.run(`fire(q('${row(writer.id)}'), "drop")`);
      await until(async () => chrome.run(`return Boolean(document.querySelector('[data-tour="composer"]')) && document.body.textContent.includes("notes.txt")`), Boolean, "the file shows in Writer's composer");
      check(true, "files dropped on a bot open it with them attached");
      await chrome.shoot(join(shots, "6-file-attached.png"));

      await chrome.run(`start(q('${row(research.id)}')); await pause(100); over(q("[data-bot-chat-zone] > *"), 0.4)`);
      await chrome.until("[data-bot-chat-drop]", "the chat lit up under a dragged bot");
      await chrome.shoot(join(shots, "7-bot-over-chat.png"));
      await chrome.run(`fire(q("[data-bot-chat-zone] > *"), "drop", 0.4); end()`);
      const room = await until(async () => (await api("GET", "/api/bots?messages=0") as { groups: Group[] }).groups,
        (groups) => groups.some((group) => !group.dm && group.memberIds.includes(writer.id) && group.memberIds.includes(research.id)), "a channel with both bots");
      check(room.length > 0, "a bot dropped into a one-to-one chat starts a channel with both");
      await delay(800);
      await chrome.shoot(join(shots, "8-channel-created.png"));

      await chrome.run(`menu(q('[data-sidebar-thread-row="${loose.threadId}"]'))`);
      await chrome.until("[data-thread-overlay]", "the conversation menu");
      const menu = await chrome.run(`return [...q("[data-thread-overlay]").querySelectorAll("button")].map((b) => b.textContent.trim())`) as string[];
      check(menu.includes("Rename thread") && !(await chrome.run(`return Boolean(q("[data-thread-overlay] select"))`)), "a conversation's menu opens from a right-click, without the Move to folder list");
    } finally {
      chrome.close();
      await delay(500);
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
}
