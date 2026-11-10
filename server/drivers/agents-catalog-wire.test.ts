import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_SOURCE = join(HERE, "agents-proxy.ts");

interface Profile {
  env: Record<string, string>;
}

const flag = (on: boolean) => (on ? "1" : "0");

/** Every combination agentsIntegration() can produce; a name without "+non-chief" is a Chief of Staff's conversation, and
 * every one is a direct chat whose bot may pick its computer, unless it says otherwise. */
function profiles(): Record<string, Profile> {
  const all: Record<string, Profile> = {};
  for (const chief of [true, false]) {
    for (const skills of [false, true]) {
      for (const shared of [false, true]) {
        for (const voice of [false, true]) {
          const name = [skills && "skills", shared && "shared", voice && "voice", !chief && "non-chief"]
            .filter(Boolean).join("+") || "default";
          all[name] = {
            env: {
              OMB_SKILL_AUTHORING_ENABLED: flag(skills),
              OMB_SHARED_COMPUTERS_ENABLED: flag(shared),
              OMB_VOICE_NOTES: flag(voice),
              OMB_CHIEF_OF_STAFF: flag(chief),
              OMB_COMPUTER_SELECTION: "1",
            },
          };
        }
      }
    }
  }
  for (const name of ["skills+shared+voice", "skills+shared+voice+non-chief"]) {
    all[`${name}+cloud-home`] = { env: { ...all[name]!.env, OMB_CLOUD_HOME: "1" } };
  }
  all["skills+shared+voice+escalations"] = { env: { ...all["skills+shared+voice"]!.env, OMB_ESCALATIONS: "1" } };
  // Research is on only with a treg key or a Cloud plan and the bot's switch; the fullest profile carries it.
  all["skills+shared+voice+escalations+x"] = { env: { ...all["skills+shared+voice+escalations"]!.env, OMB_X_RESEARCH: "1", OMB_RESEARCH: "1" } };
  // A Team Cloud mounts message_person; the fullest profile carries it.
  all["skills+shared+voice+escalations+x+team"] = { env: { ...all["skills+shared+voice+escalations+x"]!.env, OMB_TEAM_PEOPLE: "1" } };
  all["default+legacy-switches"] = {
    env: { ...all.default!.env, OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1", OMB_EXTERNAL_RUNTIME: "1", OMB_ACTIVE_WAITS: "0" },
  };
  // The person's Hezuo holds a Chief's powers and adds its notification pair; HEZUO_ADDS bounds what that costs.
  for (const name of ["default", "skills+shared+voice"]) all[`${name}+hezuo`] = { env: { ...all[name]!.env, OMB_HEZUO: "1" } };
  // A chat that can never pick its computer: its Works on is Off, or it works on its team's computer. A room is one too.
  all["default+no-computer-pick"] = { env: { ...all.default!.env, OMB_COMPUTER_SELECTION: "0" } };
  for (const name of ["default", "non-chief"]) all[`${name}+room`] = { env: { ...all[name]!.env, OMB_COMPUTER_SELECTION: "0", OMB_ROOM: "1" } };
  return all;
}

const PROFILES = profiles();
const CHIEF_ONLY_TOOLS = ["create_bot", "list_team_setup", "list_team_library", "propose_team_setup", "propose_bot_deletion", "manage_room", "retry_thread"];
const CHIEF_TARGET_TOOLS = ["propose_profile", "propose_model"];
const CHIEF_PROFILE_TARGET = " A Chief of Staff may pass for_bot_id (from list_bots) for a requested change to another bot in its section.";
const TEAMWORK_TOOLS = ["list_room_targets", "coordinate_bots", "assignment_status", "list_bots", "list_rooms", "list_threads", "close_thread", "start_thread", "post_to_room"];
const HEZUO_TOOLS = ["list_unread_notifications", "mark_notifications_read"];
/** Hezuo's tools may make its list at most this much longer than the same Chief's without them. */
const HEZUO_ADDS = 0.02;
const RESEARCH_TOOLS = ["x_search", "research_search", "research_endpoint", "research_call"];
/** Only on the person's own Cloud: never on the fullest profile, a Team Cloud's. */
const OWN_CLOUD_TOOLS = ["ask_for_computer"];
const FULL = "skills+shared+voice+escalations+x+team";


const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":';

/** One tools/list `result` from a fresh proxy, sliced out of the raw stdout line, never re-serialized. */
async function toolsListWire(entry: string, env: Record<string, string>): Promise<string> {
  // A developer shell or an Hezuo turn can carry OMB_* switches; the profile must be the only source.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const child = spawn(process.execPath, [entry], {
    env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-golden", OMB_THREAD_ID: "thread-golden", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(buffer.slice(0, newline));
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`agents proxy exited (${code}) before answering tools/list`)));
      // stdin stays open until the answer is read: on Windows a pipe write in flight dies with the proxy.
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    });
    expect(line.startsWith(RPC_PREFIX) && line.endsWith("}")).toBe(true);
    return line.slice(RPC_PREFIX.length, -1);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

