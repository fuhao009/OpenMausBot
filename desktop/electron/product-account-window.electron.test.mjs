// The real account window, both preloads and their guards in a real Electron process.
// The Electron binary is located by path only: importing the electron module
// would start a network download on a machine whose install is incomplete.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL("./fixtures/product-account-smoke.cjs", import.meta.url));

function electronBinary() {
  const candidates = [];
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override) {
    for (const name of ["electron", "Electron.app/Contents/MacOS/Electron"]) candidates.push(path.join(override, name));
  }
  try {
    const directory = path.dirname(require.resolve("electron/package.json"));
    const relative = readFileSync(path.join(directory, "path.txt"), "utf8").trim();
    if (relative) candidates.push(path.join(directory, "dist", relative));
  } catch { /* an install without a downloaded binary simply skips */ }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

const electron = electronBinary();
const xvfb =
  process.platform === "linux" && !process.env.DISPLAY
    ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
    : "";
const canRun = Boolean(electron) &&
  (process.platform === "darwin" || process.platform === "win32" || (process.platform === "linux" && (Boolean(process.env.DISPLAY) || Boolean(xvfb))));

/** The fixture is disposable, so it inherits no account, model or API secret from this terminal. */
function fixtureEnvironment() {
  const scrubbed = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|SESSION|OTP|OPERATOR/i.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

async function runFixture() {
  const [command, args] = xvfb ? [xvfb, ["-a", electron, "--no-sandbox", fixture]] : [electron, ["--no-sandbox", fixture]];
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: fixtureEnvironment() });
    let stdout = "", stderr = "", done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\nfixture did not finish in 90 s` });
    }, 90_000);
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", error => finish({ code: null, stdout, stderr: `${stderr}\n${error?.message ?? error}` }));
    child.on("close", code => finish({ code, stdout, stderr }));
  });
}

it.runIf(canRun)(
  "the account window and both preloads work, isolated and guarded, in a real Electron app",
  async () => {
    const result = await runFixture();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("fixture-complete");
    expect(result.stdout, diagnostics).toContain('flags {"sandbox":true,"contextIsolation":true,"nodeIntegration":false}');
    expect(result.stdout, diagnostics).toContain('"hasNode":false');
    expect(result.stdout, diagnostics).toContain('"hasClose":true');
    expect(result.stdout, diagnostics).toContain('"state":{"auth":"signed_in"');
    expect(result.stdout, diagnostics).toContain('"badEmail"');
    expect(result.stdout, diagnostics).toContain('"badCursor"');
    expect(result.stdout, diagnostics).toContain('minted {"keys":["auth","runtime","user","ai"],"accountToken":false,"dataDir":false,"verifyCode":false}');
    expect(result.stdout, diagnostics).toContain('event {"auth":"signed_in","email":"person@example.test","leaked":false}');
    expect(result.stdout, diagnostics).toContain('guards {"calls":[]}');
    expect(result.stdout, diagnostics).toContain('navigation {"stayed":true,"state":null}');
    expect(result.stdout, diagnostics).toContain('"managed",{"hasAccount":"function","own":true');
    expect(result.stdout, diagnostics).toContain('"ordinary",{"hasAccount":"undefined","own":true');
    expect(result.stdout, diagnostics).toContain('"other-page",{"hasAccount":"undefined","own":false');
  },
  120_000,
);
