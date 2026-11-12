import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ApproveExecutionTask, CreateExecutionConnector, ExecutionConnector, ExecutionConnectorList, ExecutionTask, ExecutionTool, StartExecutionTask } from "../../packages/shared/execution-connectors.ts";
import type { AnyProviderDriver, ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { CustomAcpDriver } from "./drivers/acp/custom.ts";

const drivers: Record<ExecutionTool, AnyProviderDriver> = { claude: ClaudeDriver, codex: CodexDriver, omp: CustomAcpDriver };
const active = (task: ExecutionTask) => task.status === "running" || task.status === "approval";
interface Connection { owner: string; wire: ExecutionConnector; remote?: { url: string; token: string; id: string } }
interface Task { owner: string; wire: ExecutionTask; instance?: ProviderInstance; remoteId?: string; unsubscribe?: () => void; timer?: NodeJS.Timeout }
export interface ExecutionConnectorOptions {
  root: string;
  localAvailable: boolean;
  ownsBot(owner: string, botId: string): boolean;
  /** Deployment-owned configuration, never accepted from HTTP requests. */
  cli?: Partial<Record<ExecutionTool, string>>;
  environment?: Record<string, string>;
  drivers?: Partial<Record<ExecutionTool, AnyProviderDriver>>;
}
export class ExecutionConnectorHost {
  private connections = new Map<string, Connection>();
  private tasks = new Map<string, Task>();
  private readonly options: ExecutionConnectorOptions;
  constructor(options: ExecutionConnectorOptions) {
    this.options = options;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(join(options.root, "connectors.json"), "utf8")) as Connection[];
      for (const connection of saved) {
        connection.wire.state = "disconnected";
        this.connections.set(connection.wire.id, connection);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.persist();
  }
  private persist() {
    const file = join(this.options.root, "connectors.json");
    writeFileSync(`${file}.tmp`, JSON.stringify([...this.connections.values()]), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  private connection(owner: string, id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection || connection.owner !== owner) throw new Error("Connector not found.");
    return connection;
  }
  private ownedTask(owner: string, id: string): Task {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) throw new Error("Task not found.");
    return task;
  }
  private botIds(owner: string, ids: unknown): string[] {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !this.options.ownsBot(owner, id))) throw new Error("Choose bots belonging to this account.");
    return [...new Set(ids)];
  }
  private async instance(tool: ExecutionTool): Promise<ProviderInstance> {
    const driver = this.options.drivers?.[tool] ?? drivers[tool];
    const config = driver.decodeConfig({ ...driver.defaultConfig(), ...(tool === "omp" ? { cli: "omp acp" } : {}), ...(this.options.cli?.[tool] ? { cli: this.options.cli[tool] } : {}) });
    return driver.create({ instanceId: `execution-${randomUUID()}`, displayName: tool, environment: this.options.environment ?? {}, enabled: true, config });
  }
  private async remote<T>(remote: NonNullable<Connection["remote"]>, path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${remote.url}/api/execution-connectors${path}`, { method, redirect: "error", headers: { authorization: `Bearer ${remote.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Execution service refused the request (${response.status}).`);
    return await response.json() as T;
  }
  async list(owner: string, canManage = true): Promise<ExecutionConnectorList> {
    const tasks = await Promise.all([...this.tasks.values()].filter(task => task.owner === owner).map(task => this.task(owner, task.wire.id)));
    return { localAvailable: this.options.localAvailable, canManage, connectors: [...this.connections.values()].filter(c => c.owner === owner).map(c => structuredClone(c.wire)), tasks };
  }
  async create(owner: string, input: CreateExecutionConnector): Promise<ExecutionConnector> {
    if (!input || input.consent !== true || !Object.hasOwn(drivers, input.tool) || !["local", "server"].includes(input.location)) throw new Error("Explicit execution consent and a supported tool/location are required.");
    const botIds = this.botIds(owner, input.botIds);
    const wire: ExecutionConnector = { id: randomUUID(), tool: input.tool, location: input.location, state: "connected", botIds, createdAt: Date.now() };
    const connection: Connection = { owner, wire };
    if (input.location === "local") {
      if (!this.options.localAvailable) throw new Error("Local execution is unavailable on this host.");
      const instance = await this.instance(input.tool);
      try {
        const snapshot = await instance.snapshot();
        if (snapshot.state !== "available" || snapshot.authenticated === false) throw new Error(snapshot.reason ?? "Install and sign in to this tool on the execution computer first.");
      } finally { await instance.dispose(); }
    } else {
      const url = new URL(input.remoteUrl ?? "");
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS execution-service origin (HTTP is allowed only on loopback).");
      if (typeof input.remoteToken !== "string" || input.remoteToken.length < 32 || /[\r\n]/.test(input.remoteToken)) throw new Error("An execution-service token of at least 32 characters is required.");
      const remote = { url: url.origin, token: input.remoteToken, id: "" };
      const created = await this.remote<ExecutionConnector>(remote, "", "POST", { tool: input.tool, location: "local", consent: true, botIds });
      if (!created || typeof created.id !== "string" || !/^[\w-]{1,128}$/.test(created.id) || created.tool !== input.tool || created.state !== "connected") throw new Error("Invalid execution-service connector response.");
      remote.id = created.id;
      connection.remote = remote;
    }
    this.connections.set(wire.id, connection);
    this.persist();
    return structuredClone(wire);
  }
  async grants(owner: string, id: string, ids: unknown): Promise<ExecutionConnector> {
    const connection = this.connection(owner, id);
    const botIds = this.botIds(owner, ids);
    connection.wire.botIds = botIds;
    this.persist();
    await Promise.all([...this.tasks.values()].filter(t => t.wire.connectorId === id && active(t.wire) && !botIds.includes(t.wire.botId)).map(t => this.cancel(owner, t.wire.id)));
    if (connection.remote) await this.remote(connection.remote, `/${connection.remote.id}`, "PATCH", { botIds });
    return structuredClone(connection.wire);
  }
  async start(owner: string, id: string, input: StartExecutionTask): Promise<ExecutionTask> {
    const connection = this.connection(owner, id);
    if (connection.wire.state !== "connected" || !this.options.ownsBot(owner, input.botId) || !connection.wire.botIds.includes(input.botId)) throw new Error("This bot has no execution grant.");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100_000) throw new Error("A task prompt is required (maximum 100000 characters).");
    if ([...this.tasks.values()].filter(t => t.owner === owner && active(t.wire)).length >= 8) throw new Error("Stop or finish a running task first.");
    for (const [key, old] of this.tasks) if (!active(old.wire) && (Date.now() - old.wire.createdAt > 86400000 || this.tasks.size >= 200)) { clearTimeout(old.timer); this.tasks.delete(key); }
    const task: Task = { owner, wire: { id: randomUUID(), connectorId: id, botId: input.botId, status: "running", text: "", approvals: [], createdAt: Date.now() } };
    this.tasks.set(task.wire.id, task);
    task.timer = setTimeout(() => { void this.cancel(owner, task.wire.id).catch(() => undefined); }, 30 * 60_000);
    task.timer.unref();
    if (connection.remote) {
      try {
        const result = await this.remote<ExecutionTask>(connection.remote, `/${connection.remote.id}/tasks`, "POST", input);
        if (!result || typeof result.id !== "string" || !/^[\w-]{1,128}$/.test(result.id)) throw new Error("Invalid execution-service task id.");
        task.remoteId = result.id;
        if (!active(task.wire) || connection.wire.state !== "connected" || !connection.wire.botIds.includes(input.botId)) await this.remote(connection.remote, `/tasks/${result.id}/cancel`, "POST");
        else this.applyRemote(task, result);
      } catch (error) { if (active(task.wire)) { task.wire.status = "failed"; task.wire.error = String(error); } }
    } else {
      void this.run(task, connection, input.prompt);
    }
    return structuredClone(task.wire);
  }
  private applyRemote(task: Task, result: ExecutionTask) {
    if (!active(task.wire)) return;
    if (!result || !["running", "approval", "completed", "failed", "cancelled"].includes(result.status) || typeof result.text !== "string" || result.text.length > 200000 || !Array.isArray(result.approvals) || result.approvals.length > 100 || result.approvals.some(a => typeof a.id !== "string" || typeof a.title !== "string" || typeof a.detail !== "string" || !["permission", "question"].includes(a.kind))) throw new Error("Invalid execution-service task response.");
    task.wire = { ...task.wire, status: result.status, text: result.text, ...(typeof result.error === "string" ? { error: result.error.slice(0, 10000) } : {}), approvals: result.approvals.map(a => ({ id: a.id, title: a.title.slice(0, 1000), detail: a.detail.slice(0, 10000), kind: a.kind, ...(Array.isArray(a.choices) && a.choices.every(c => typeof c === "string") ? { choices: a.choices.slice(0, 100).map(c => c.slice(0, 1000)) } : {}) })) };
    if (!active(task.wire)) clearTimeout(task.timer);
  }
  private async run(task: Task, connection: Connection, prompt: string) {
    try {
      const instance = await this.instance(connection.wire.tool);
      task.instance = instance;
      if (!active(task.wire) || connection.wire.state !== "connected") { await instance.dispose(); return; }
      const cwd = join(this.options.root, connection.wire.id, task.wire.id);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      if (!active(task.wire) || connection.wire.state !== "connected" || !connection.wire.botIds.includes(task.wire.botId) || !this.options.ownsBot(task.owner, task.wire.botId)) { await instance.dispose(); return; }
      task.unsubscribe = instance.adapter.onEvent(event => this.event(task, event));
      await instance.adapter.sendTurn({ threadId: task.wire.id, botId: task.wire.botId, text: prompt, cwd, approvalMode: "ask", approvalModeNow: () => "ask", mcpFromUserConfig: false, sessionReset: true, engineAdmission: async () => { if (!active(task.wire) || connection.wire.state !== "connected") throw new Error("Execution revoked."); } });
      if (!active(task.wire)) await instance.dispose();
    } catch (error) {
      if (active(task.wire)) { task.wire.status = "failed"; task.wire.error = String(error); task.wire.approvals = []; }
      await task.instance?.dispose();
    }
  }
  private event(task: Task, event: RuntimeEvent) {
    if (event.threadId !== task.wire.id || !active(task.wire)) return;
    if (event.type === "content.delta" && event.streamKind === "assistant_text") task.wire.text = (task.wire.text + event.delta).slice(-200_000);
    if (event.type === "item.completed" && event.itemType === "assistant_text" && !task.wire.text) task.wire.text = event.text.slice(-200_000);
    if (event.type === "request.opened" && event.requestId) {
      task.wire.approvals.push({ id: event.requestId, title: event.tool, detail: event.summary, kind: event.requestType, ...(event.choices ? { choices: event.choices } : {}) });
      task.wire.status = "approval";
    }
    if (event.type === "request.resolved") {
      task.wire.approvals = task.wire.approvals.filter(a => a.id !== event.requestId);
      if (!task.wire.approvals.length) task.wire.status = "running";
    }
    if (event.type === "runtime.error") task.wire.error = event.message;
    if (event.type === "turn.completed" || event.type === "session.exited" || (event.type === "runtime.error" && event.terminal)) {
      task.wire.status = event.type === "turn.completed" && event.ok ? "completed" : "failed";
      task.wire.approvals = [];
      task.unsubscribe?.();
      clearTimeout(task.timer);
      void task.instance?.dispose().catch(() => undefined);
    }
  }
  async task(owner: string, id: string): Promise<ExecutionTask> {
    const task = this.ownedTask(owner, id);
    const connection = this.connection(owner, task.wire.connectorId);
    if (connection.remote && task.remoteId && active(task.wire)) this.applyRemote(task, await this.remote<ExecutionTask>(connection.remote, `/tasks/${task.remoteId}`));
    return structuredClone(task.wire);
  }
  async approve(owner: string, id: string, input: ApproveExecutionTask): Promise<ExecutionTask> {
    const task = this.ownedTask(owner, id), connection = this.connection(owner, task.wire.connectorId);
    if (typeof input.allow !== "boolean" || !active(task.wire) || connection.wire.state !== "connected" || !task.wire.approvals.some(a => a.id === input.requestId)) throw new Error("This approval is no longer pending.");
    const question = task.wire.approvals.find(a => a.id === input.requestId)?.kind === "question";
    if (question && input.allow && (typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 10000)) throw new Error("Enter an answer to this question.");
    if (connection.remote && task.remoteId) this.applyRemote(task, await this.remote<ExecutionTask>(connection.remote, `/tasks/${task.remoteId}/approve`, "POST", input));
    else {
      const outcome = await task.instance?.adapter.respondToRequest(id, input.requestId, { behavior: input.allow ? (question ? "answer" : "allow") : "deny", ...(question && input.allow ? { message: input.answer } : {}), always: false });
      if (!outcome || outcome === "unavailable") throw new Error("This approval is no longer available.");
      task.wire.approvals = task.wire.approvals.filter(a => a.id !== input.requestId);
      if (active(task.wire) && !task.wire.approvals.length) task.wire.status = "running";
    }
    return structuredClone(task.wire);
  }
  async cancel(owner: string, id: string): Promise<ExecutionTask> {
    const task = this.ownedTask(owner, id), connection = this.connection(owner, task.wire.connectorId);
    if (!active(task.wire)) return structuredClone(task.wire);
    task.wire.status = "cancelled";
    clearTimeout(task.timer);
    task.wire.approvals = [];
    task.unsubscribe?.();
    if (connection.remote && task.remoteId) await this.remote(connection.remote, `/tasks/${task.remoteId}/cancel`, "POST");
    if (task.instance) { await task.instance.adapter.interruptTurn(id); await task.instance.dispose(); }
    return structuredClone(task.wire);
  }
  async disconnect(owner: string, id: string): Promise<ExecutionConnector> {
    const connection = this.connection(owner, id);
    connection.wire.state = "disconnected";
    connection.wire.botIds = [];
    this.persist();
    await Promise.all([...this.tasks.values()].filter(t => t.wire.connectorId === id).map(t => this.cancel(owner, t.wire.id)));
    if (connection.remote) await this.remote(connection.remote, `/${connection.remote.id}`, "DELETE");
    return structuredClone(connection.wire);
  }
  async dispose() { await Promise.all([...this.connections.values()].map(c => this.disconnect(c.owner, c.wire.id))); }
}