async function wireForEveryProfile(entry: string): Promise<Record<string, string>> {
  const names = Object.keys(PROFILES);
  const wires = await Promise.all(names.map((name) => toolsListWire(entry, PROFILES[name]!.env)));
  return Object.fromEntries(names.map((name, index) => [name, wires[index]!]));
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
type Tool = { name: string };
const toolsOf = (wire: string) => (JSON.parse(wire) as { tools: Tool[] }).tools;


let wires: Record<string, string> = {};

beforeAll(async () => {
  wires = await wireForEveryProfile(PROXY_SOURCE);
}, 120_000);

describe("agents proxy tools/list golden", () => {

  it("offers the three wait tools right after the trigger tools in every chat, with or without a wait, and none in a room", () => {
    for (const [name, wire] of Object.entries(wires)) {
      const names = toolsOf(wire).map((tool) => tool.name);
      const at = names.indexOf("delete_trigger");
      expect(at, name).toBeGreaterThan(-1);
      const waits = PROFILES[name]!.env.OMB_ROOM === "1" ? [] : ["wait_until", "list_waits", "cancel_wait"];
      expect(names.slice(at + 1, at + 1 + waits.length), name).toEqual(waits);
      expect(names.filter((tool) => /wait/.test(tool) && tool !== "assignment_status"), name).toEqual(waits);
    }
  });


  it("every profile is a by-name subset of the full golden, tool bytes included", () => {
    const full = new Map(toolsOf(wires[FULL]!).map((tool) => [tool.name, JSON.stringify(tool)]));
    for (const [name, profile] of Object.entries(PROFILES)) {
      for (const tool of toolsOf(wires[name]!)) {
        if (profile.env.OMB_CLOUD_HOME === "1" && (tool.name === "select_computer" || OWN_CLOUD_TOOLS.includes(tool.name))) continue;
        if (profile.env.OMB_CHIEF_OF_STAFF === "0" && CHIEF_TARGET_TOOLS.includes(tool.name)) continue;
        if (profile.env.OMB_HEZUO === "1" && HEZUO_TOOLS.includes(tool.name)) continue;
        expect(JSON.stringify(tool), `${name}: ${tool.name}`).toBe(full.get(tool.name));
      }
    }
  });

  it("gives every turn the one teamwork surface, with start_thread on the bot itself", () => {
    type SchemaTool = Tool & { description: string; inputSchema: { properties: Record<string, { enum?: string[]; description?: string }> } };
    for (const [name, wire] of Object.entries(wires)) {
      const tools = new Map((toolsOf(wire) as SchemaTool[]).map((tool) => [tool.name, tool]));
      for (const tool of TEAMWORK_TOOLS) expect(tools.has(tool), `${name}: ${tool}`).toBe(true);
      for (const alias of ["delegate_bot", "ask_bot", "send_to_bot", "check_delegation", "wait_delegation"]) expect(tools.has(alias), `${name}: ${alias}`).toBe(false);
      expect(JSON.stringify([...tools.values()])).not.toMatch(/Deprecated alias|works for this release/);
      const coordinate = tools.get("coordinate_bots")!.inputSchema.properties;
      expect(Object.keys(coordinate)).toEqual(["group_id", "bot_ids", "message", "reason", "rework", "thread", "title", "in_my_folder", "reply", "consult", "done_when", "answers"]);
      expect(coordinate.thread).toMatchObject({ type: "string", description: expect.stringContaining("threadId") });
      expect(coordinate.thread!.enum).toBeUndefined();
      expect(coordinate.reply!.enum).toEqual(["resume", "none"]);
      expect(Object.keys(tools.get("assignment_status")!.inputSchema.properties)).toEqual(["id", "wait_ms"]);
      expect(tools.get("start_thread")!.inputSchema.properties.bot_id!.enum).toEqual(["bot-golden"]);
      expect(wire).not.toMatch(/Brief synchronous consultation|DEFAULT FOR ASSIGNING WORK|BLOCKING status tool/);
    }
  });

  it("mounts raise_escalation only where chief escalations are on", () => {
    const names = (wire: string) => toolsOf(wire).map((tool) => tool.name);
    expect(names(wires["skills+shared+voice+escalations"]!).filter((tool) => tool !== "raise_escalation")).toEqual(names(wires["skills+shared+voice"]!));
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(names(wires[name]!).includes("raise_escalation"), name).toBe(profile.env.OMB_ESCALATIONS === "1");
    }
  });

  it("mounts message_person only on a Team Cloud, and adds nothing else", () => {
    const names = (wire: string) => toolsOf(wire).map((tool) => tool.name);
    expect(names(wires[FULL]!).filter((tool) => tool !== "message_person")).toEqual(names(wires["skills+shared+voice+escalations+x"]!));
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(names(wires[name]!).includes("message_person"), name).toBe(profile.env.OMB_TEAM_PEOPLE === "1");
    }
  });

  it("mounts ask_for_computer only on a person's own Cloud that is lent their computer, never a Team Cloud", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(toolsOf(wires[name]!).some((tool) => tool.name === "ask_for_computer"), name)
        .toBe(profile.env.OMB_CLOUD_HOME === "1" && profile.env.OMB_SHARED_COMPUTERS_ENABLED === "1" && profile.env.OMB_TEAM_PEOPLE !== "1");
    }
    const team = catalogProfileFromEnv({ ...PROFILES["skills+shared+voice+cloud-home"]!.env, OMB_TEAM_PEOPLE: "1", OMB_BOT_ID: "bot-golden" });
    expect(availableTools(team).map((tool) => tool.name)).not.toContain("ask_for_computer");
  });

  it("ignores the switches that once picked a catalog profile", () => {
    expect(wires["default+legacy-switches"]).toBe(wires.default);
    const profile = catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", OMB_CHIEF_OF_STAFF: "1", OMB_COMPUTER_SELECTION: "1", OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1", OMB_EXTERNAL_RUNTIME: "1", OMB_ACTIVE_WAITS: "0" });
    expect(JSON.stringify({ tools: availableTools(profile) })).toBe(wires.default);
    expect(profile).not.toHaveProperty("activeWaits");
    expect(profile).not.toHaveProperty("coordinating");
    expect(profile).not.toHaveProperty("externalRuntime");
    expect(profile).not.toHaveProperty("ownThreadCreation");
  });

  it("shows a Cloud home's bots no Local VM and no this computer, and every other server both", () => {
    type SelectTool = Tool & { inputSchema: { properties: { surface: { enum: string[]; description: string } } } };
    const select = (wire: string) => toolsOf(wire).find((tool) => tool.name === "select_computer") as SelectTool;
    const cloudHome = Object.keys(PROFILES).filter((name) => name.endsWith("+cloud-home"));
    expect(cloudHome).toHaveLength(2);
    for (const name of cloudHome) {
      const desktop = wires[name.slice(0, -"+cloud-home".length)]!;
      const names = toolsOf(wires[name]!).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(OWN_CLOUD_TOOLS));
      expect(names.filter((tool) => !OWN_CLOUD_TOOLS.includes(tool))).toEqual(toolsOf(desktop).map((tool) => tool.name).filter((tool) => tool !== "vm_exec"));
      expect(select(desktop).inputSchema.properties.surface.enum).toEqual(["auto", "cloud", "vm", "local", "browser"]);
      expect(toolsOf(desktop).map((tool) => tool.name)).toContain("vm_exec");
      const surface = select(wires[name]!).inputSchema.properties.surface;
      expect(surface.enum).toEqual(["auto", "cloud", "browser"]);
      expect(surface.description).not.toMatch(/\b(?:vm|local) =/);
    }
  });

  it("shows only a Chief of Staff the Chief-only tools, and for_bot_id on another bot's profile or model", () => {
    type SchemaTool = Tool & { description: string; inputSchema: { properties: Record<string, unknown> } };
    const nonChief = Object.keys(PROFILES).filter((name) => PROFILES[name]!.env.OMB_CHIEF_OF_STAFF === "0");
    expect(nonChief).toHaveLength(10);
    for (const name of nonChief) {
      const chiefTools = toolsOf(wires[name.startsWith("non-chief") ? name.replace("non-chief", "default") : name.replace("+non-chief", "")]!) as SchemaTool[];
      const tools = new Map((toolsOf(wires[name]!) as SchemaTool[]).map((tool) => [tool.name, tool]));
      expect(chiefTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(CHIEF_ONLY_TOOLS));
      expect([...tools.keys()], name).toEqual(chiefTools.map((tool) => tool.name).filter((tool) => !CHIEF_ONLY_TOOLS.includes(tool)));
      for (const chiefTool of chiefTools.filter((tool) => tools.has(tool.name))) {
        let expected: SchemaTool = chiefTool;
        if (CHIEF_TARGET_TOOLS.includes(chiefTool.name)) {
          const { for_bot_id: forBotId, ...properties } = chiefTool.inputSchema.properties;
          expect(forBotId, `${name}: ${chiefTool.name}`).toBeDefined();
          expected = { ...chiefTool, description: chiefTool.description.replace(CHIEF_PROFILE_TARGET, ""), inputSchema: { ...chiefTool.inputSchema, properties } };
        }
        expect(JSON.stringify(tools.get(chiefTool.name)), `${name}: ${chiefTool.name}`).toBe(JSON.stringify(expected));
      }
      expect(chiefTools.find((tool) => tool.name === "propose_profile")!.description).toContain(CHIEF_PROFILE_TARGET);
      expect(JSON.stringify(CHIEF_TARGET_TOOLS.map((tool) => tools.get(tool)))).not.toContain("for_bot_id");
      for (const trigger of ["trigger_info", "trigger", "delete_trigger"]) {
        expect(tools.get(trigger)!.inputSchema.properties, `${name}: ${trigger}`).toHaveProperty("for_bot_id");
      }
    }
  });

  it("leaves out only what a room, and a chat that can never pick its computer, would be refused", () => {
    const names = (name: string) => toolsOf(wires[name]!).map((tool) => tool.name);
    expect(names("default+no-computer-pick")).toEqual(names("default").filter((tool) => tool !== "select_computer"));
    for (const name of ["default", "non-chief"]) {
      expect(names(`${name}+room`), name).toEqual(names(name).filter((tool) => !["select_computer", "show_widget", "show_html", "wait_until", "list_waits", "cancel_wait"].includes(tool)));
    }
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(names(name).includes("select_computer"), name).toBe(profile.env.OMB_COMPUTER_SELECTION === "1");
      expect(names(name).includes("show_widget"), name).toBe(profile.env.OMB_ROOM !== "1");
      expect(names(name).includes("wait_until"), name).toBe(profile.env.OMB_ROOM !== "1");
    }
  });

  it("shows the X and research tools only where research is on, and adds nothing else", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const names = toolsOf(wires[name]!).map((tool) => tool.name);
      for (const tool of RESEARCH_TOOLS) expect(names.includes(tool), `${name}: ${tool}`).toBe(profile.env.OMB_X_RESEARCH === "1" && profile.env.OMB_RESEARCH === "1");
    }
    const switchedOn = Object.keys(PROFILES).filter((name) => name.endsWith("+x"));
    expect(switchedOn).toHaveLength(1);
    for (const name of switchedOn) {
      const without = toolsOf(wires[name.slice(0, -"+x".length)]!).map((tool) => tool.name);
      expect(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => !RESEARCH_TOOLS.includes(tool))).toEqual(without);
      // A plan's relay can have X without research: x_search alone, and nothing else changes.
      const xOnly = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...PROFILES[name]!.env, OMB_RESEARCH: "0" })).map((tool) => tool.name);
      expect(xOnly).toEqual(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => tool === "x_search" || !RESEARCH_TOOLS.includes(tool)));
    }
  });

  it("is what the catalog module computes in-process, so another front end mounts the same tools", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const tools = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot-golden", ...profile.env }));
      expect(JSON.stringify({ tools }), name).toBe(wires[name]);
    }
  });

  it("writes the trigger fields out once, for every action of the trigger tool", () => {
    type TriggerTool = Tool & { inputSchema: { properties: Record<string, unknown> } };
    const trigger = toolsOf(wires[FULL]!).find((tool) => tool.name === "trigger") as TriggerTool;
    expect(Object.keys(trigger.inputSchema.properties)).toEqual(expect.arrayContaining(["action", "trigger_id", "when", "name", "instructions", "schedule", "filter", "event_config", "run_on", "timeout_minutes", "clear_timeout", "continuity", "overlap", "run_on_startup", "for_bot_id"]));
    expect(trigger.inputSchema.properties).not.toHaveProperty("changes");
    for (const wire of Object.values(wires)) expect(wire.match(/"every_minutes":/g)).toHaveLength(1);
  });

  it("uses no JSON-Schema keyword a provider conversion is known to drop or mangle", () => {
    for (const [name, wire] of Object.entries(wires)) {
      expect(wire.match(/"(\$ref|\$defs|definitions|oneOf|anyOf|allOf)":/g), name).toBeNull();
    }
  });
});

