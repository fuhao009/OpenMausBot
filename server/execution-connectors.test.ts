import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionConnectorHost } from "./execution-connectors.ts";
import type { ProviderDriver, RuntimeEventListener } from "./contracts.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "execution-unit-")); roots.push(root);
  let created = 0;
  let answered = 0;
  let listener: RuntimeEventListener = () => undefined;
  const driver: ProviderDriver = {
    driverKind: "fixture", metadata: { displayName: "fixture" }, models: { default: "fixture", options: [] }, defaultConfig: () => ({}), decodeConfig: value => value,
    async create(input) {
      created++;
      return { instanceId: input.instanceId, driverKind: "fixture", displayName: "fixture", enabled: true, models: driver.models,
        snapshot: async () => ({ state: "available", authenticated: true }), dispose: async () => undefined,
        adapter: { provider: "fixture", capabilities: { sessionModelSwitch: "unsupported" },
          async sendTurn(turn) { listener({ type: "request.opened", requestType: "permission", requestId: "ask", tool: "shell", summary: "fixture command", eventId: "e", provider: "fixture", threadId: turn.threadId, createdAt: "now" }); return { turnId: "turn" }; },
          interruptTurn: async () => undefined, stopAll: async () => undefined, hasSession: () => false,
          async respondToRequest() { answered++; return "allowed-once"; }, onEvent(fn) { listener = fn; return () => { listener = () => undefined; }; },
        },
      };
    },
  };
  const options = { root, localAvailable: true, ownsBot: (owner: string, bot: string) => owner === "alice" && bot === "bot", drivers: { claude: driver } };
  const host = new ExecutionConnectorHost(options);
  return { root, host, options, created: () => created, answered: () => answered };
}
describe("execution account and consent boundaries", () => {
  it("never probes before explicit consent and never leaks another owner's connector", async () => {
    const f = await fixture();
    await expect(f.host.create("alice", { tool: "claude", location: "local", consent: false as true, botIds: ["bot"] })).rejects.toThrow("consent");
    expect(f.created()).toBe(0);
    const connector = await f.host.create("alice", { tool: "claude", location: "local", consent: true, botIds: ["bot"] });
    expect((await f.host.list("bob")).connectors).toEqual([]);
    await expect(f.host.start("bob", connector.id, { botId: "bot", prompt: "work" })).rejects.toThrow("not found");
    await f.host.dispose();
  });
  it("revokes pending approvals and refuses future work after disconnect", async () => {
    const f = await fixture();
    const connector = await f.host.create("alice", { tool: "claude", location: "local", consent: true, botIds: ["bot"] });
    const task = await f.host.start("alice", connector.id, { botId: "bot", prompt: "work" });
    await expect.poll(async () => (await f.host.task("alice", task.id)).status).toBe("approval");
    expect(f.answered()).toBe(0);
    await f.host.disconnect("alice", connector.id);
    await expect(f.host.approve("alice", task.id, { requestId: "ask", allow: true })).rejects.toThrow("no longer pending");
    await expect(f.host.start("alice", connector.id, { botId: "bot", prompt: "work" })).rejects.toThrow("no execution grant");
    expect(f.answered()).toBe(0);
    expect((await f.host.task("alice", task.id)).status).toBe("cancelled");
  });
  it("stores private config and restarts disconnected rather than assuming readiness", async () => {
    const f = await fixture();
    await f.host.create("alice", { tool: "claude", location: "local", consent: true, botIds: ["bot"] });
    expect((await stat(join(f.root, "connectors.json"))).mode & 0o077).toBe(0);
    const restarted = new ExecutionConnectorHost(f.options);
    expect((await restarted.list("alice")).connectors[0].state).toBe("disconnected");
    await f.host.dispose(); await restarted.dispose();
  });
});
