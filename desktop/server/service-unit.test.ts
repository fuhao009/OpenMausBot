import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/hezuo/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/hezuo/.hezuo", "--domain", "hezuo.example.com", "--no-pair"],
  dataDir: "/home/hezuo/.hezuo",
  user: "hezuo",
  home: "/home/hezuo",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/hezuo/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/Hezuo/server/hezuo.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=Hezuo (agentada)");
    expect(unit).toContain("User=hezuo");
    expect(unit).toContain("Environment=OMB_DATA_DIR=/home/hezuo/.hezuo");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/hezuo/cli.js serve --port 8799 --data-dir /home/hezuo/.hezuo --domain hezuo.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/hezuo/.hezuo"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/hezuo/My Data", serveArgs: ["--data-dir", "/home/hezuo/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/hezuo/cli.js serve --data-dir "/home/hezuo/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/hezuo", dataDir: "/Users/hezuo/.hezuo" });
    expect(plist).toContain("<string>com.hezuo.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>hezuo.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/hezuo/.hezuo/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/hezuo/.npm/_npx/abc123/node_modules/hezuo/cli.js")).toMatch(/npm install -g hezuo/);
    expect(unstableInstallWarning("/usr/lib/node_modules/hezuo/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/hezuo/.hezuo");
    expect(linux?.installed).toBe("/etc/systemd/system/hezuo.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now hezuo");
    const mac = servicePlan("darwin", "/Users/hezuo/.hezuo", "/Users/hezuo");
    expect(mac?.installed).toBe("/Users/hezuo/Library/LaunchAgents/com.hezuo.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/hezuo/Library/Application Support/hezuo-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/hezuo/cli.js", dataDir: "/Users/hezuo/.hezuo", home: "/Users/hezuo", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/hezuo/cli.js", "sentinel", "--once", "--data-dir", "/Users/hezuo/.hezuo", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/Hezuo/server/hezuo.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.hezuo.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".hezuo/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/hezuo");
    expect(mac?.files).toEqual([{ name: "com.hezuo.sentinel.plist", installed: "/Users/hezuo/Library/LaunchAgents/com.hezuo.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/hezuo/Library/LaunchAgents && cp '/Users/hezuo/Library/Application Support/hezuo-sentinel/com.hezuo.sentinel.plist' /Users/hezuo/Library/LaunchAgents/com.hezuo.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.hezuo.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/hezuo/cli.js", dataDir: "/home/hezuo/My Data", home: "/home/hezuo", out: "/home/hezuo/.local/state/hezuo-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/hezuo/cli.js sentinel --once --data-dir "/home/hezuo/My Data" --out /home/hezuo/.local/state/hezuo-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/hezuo");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/hezuo/.config/systemd/user/hezuo-sentinel.service", "/home/hezuo/.config/systemd/user/hezuo-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/hezuo/.local/state/hezuo-sentinel/hezuo-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now hezuo-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/Hezuo.app/Contents";
    const present = new Set([`${app}/MacOS/Hezuo`, `${app}/Resources/server/hezuo.js`]);
    expect(shippedSentinelCli("darwin", "/Users/hezuo", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/Hezuo`, script: `${app}/Resources/server/hezuo.js` });
    const user = "/Users/hezuo/Applications/Hezuo.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/hezuo", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/hezuo.js`);
    expect(shippedSentinelCli("linux", "/home/hezuo", (path) => path.startsWith("/opt/Hezuo/"))).toEqual({ node: "/opt/Hezuo/hezuo", script: "/opt/Hezuo/resources/server/hezuo.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/hezuo", (path) => path.endsWith("MacOS/Hezuo"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/hezuo", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\hezuo", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/Hezuo`, script: `${app}/Resources/server/hezuo.js`, dataDir: "/Users/hezuo/.hezuo", home: "/Users/hezuo", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/hezuo/100% $HOME\\", home: "/home/my hezuo", out: "/home/my hezuo/.local/state/hezuo-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my hezuo"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/hezuo/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/hezuo\n[Service]\nExecStartPre=/bin/true", "/home/hezuo\r", "/home/\0hezuo"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/hezuo/My Data", home: "/home/hezuo", out: "/home/hezuo/.local/state/hezuo-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/hezuo/.config/systemd/user/hezuo-sentinel.service";
    const timer = "/home/hezuo/.config/systemd/user/hezuo-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/hezuo", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/hezuo", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/omb/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/hezuo", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/hezuo", fs([]))).toEqual({ status: "not_installed", unit: "/Users/hezuo/Library/LaunchAgents/com.hezuo.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/hezuo", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\hezuo", fs([]))).toEqual({ status: "unsupported" });
  });
});
