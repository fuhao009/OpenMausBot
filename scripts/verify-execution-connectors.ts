import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer } from "./control-omb.ts";
import { createExecutionService } from "../server/execution-service.ts";
import type { ExecutionTask } from "../shared/execution-connectors.ts";

// Fixed repository fakes only. Never accepts a URL, executable, home or credential from the caller.
const root = await mkdtemp(join(tmpdir(), "omb-execution-smoke-"));
const callsFile = join(root, "bot-calls.json");
await writeFile(callsFile, "[]");
const fixture = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS_FILE: callsFile });
const token = randomBytes(32).toString("hex");
const cli = { claude: fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url)), codex: fileURLToPath(new URL("../server/testing/fake-codex-app-server.ts", import.meta.url)), omp: fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url)) };
const service = createExecutionService({ root, token, account: "fixture-account", localAvailable: true, ownsBot: () => true, cli, environment: { HOME: root, USERPROFILE: root, CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: dirname(process.execPath), FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: join(root, "codex-decision.json"), FAKE_CODEX_DUMP_TURNS_ONLY: "1", FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: join(root, "acp-decision.txt") } });
const listening = Promise.withResolvers<void>();
service.server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = service.server.address();
assert(address && typeof address !== "string");
const remoteUrl = `http://127.0.0.1:${address.port}`;
const api = async (path: string, method = "GET", body?: unknown, expected = 200) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
const waitTask = async (id: string, status: string) => {
  for (let i = 0; i < 200; i++) {
    const task = await api(`/api/execution-connectors/tasks/${id}`) as ExecutionTask;
    if (task.status === status) return task;
    assert(!["failed", "cancelled"].includes(task.status), JSON.stringify(task));
    await delay(100);
  }
  throw new Error(`Task ${id} did not reach ${status}`);
};
try {
  const listed = await api("/api/bots");
  const bots = Array.isArray(listed) ? listed : listed.bots;
  assert(bots?.length, "Verification launcher must provision its starter bot");
  const botId = bots[0].id;
  const unauthorized = await fetch(`${remoteUrl}/api/execution-connectors`);
  assert.equal(unauthorized.status, 401);
  for (const tool of ["claude", "codex", "omp"] as const) {
    const local = await api("/api/execution-connectors", "POST", { tool, location: "local", consent: true, botIds: [botId] });
    const task = await api(`/api/execution-connectors/${local.id}/tasks`, "POST", { botId, prompt: "Say fixture execution completed." });
    assert((await waitTask(task.id, "completed")).text);
    await api(`/api/execution-connectors/${local.id}`, "DELETE");
    await api(`/api/execution-connectors/${local.id}/tasks`, "POST", { botId, prompt: "Must be refused" }, 400);
  }
  const botConnector = await api("/api/execution-connectors", "POST", { tool: "codex", location: "local", consent: true, botIds: [botId] });
  await writeFile(callsFile, JSON.stringify([{ server: "agents", name: "execution_connector", input: { action: "start", connectorId: botConnector.id, prompt: "Run a task requested through the actual bot MCP tool." } }]));
  await api(`/api/bots/${botId}/messages`, "POST", { text: "Please run my coding task through the connected executor." }, 202);
  let invoked: ExecutionTask | undefined;
  for (let i = 0; i < 200; i++) {
    invoked = (await api("/api/execution-connectors")).tasks.find((task: ExecutionTask) => task.connectorId === botConnector.id);
    if (invoked) break;
    await delay(100);
  }
  assert(invoked, "Actual bot MCP dispatch must start a granted execution task");
  await waitTask(invoked.id, "completed");
  await writeFile(callsFile, "[]");
  await api(`/api/execution-connectors/${botConnector.id}`, "DELETE");
  const remoteClaude = await api("/api/execution-connectors", "POST", { tool: "claude", location: "server", consent: true, botIds: [botId], remoteUrl, remoteToken: token });
  const remoteClaudeTask = await api(`/api/execution-connectors/${remoteClaude.id}/tasks`, "POST", { botId, prompt: "Say remote Claude completed." });
  assert((await waitTask(remoteClaudeTask.id, "completed")).text);
  await api(`/api/execution-connectors/${remoteClaude.id}`, "DELETE");
  for (const tool of ["codex", "omp"] as const) {
    const remote = await api("/api/execution-connectors", "POST", { tool, location: "server", consent: true, botIds: [botId], remoteUrl, remoteToken: token });
    for (const allow of [false, true]) {
      const decisionFile = join(root, tool === "codex" ? "codex-decision.json" : "acp-decision.txt");
      await rm(decisionFile, { force: true });
      const started = await api(`/api/execution-connectors/${remote.id}/tasks`, "POST", { botId, prompt: "Exercise the fixture permission." });
      const pending = await waitTask(started.id, "approval");
      assert(pending.approvals.length);
      if (tool === "codex") assert.equal(JSON.parse(await readFile(decisionFile, "utf8")).decision, null, "No decision before owner approval");
      else await assert.rejects(readFile(decisionFile, "utf8"), { code: "ENOENT" });
      await api(`/api/execution-connectors/tasks/${started.id}/approve`, "POST", { requestId: pending.approvals[0].id, allow });
      await waitTask(started.id, "completed");
      const decision = await readFile(decisionFile, "utf8");
      if (tool === "codex") assert.deepEqual(JSON.parse(decision).decision, { decision: allow ? "approved" : "denied" });
      else assert.equal(decision, allow ? "allow-once" : "reject");
    }
    const started = await api(`/api/execution-connectors/${remote.id}/tasks`, "POST", { botId, prompt: "Wait for approval then stop." });
    const pending = await waitTask(started.id, "approval");
    await api(`/api/execution-connectors/tasks/${started.id}/cancel`, "POST", {});
    await api(`/api/execution-connectors/tasks/${started.id}/approve`, "POST", { requestId: pending.approvals[0].id, allow: true }, 400);
    assert.equal((await api(`/api/execution-connectors/tasks/${started.id}`)).status, "cancelled");
    await api(`/api/execution-connectors/${remote.id}`, "DELETE");
  }
  console.log("Execution connectors: local Claude/Codex/OMP, authenticated remote transport, permission allow/deny, cancellation and revocation passed.");
} finally {
  await service.host.dispose();
  const closed = Promise.withResolvers<void>();
  service.server.close(() => closed.resolve());
  await closed.promise;
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}
