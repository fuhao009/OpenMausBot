// The login service is what makes the gateway survive a reboot: a launchd job
// whose file is written here, whose Node is a durable copy, and whose log is a
// single private file that cannot grow without bound. These tests never load a
// real job — they render and inspect the artifacts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { boundLogFile, prepareLogFile, trimLogFile } from "./local-gateway/log-bounding.mjs";
import { gatewayPlist, nodeCandidates, servicePaths, stageNode } from "./local-gateway/service.mjs";
import { d1DatabaseFiles, findAccountByEmail } from "./local-gateway/operator-bootstrap.mjs";

const temporary = [];

function scratch() {
  const directory = mkdtempSync(path.join(tmpdir(), "omb-service-"));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("gatewayPlist", () => {
  const spec = {
    node: "/Users/example/Library/ApplicationSupport/OpenMausBotGateway/service/node",
    script: "/Users/example/checkout/scripts/local-gateway.mjs",
    configPath: "/Users/example/Library/ApplicationSupport/OpenMausBotGateway/gateway.json",
    home: "/Users/example",
    workingDirectory: "/Users/example/Library/ApplicationSupport/OpenMausBotGateway",
    logPath: "/Users/example/Library/ApplicationSupport/OpenMausBotGateway/logs/gateway.log",
  };

  it("runs this gateway with its own config, at login, and keeps it alive after a crash", () => {
    const plist = gatewayPlist(spec);
    for (const argument of [spec.node, spec.script, "start", "--config", spec.configPath]) {
      expect(plist).toContain(`<string>${argument}</string>`);
    }
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
    expect(plist).toContain(`<key>StandardErrorPath</key>\n\t<string>${spec.logPath}</string>`);
    expect(plist).toContain(`<key>StandardOutPath</key>\n\t<string>${spec.logPath}</string>`);
    // Private files: launchd would create a missing log as 0644 without this.
    expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
    expect(plist).toContain("<key>OMB_LOCAL_LOG_FILE</key>");
  });

  it("carries paths only: no secret, token, or password variable", () => {
    const plist = gatewayPlist(spec);
    expect(plist).not.toMatch(/API_KEY|TOKEN|PASSWORD|SECRET/);
    // Exactly HOME, PATH, and the log location are exported.
    expect(plist.match(/<key>[A-Z_]+<\/key>/g)).toEqual([
      "<key>HOME</key>",
      "<key>PATH</key>",
      "<key>OMB_LOCAL_LOG_FILE</key>",
    ]);
  });

  it("escapes XML and refuses control characters", () => {
    expect(gatewayPlist({ ...spec, home: "/Users/a&b" })).toContain("<string>/Users/a&amp;b</string>");
    expect(() => gatewayPlist({ ...spec, home: "/Users/a\u0001b" })).toThrow(/control character/);
  });

  it("is a valid plist launchd understands", () => {
    const directory = scratch();
    const file = path.join(directory, "com.openmausbot.gateway.plist");
    writeFileSync(file, gatewayPlist(spec));
    // plutil parses it; anything launchd would reject is a parse failure here.
    expect(execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
    const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    expect(parsed.Label).toBe("com.openmausbot.gateway");
    expect(parsed.ProgramArguments).toEqual([spec.node, spec.script, "start", "--config", spec.configPath]);
    expect(parsed.EnvironmentVariables).toEqual({
      HOME: spec.home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OMB_LOCAL_LOG_FILE: spec.logPath,
    });
  });
});

describe("gatewayPlist ownership", () => {
  it("names exactly one config, so a second data directory is a different job", () => {
    const one = gatewayPlist({
      node: "/n", script: "/s.mjs", configPath: "/data/one/gateway.json",
      home: "/h", workingDirectory: "/data/one", logPath: "/data/one/logs/gateway.log",
    });
    const two = gatewayPlist({
      node: "/n", script: "/s.mjs", configPath: "/data/two/gateway.json",
      home: "/h", workingDirectory: "/data/two", logPath: "/data/two/logs/gateway.log",
    });
    expect(one).not.toBe(two);
    expect(one).toContain("--config</string>\n\t\t<string>/data/one/gateway.json");
  });
});

describe("servicePaths", () => {
  it("keeps the node copy, the plist, and the log inside the data directory except the LaunchAgent", () => {
    const paths = servicePaths({ dataDir: "/data/gw", home: "/Users/example" });
    expect(paths.node).toBe("/data/gw/service/node");
    expect(paths.installedPlist).toBe("/Users/example/Library/LaunchAgents/com.openmausbot.gateway.plist");
    expect(paths.log).toBe("/data/gw/logs/gateway.log");
  });
});

describe("stageNode", () => {
  it("copies the binary and verifies the copy runs", () => {
    const directory = scratch();
    const target = path.join(directory, "service", "node");
    const staged = stageNode({ source: process.execPath, target });
    expect(staged.path).toBe(target);
    expect(staged.major).toBeGreaterThanOrEqual(24);
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(execFileSync(target, ["--version"], { encoding: "utf8" }).trim()).toBe(`v${process.versions.node}`);
  });

  it("refuses a source that is not a working node", () => {
    const directory = scratch();
    const fake = path.join(directory, "node");
    writeFileSync(fake, "#!/bin/sh\nexit 3\n");
    chmodSync(fake, 0o755);
    expect(() => stageNode({ source: fake, target: path.join(directory, "copy") })).toThrow(/not a working node/);
    expect(existsSync(path.join(directory, "copy"))).toBe(false);
  });

  it("prefers a requested node, then the runtime install, then the running executable", () => {
    const candidates = nodeCandidates({
      requested: "/opt/custom/node",
      execPath: "/tmp/node-v24/bin/node",
      home: "/Users/example",
      exists: () => true,
    });
    expect(candidates).toEqual([
      "/opt/custom/node",
      "/Users/example/.local/share/openmausbot-runtime/node_modules/node/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/tmp/node-v24/bin/node",
    ]);
  });
});

describe("log bounding", () => {
  function grow(file, lines) {
    const text = Array.from({ length: lines }, (_, index) => `line ${String(index).padStart(6, "0")} padding\n`).join("");
    writeFileSync(file, text, { flag: "a" });
    return statSync(file).size;
  }

  it("creates the log 0600 and leaves a small one alone", () => {
    const directory = scratch();
    const file = path.join(directory, "logs", "gateway.log");
    prepareLogFile(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const lines = grow(file, 10);
    expect(trimLogFile(file, { maxBytes: 64 * 1024, retainBytes: 1024 })).toEqual({ trimmed: false, before: lines, after: lines });
  });

  it("keeps only the tail, starting on a line boundary, once the file is too large", () => {
    const directory = scratch();
    const file = path.join(directory, "gateway.log");
    prepareLogFile(file);
    const before = grow(file, 5000);
    const result = trimLogFile(file, { maxBytes: 64 * 1024, retainBytes: 4096 });
    expect(result.trimmed).toBe(true);
    expect(result.before).toBe(before);
    const text = readFileSync(file, "utf8");
    expect(result.after).toBe(Buffer.byteLength(text));
    expect(result.after).toBeLessThanOrEqual(4096);
    // The newest line survives, and the file still starts at the beginning of one.
    expect(text.endsWith("line 004999 padding\n")).toBe(true);
    expect(text.startsWith("line ")).toBe(true);
    expect(text).not.toContain("line 000000");
  });

  it("does not follow a symlink or a directory", () => {
    const directory = scratch();
    const real = path.join(directory, "real.log");
    const link = path.join(directory, "link.log");
    writeFileSync(real, "x".repeat(128 * 1024));
    execFileSync("ln", ["-s", real, link]);
    expect(() => prepareLogFile(link)).toThrow(/symlink/);
    expect(() => prepareLogFile(directory)).toThrow(/regular file/);
  });

  it("trims once immediately and never throws for a missing file", () => {
    const directory = scratch();
    const file = path.join(directory, "gateway.log");
    const bounding = boundLogFile(file, { intervalMs: 10_000 });
    expect(bounding.check()).toEqual({ trimmed: false, before: 0, after: 0 });
    bounding.stop();
    expect(trimLogFile(path.join(directory, "absent.log"))).toEqual({ trimmed: false, before: 0, after: 0 });
  });
});

describe("operator bootstrap", () => {
  function database(directory, rows) {
    const objectDirectory = path.join(directory, "state", "d1", "miniflare-D1DatabaseObject");
    mkdirSync(objectDirectory, { recursive: true });
    const file = path.join(objectDirectory, "database.sqlite");
    const script = [
      'CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, "emailVerified" INTEGER NOT NULL);',
      'CREATE TABLE account_ai_balances (owner_user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, available_micro_points INTEGER NOT NULL DEFAULT 0, reserved_micro_points INTEGER NOT NULL DEFAULT 0);',
      ...rows.map((row) => `INSERT INTO "user" VALUES ('${row.id}', 'x', '${row.email}', ${row.verified ?? 0});`),
      ...rows.map((row) => `INSERT INTO account_ai_balances VALUES ('${row.id}', 0, 0, 0);`),
    ].join("\n");
    execFileSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(file)});db.exec(${JSON.stringify(script)});db.close();`]);
    return objectDirectory;
  }

  it("finds exactly the registered address and reports its AI state", () => {
    const directory = scratch();
    database(directory, [{ id: "user-1", email: "chosen@example.com", verified: 1 }]);
    const account = findAccountByEmail({ dataDir: directory, email: "chosen@example.com" });
    expect(account).toMatchObject({
      id: "user-1",
      email: "chosen@example.com",
      emailVerified: true,
      ai: { enabled: false, availableMicroPoints: 0, reservedMicroPoints: 0 },
    });
  });

  it("answers null for an address that is not registered, never a guess", () => {
    const directory = scratch();
    database(directory, [{ id: "user-1", email: "chosen@example.com" }]);
    expect(findAccountByEmail({ dataDir: directory, email: "someone-else@example.com" })).toBeNull();
    // Matching is exact: a prefix or a different case of a different address is not the account.
    expect(findAccountByEmail({ dataDir: directory, email: "chosen@example.com.evil" })).toBeNull();
  });

  it("ignores Miniflare's metadata database and refuses two real databases", () => {
    const directory = scratch();
    const objectDirectory = database(directory, [{ id: "user-1", email: "chosen@example.com" }]);
    writeFileSync(path.join(objectDirectory, "metadata.sqlite"), "");
    expect(d1DatabaseFiles(directory).map((file) => path.basename(file))).toEqual(["database.sqlite"]);

    execFileSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(path.join(objectDirectory, "second.sqlite"))});db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, "emailVerified" INTEGER);INSERT INTO "user" VALUES (\\'user-2\\', \\'chosen@example.com\\', 0);');db.close();`]);
    expect(() => findAccountByEmail({ dataDir: directory, email: "chosen@example.com" })).toThrow(/refusing to guess/);
  });

  it("reports no database rather than an empty one when nothing has run yet", () => {
    expect(d1DatabaseFiles(scratch())).toEqual([]);
  });
});
