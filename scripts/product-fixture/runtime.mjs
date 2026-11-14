// Locates the pinned Electron binary and the Miniflare runtime that matches the
// repository's own Wrangler, and the SQL splitter Wrangler uses for D1
// migrations. Everything resolves through this checkout: no download, no
// global install, no user data.
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_WORKER_PROJECT = join(ROOT, "gateway", "control-plane");

export function workerProjectPaths(project = DEFAULT_WORKER_PROJECT) {
  const root = realpathSync(resolve(project));
  const paths = { root, workerEntry: join(root, "src", "index.ts"), migrations: join(root, "migrations"), controlPlanePackage: join(root, "package.json") };
  for (const path of [paths.workerEntry, paths.migrations, paths.controlPlanePackage]) {
    if (!existsSync(path)) throw new Error(`Worker project path is missing: ${path}`);
  }
  return paths;
}

function requireFrom(base, specifier) {
  return createRequire(join(base, "package.json")).resolve(specifier);
}

/** The Electron executable: `--app`, `ELECTRON_OVERRIDE_DIST_PATH`,
 * `OMB_VERIFY_ELECTRON`, the local install, else null. Never installs one. */
export function electronBinary(environment = process.env) {
  const candidates = [];
  if (environment.ELECTRON_OVERRIDE_DIST_PATH) {
    for (const name of ["electron", "Electron.app/Contents/MacOS/Electron"]) {
      candidates.push(join(environment.ELECTRON_OVERRIDE_DIST_PATH, name));
    }
  }
  if (environment.OMB_VERIFY_ELECTRON) candidates.push(environment.OMB_VERIFY_ELECTRON);
  try {
    const manifest = requireFrom(ROOT, "desktop/electron/package.json");
    const directory = dirname(manifest);
    const relative = readFileSync(join(directory, "path.txt"), "utf8").trim();
    if (relative) candidates.push(join(directory, "dist", relative));
  } catch { /* an install without a downloaded binary simply has no candidate */ }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** The executable inside an installed app bundle (`--app`). */
export function packagedBinary(app) {
  if (!app) return null;
  const mac = join(app, "Contents", "MacOS");
  if (existsSync(mac)) {
    const executable = readFileSync(join(app, "Contents", "Info.plist"), "utf8")
      .match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (executable && existsSync(join(mac, executable))) return join(mac, executable);
    return null;
  }
  return existsSync(app) ? app : null;
}

const runtimes = new Map();
/** Miniflare from the Wrangler the control-plane project pins (the same
 * runtime `wrangler dev` would use). */
export async function miniflareRuntime(project = DEFAULT_WORKER_PROJECT) {
  if (runtimes.has(project)) return runtimes.get(project);
  const wranglerEntry = requireFrom(project, "wrangler");
  const miniflarePath = createRequire(wranglerEntry).resolve("miniflare");
  const loaded = await import(pathToFileURL(miniflarePath).href);
  if (typeof loaded.Miniflare !== "function" || typeof loaded.convertV4MiniflareOptions !== "function") {
    throw new Error("miniflare_missing_exports");
  }
  runtimes.set(project, loaded);
  return loaded;
}

/** Wrangler's own statement splitter, so a migration with triggers applies as
 * `wrangler d1 migrations apply` would. */
export async function sqlSplitter(project = DEFAULT_WORKER_PROJECT) {
  const entry = requireFrom(project, "wrangler");
  const loaded = await import(pathToFileURL(entry).href);
  if (typeof loaded.unstable_splitSqlQuery !== "function") throw new Error("wrangler_splitter_missing");
  return loaded.unstable_splitSqlQuery;
}

export async function esbuild() {
  return import(pathToFileURL(requireFrom(ROOT, "esbuild")).href);
}

export const PATHS = Object.freeze({
  workerEntry: join(DEFAULT_WORKER_PROJECT, "src", "index.ts"),
  migrations: join(DEFAULT_WORKER_PROJECT, "migrations"),
  uiDist: join(ROOT, "dist"),
  serverDist: join(ROOT, "dist-server", "index.js"),
  controlPlanePackage: join(DEFAULT_WORKER_PROJECT, "package.json"),
});