describe("agents proxy tools/list from the packaged bundle", () => {
  let directory = "";
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("serves the same bytes with no source tree beside it", async () => {
      // Same esbuild options as scripts/bundle-server.mjs: the proxy runs as its own process from one inlined file.
    directory = realpathSync(mkdtempSync(join(tmpdir(), "omb-agents-proxy-bundle-")));
    await build({
      entryPoints: [PROXY_SOURCE],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outbase: join(HERE, ".."),
      outdir: directory,
      logLevel: "silent",
    });
    const bundled = join(directory, "drivers", "agents-proxy.js");
    expect(existsSync(bundled)).toBe(true);
    expect(readFileSync(bundled, "utf8")).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(await wireForEveryProfile(bundled)).toEqual(wires);
  }, 120_000);
});

describe("agents proxy tools/list wire size", () => {

  it.each(Object.keys(PROFILES).filter((name) => name.endsWith("+hezuo")))("%s adds at most 2% to the same Chief's list", (name) => {
    const without = name.slice(0, -"+hezuo".length);
    const tools = toolsOf(wires[name]!).map((tool) => tool.name);
    expect(tools.slice(-HEZUO_TOOLS.length)).toEqual(HEZUO_TOOLS);
    expect(tools.slice(0, -HEZUO_TOOLS.length)).toEqual(toolsOf(wires[without]!).map((tool) => tool.name));
    expect(bytes(wires[name]!)).toBeLessThanOrEqual(Math.floor(bytes(wires[without]!) * (1 + HEZUO_ADDS)));
  });

});
