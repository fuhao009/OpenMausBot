import { lstatSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { retireLegacyDataDirLeases } from "./data-dir-lease.mjs";

function exists(file) {
  try { lstatSync(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Migration-only predecessor roots. Explicitly configured directories are never relocated. */
export function migrateDefaultDataRoot(home, configuredDirectory) {
  if (configuredDirectory !== undefined) return configuredDirectory;
  const destination = join(home, ".hezuo");
  const sources = [join(home, ".openmausbot"), join(home, ".opengrokbot")].filter(exists);
  if (!sources.length) return destination;
  const guard = join(home, ".hezuo-data-migration");
  try { mkdirSync(guard, { mode: 0o700 }); } catch (error) {
    throw new Error(`Cannot acquire data migration guard ${guard}. Close all desktop/server processes; if no migration is running, remove only this empty guard directory and retry.`, { cause: error });
  }
  try {
    if (sources.length > 1 || exists(destination)) throw new Error("Conflicting server data directories exist; refusing to merge or overwrite history.");
    const source = sources[0];
    if (!lstatSync(source).isDirectory()) throw new Error("Previous server data root is not a directory.");
    retireLegacyDataDirLeases(source);
    renameSync(source, destination);
    return destination;
  } finally {
    rmdirSync(guard);
  }
}
