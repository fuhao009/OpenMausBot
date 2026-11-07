// Where the companion keeps its settings and its sidecar's paired fleet. Pure filesystem work, no Electron: main owns
// when to point it at an account, and tests drive it with a throwaway folder.
import fs from "node:fs";
import path from "node:path";

/**
 * One launch's companion storage. `root` is the folder holding `companion-settings.json` and the sidecar's own
 * `companion/` folder; null means the app's userData and the sidecar's own default, which is what non-product launches
 * have always used. Point it at an account's folder before that account's runtime loads, never while a sidecar runs.
 */
export function createCompanionStorage({ userData, busy = () => false }) {
  if (typeof userData !== "function") throw new Error("Companion storage needs the app's userData folder.");
  let root = null;
  const settingsFile = () => path.join(root ?? userData(), "companion-settings.json");
  const settings = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      return { enabled: parsed?.enabled === true, keepAwake: parsed?.keepAwake === true };
    } catch {
      return { enabled: false, keepAwake: false };
    }
  };
  const remember = patch => {
    const file = settingsFile();
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const next = { ...settings(), ...patch };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
      fs.renameSync(temporary, file);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
      }
    }
  };
  return {
    configure(next = null) {
      if (busy()) throw new Error("Stop the companion before changing where it keeps its settings.");
      if (next !== null && (typeof next !== "string" || !path.isAbsolute(next) || next.includes("\0"))) {
        throw new Error("The companion storage folder must be an absolute path.");
      }
      root = next;
    },
    settings,
    enabledAtRest: () => settings().enabled,
    keepAwakeAtRest: () => settings().keepAwake,
    rememberEnabled: enabled => remember({ enabled }),
    rememberKeepAwake: keepAwake => remember({ keepAwake }),
    sidecarDirectory: () => (root === null ? null : path.join(root, "companion")),
  };
}

/**
 * The sidecar child's whole environment. Endpoint variables from the parent's environment are never inherited, and a
 * configured account folder wins over any inherited OMB_COMPANION_DIR so the paired fleet cannot land in another
 * account's folder or the home-directory default. Without a configured folder the inherited value stays, as before
 * product accounts. HOME stays untouched: the sidecar only reads it to find Tailscale.
 */
export function sidecarEnvironment({ base = {}, hostedUrl = null, secretPublicKey = null, internalOrigin = null, directory = null }) {
  const environment = { ...base };
  delete environment.OMB_COMPANION_HOSTED_URL;
  delete environment.OMB_COMPANION_INTERNAL_ORIGIN;
  delete environment.OMB_PHONE_SECRET_PUBLIC_KEY;
  if (directory !== null) environment.OMB_COMPANION_DIR = directory;
  if (hostedUrl) environment.OMB_COMPANION_HOSTED_URL = hostedUrl;
  if (internalOrigin) environment.OMB_COMPANION_INTERNAL_ORIGIN = internalOrigin;
  if (/^[A-Za-z0-9_-]{87}$/.test(String(secretPublicKey ?? ""))) environment.OMB_PHONE_SECRET_PUBLIC_KEY = secretPublicKey;
  return environment;
}
