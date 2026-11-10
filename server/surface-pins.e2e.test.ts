// A restartable fixture home lets tests seed bots.json between boots: the sourceless pin shapes only exist on disk.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { decodeCuaConnection } from "./local-computer.ts";
import { z } from "zod";
import { createInterface } from "node:readline";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("surface pin provenance against the real server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let cuaDescriptor = "";
  let inertBrowser = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  let boatServer: Server;
  let boatApi = "";
  let boatDown = false;
  const computerDevice = "surface-pin-fixture-device-00000001";
  let computerPolicyFile = "";
  let desktopOwner: string | undefined;

  const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
  const resetTurn = () => { vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true }); };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(desktopOwner ? { "x-hezuo-desktop-owner": desktopOwner } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  const mountedComputer = (sent: any) => sent.mcpConfig.mcpServers.computer;
  // The first screen tools/call, exactly as the mounted proxy issues it: a claim and its pin land on use, not on mount.
  const gate = (c: any) => fetch(c.env.OMB_CONTROL_URL, {
    headers: { authorization: `Bearer ${c.env.OMB_CONTROL_TOKEN}` },
  }).then(response => response.json() as Promise<any>);
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const busy = (botId: string, threadId: string) => until(() => threadState(botId, threadId), Boolean);
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    edit(bots.find((bot: any) => bot.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));
  };

  async function start(withBrowser = false, withComputerPolicy = false) {
    desktopOwner = withComputerPolicy ? "p".repeat(43) : undefined;
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      "--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        OMB_BOAT_API: boatApi, OMB_USER_DATA: join(home, "user-data"), OMB_TEST_DESKTOP_CUA_CONNECTION: cuaDescriptor,
        ...(withComputerPolicy ? { OMB_TEST_DESKTOP_OWNER_TOKEN: "p".repeat(43), OMB_TEST_COMPUTER_DEVICE: computerDevice,
          OMB_TEST_COMPUTER_POLICY_FILE: computerPolicyFile } : {}),
        ...(withBrowser ? { OMB_AGENT_BROWSER_PATH: inertBrowser, AGENT_BROWSER_EXECUTABLE_PATH: inertBrowser } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
    // Chief first makes the seeded bot its team's Chief, which answers a teammate's failed run with a Problems to look at
    // turn of its own on the same slow Claude: its dump would stand in for the turn under test. Stepped down, each dump
    // is the test's own. Only the first boot finds it a Chief.
    const seeded = (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
    if (seeded) await apiOk("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-surface-pins-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    cuaDescriptor = join(home, "user-data", "cua-connection.json");
    computerPolicyFile = join(home, "computer-policy.json");
    inertBrowser = join(home, "agent-browser");
    writeFileSync(inertBrowser, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vmState();
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Surface pins</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    boatServer = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
      if (boatDown && path.startsWith("/sandboxes")) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Fixture Boat unavailable" })); }
      if (path === "/sandboxes") return res.end(JSON.stringify({ sandboxes: [] }));
      return res.end("{}");
    });
    await new Promise<void>(resolve => boatServer.listen(0, "127.0.0.1", resolve));
    boatApi = `http://127.0.0.1:${(boatServer.address() as { port: number }).port}`;
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      // The first computer call is what reaches the Boat, as with a real model.
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile, FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
    } } }));
  });
  afterAll(async () => {
    await stop();
    if (boatServer) await new Promise<void>(resolve => boatServer.close(() => resolve()));
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); resetTurn(); boatDown = false; });

  it("marks a person's thread pin as theirs and clears provenance with the pin", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    const personPin = await threadState(bot.id, task.threadId);
    expect(personPin).toMatchObject({ surface: "local" });
    expect(personPin).not.toHaveProperty("surfaceAuto");
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: null });
    const cleared = savedTask(bot.id, task.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("still refuses to change a busy thread's surface", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Busy Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    expect(await gate(mountedComputer(await dump()))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surface === "vm", Boolean);
    const refused = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
    expect(refused.status).toBe(409);
    const pinned = savedTask(bot.id, task.threadId)!;
    expect(pinned.surface).toBe("vm");
    expect(pinned.surfaceSource).toBe("auto");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("sweeps only conflicting auto pins when Works on is set, and nothing when it returns to Auto", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Sweep Bot" });
    const [autoMismatch, personMismatch, autoMatch] = (await Promise.all([
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
    ])).map(({ task }) => task);
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${personMismatch.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMismatch.threadId), { surface: "local", surfaceSource: "auto" });
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMatch.threadId), { surface: "vm", surfaceSource: "auto" });
    });
    await start();
    expect(output).not.toContain("auto-pinned");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBe("local");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("preserves pre-provenance user pins at boot and after Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Repair Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      const target = saved.tasks.find((entry: any) => entry.threadId === task.threadId);
      target.surface = "local";
      delete target.surfaceSource;
    });
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    const place = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`);
    expect(place.surface).toBe("local");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "browser" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    await stop();
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("mounts the VM for a turn into a thread auto-pinned to this computer", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Incident Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      saved.tasks.find((entry: any) => entry.threadId === task.threadId).surfaceSource = "auto";
    });
    await start();
    expect(output.match(/auto-pinned thread/g)).toHaveLength(1);
    await stop();
    await start();
    expect(output).not.toContain("auto-pinned thread");
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work where you should.", threadId: task.threadId });
    const sent = await dump();
    expect(sent.systemPrompt).toContain("Local VM");
    expect(mountedComputer(sent).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(sent.systemPrompt).not.toContain("You can act on the user's computer");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("mounts the built-in browser beside the computer in a thread a teammate opened, and not in a person's thread", async () => {
    await start(true);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Delegated Browser Bot" });
    const [own, delegated] = (await Promise.all([
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
    ])).map(({ task }) => task);
    await stop();
    editSavedBot(bot.id, saved => {
      saved.browserProfile = "guest";
      saved.tasks.find((task: any) => task.threadId === delegated.threadId).openedBy = { botId: "coordinator", name: "Coordinator", kind: "work", at: Date.now() };
    });
    const turnIn = async (threadId: string) => {
      resetTurn();
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Check the signed-in page.", threadId });
      const servers = (await dump()).mcpConfig.mcpServers;
      writeFileSync(finishFile, "finish");
      await idle(bot.id, threadId);
      return servers;
    };
    for (const computer of [undefined, "vm"]) {
      if (computer) {
        await stop();
        editSavedBot(bot.id, saved => { saved.computer = computer; });
        for (const threadId of [own.threadId, delegated.threadId]) {
          editSavedBot(bot.id, saved => {
            const task = saved.tasks.find((entry: any) => entry.threadId === threadId);
            delete task.surface;
            delete task.surfaceSource;
          });
        }
      }
      await start(true);
      const person = await turnIn(own.threadId);
      expect(person.computer?.args.some((arg: string) => arg.includes("container-mcp")), `${computer} person`).toBe(true);
      expect(person.browser, `${computer} person`).toBeUndefined();
      const teammate = await turnIn(delegated.threadId);
      expect(teammate.computer?.args.some((arg: string) => arg.includes("container-mcp")), `${computer} teammate`).toBe(true);
      expect(teammate.browser, `${computer} teammate`).toBeDefined();
    }
    await stop();
  }, 60_000);

  it("records future auto pins and moves them when Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "New Auto Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the available computer.", threadId: task.threadId });
    expect(mountedComputer(await dump()).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    expect(await gate(mountedComputer(await dump()))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surface === "vm", Boolean);
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    expect(await threadState(bot.id, task.threadId)).not.toHaveProperty("surfaceSource");
    expect(await threadState(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceAuto: true });
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surfaceAuto");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await stop();
    await start();
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Continue without a computer.", threadId: task.threadId });
    expect(mountedComputer(await dump())).toBeUndefined();
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("keeps a person's pin when Works on changes under it", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Person Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => { saved.computer = "vm"; });
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    const place = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`);
    expect(place.surface).toBe("local");
    mkdirSync(dirname(cuaDescriptor), { recursive: true });
    writeFileSync(cuaDescriptor, JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    try {
      // Validate the fixture on every host before waiting for a provider; Windows cannot emulate the POSIX ownership check.
      const platforms: NodeJS.Platform[] = process.platform === "win32" ? ["win32"] : ["darwin", "win32"];
      for (const platform of platforms) {
        expect(decodeCuaConnection(JSON.parse(readFileSync(cuaDescriptor, "utf8")), { platform }))
          .toMatchObject({ command: "/fixture/cua-driver", platform, scope: "local-computer" });
      }
      // Linux requires a separately validated native runtime descriptor.
      if (process.platform !== "linux") {
        resetTurn();
        await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Stay where I pinned you.", threadId: task.threadId });
        const sent = await dump();
        expect(sent.systemPrompt).toContain("You can act on the user's computer");
        expect(mountedComputer(sent).env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
        expect(mountedComputer(sent).args.some((arg: string) => arg.includes("container-mcp"))).toBe(false);
        writeFileSync(finishFile, "finish");
        await idle(bot.id, task.threadId);
      }
    } finally {
      rmSync(cuaDescriptor, { force: true });
    }
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it.skipIf(process.platform === "linux")("enforces persistent computer policy through the real per-call gate across turns and restart", async () => {
    mkdirSync(dirname(cuaDescriptor), { recursive: true });
    writeFileSync(cuaDescriptor, JSON.stringify({ mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} }), { mode: 0o600 });
    const driverCalls = join(home, "policy-driver-calls.jsonl");
    const fakeDriver = `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === "tools/call") fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(message.params) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "isolated driver performed call" }] } }) + "\\n");
      });`;
    const callCount = () => existsSync(driverCalls) ? readFileSync(driverCalls, "utf8").trim().split("\n").length : 0;
    const proxyCall = async (raw: unknown) => {
      const computer = z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }).parse(raw);
      // Keep the mounted real proxy and real gate capability; replace only the OS driver process boundary.
      const proxy = spawn(computer.command, computer.args, { cwd: ROOT, env: { ...computer.env,
        HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), OMB_EXTRA_PATH: dirname(process.execPath),
        OMB_CUA_COMMAND: process.execPath, OMB_CUA_ARGS: JSON.stringify(["-e", fakeDriver]), FIXTURE_CALLS: driverCalls,
      }, stdio: ["pipe", "pipe", "pipe"] });
      const lines = createInterface({ input: proxy.stdout! });
      const result = (Promise as PromiseConstructor & { withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } }).withResolvers<unknown>();
      let diagnostics = "";
      proxy.stderr!.on("data", chunk => { diagnostics += chunk; });
      proxy.once("error", result.reject);
      proxy.once("exit", () => result.reject(new Error(`Proxy exited before reply: ${diagnostics}`)));
      lines.on("line", line => {
        const reply = z.object({ id: z.number().optional(), result: z.unknown().optional() }).parse(JSON.parse(line));
        if (reply.id === 1) result.resolve(reply.result);
      });
      // Real child processes cannot share Vitest's fake clock; this is only a failure watchdog, never a synchronization sleep.
      const timer = setTimeout(() => result.reject(new Error(`Proxy call timed out: ${diagnostics}`)), 55_000);
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } }) + "\n");
      try { return await result.promise; }
      finally { clearTimeout(timer); lines.close(); await waitForExit(proxy, { signal: "SIGTERM" }); }
    };
    const setPolicy = async (policy: "ask" | "allow" | "deny") => {
      writeFileAtomic(computerPolicyFile, JSON.stringify({ policy, nonce: randomUUID() }));
      await until(async () => (await apiOk("GET", "/api/config")).computerUsePolicy, value => value === policy);
    };
    await start(false, true);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Persistent host consent" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    const cardRows = z.object({ messages: z.array(z.object({ card: z.object({ yourComputer: z.unknown().optional(), answered: z.string().optional() }).passthrough().optional() }).passthrough()) });
    const cards = async () => cardRows.parse(await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages
      .flatMap(message => message.card?.yourComputer ? [message.card] : []);
    const begin = async () => {
      resetTurn();
      vmState({ noContainers: true, imageMissing: true });
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the available computer.", threadId: task.threadId });
      const computer = mountedComputer(await dump());
      expect(computer.env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
      return computer;
    };
    try {
      await setPolicy("allow");
      for (let turn = 0; turn < 2; turn++) {
        const computer = await begin();
        expect(await proxyCall(computer)).toMatchObject({ content: [{ text: "isolated driver performed call" }] });
        expect(await proxyCall(computer)).toMatchObject({ content: [{ text: "isolated driver performed call" }] });
        expect(callCount()).toBe((turn + 1) * 2);
        expect(await cards()).toHaveLength(0);
        writeFileSync(finishFile, "finish");
        await idle(bot.id, task.threadId);
      }
      await stop();
      await start(false, true);
      expect((await apiOk("GET", "/api/config")).computerUsePolicy).toBe("allow");
      const computer = await begin();
      expect(await proxyCall(computer)).toMatchObject({ content: [{ text: "isolated driver performed call" }] });
      expect(callCount()).toBe(5);
      await setPolicy("ask");
      const pending = proxyCall(computer);
      await until(cards, rows => rows.some(card => !card.answered));
      await setPolicy("deny");
      expect(await pending).toMatchObject({ isError: true });
      expect(await proxyCall(computer)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Never allow") }] });
      expect(callCount()).toBe(5);
      expect((await cards()).every(card => card.answered === "deny")).toBe(true);
      writeFileSync(finishFile, "finish");
      await idle(bot.id, task.threadId);
      await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
      expect(await proxyCall(await begin())).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Never allow") }] });
      expect(callCount()).toBe(5);
      writeFileSync(finishFile, "finish");
      await idle(bot.id, task.threadId);
      await setPolicy("ask");
      await apiOk("DELETE", `/api/bots/${bot.id}`);
    } finally {
      await stop();
      rmSync(cuaDescriptor, { force: true });
      rmSync(computerPolicyFile, { force: true });
      rmSync(driverCalls, { force: true });
    }
  }, 90_000);

  it("clears a select_computer pin to a cloud computer that fails, and keeps a person's pin", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Failed place bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PUT", "/api/config", { box: { token: "box_fixture" } });
    const lastRow = async () => {
      const { messages } = await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=30`);
      return String(messages.filter((message: any) => message.kind !== "digest").at(-1)?.tool?.name ?? "");
    };
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the cloud computer.", threadId: task.threadId });
    const sent = await dump();
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "cloud" }) });
    expect(await selected.json()).toMatchObject({ status: "pending", surface: "cloud" });
    boatDown = true;
    writeFileSync(finishFile, "finish");
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(await lastRow()).toBe("error: Cloud desktops can't start right now. It isn't anything you did. This conversation is back on Auto. Send your message again.");
    const cleared = savedTask(bot.id, task.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Carry on where you can.", threadId: task.threadId });
    const next = await dump();
    expect(mountedComputer(next)?.args ?? []).not.toContain("computer");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect(await lastRow()).not.toMatch(/^error:/);

    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "cloud" });
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the cloud computer.", threadId: task.threadId });
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(await lastRow()).toBe("error: Cloud desktops can't start right now. It isn't anything you did. Clear this conversation's place in the composer to continue.");
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "cloud", surfaceSource: "user" });
    boatDown = false;
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("never takes a relayed line's conversation for where the person writes, when select_computer continues its turn", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Relayed place bot" });
    // An Ask thread, as a Slack relay's guarded send expects.
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, { approvalMode: "ask" });
    await apiOk("PUT", "/api/config", { box: { token: "box_fixture" } });
    const lastRow = async () => {
      const { messages } = await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=30`);
      return String(messages.filter((message: any) => message.kind !== "digest").at(-1)?.tool?.name ?? "");
    };
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: task.threadId, sendId: randomUUID(), text: "Check the dashboard on the cloud computer.", expectedActiveLeafId: null,
    });
    const sent = await dump();
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "cloud" }) });
    expect(await selected.json()).toMatchObject({ status: "pending", surface: "cloud" });
    boatDown = true;
    writeFileSync(finishFile, "finish");
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("askedAt");
    boatDown = false;
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });
});
