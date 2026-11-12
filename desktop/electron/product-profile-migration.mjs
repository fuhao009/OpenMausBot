import fs from "node:fs";
import path from "node:path";
import { retireLegacyDataDirLeases } from "./data-dir-lease.mjs";

// Migration-only OS encryption identity and predecessor profile; never rename these literals.
const LEGACY_PRODUCT_IDENTITY = "OpenMausBot Product";
const PRODUCT_IDENTITY = "Hezuo Product";
const ENCRYPTION_MARKER = ".legacy-product-encryption";

function entryExists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function retireProfileLeases(root) {
  retireLegacyDataDirLeases(root);
  const accounts = path.join(root, "product-accounts");
  if (!entryExists(accounts)) return;
  for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
    if (entry.isDirectory()) retireLegacyDataDirLeases(path.join(accounts, entry.name, "workspace"));
  }
}

/** Run before ready, before Chromium opens either profile. Never merge editions or profiles. */
export function migrateProductProfile({ app, isProduct, fixture = false }) {
  if (!isProduct || fixture) return null;
  const parent = app.getPath("appData");
  const source = path.join(parent, LEGACY_PRODUCT_IDENTITY);
  const destination = path.join(parent, PRODUCT_IDENTITY);
  const guard = path.join(parent, ".hezuo-product-profile-migration");
  fs.mkdirSync(parent, { recursive: true });
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (error) {
    throw new Error(`Cannot acquire profile migration guard ${guard}. Close all desktop/server processes; if no migration is running, remove only this empty guard directory and retry.`, { cause: error });
  }
  let sourceLock = false;
  try {
    if (entryExists(source)) {
      if (entryExists(destination)) throw new Error("Both previous and Hezuo Product profiles exist; refusing to merge or overwrite either profile.");
      if (!fs.lstatSync(source).isDirectory()) throw new Error("Previous Product profile is not a directory.");
      app.setPath("userData", source);
      if (!app.requestSingleInstanceLock()) throw new Error("Close the previous Product desktop before migrating its profile.");
      sourceLock = true;
      retireProfileLeases(source);
      // Persist before moving: a crash after rename must not select a new encryption key.
      fs.writeFileSync(path.join(source, ENCRYPTION_MARKER), "1\n", { mode: 0o600, flag: "w", flush: true });
      fs.renameSync(source, destination);
    } else if (!entryExists(destination)) {
      fs.mkdirSync(destination, { mode: 0o700 });
    }
    if (!fs.lstatSync(destination).isDirectory()) throw new Error("Hezuo Product profile is not a directory.");
    const legacyEncryption = entryExists(path.join(destination, ENCRYPTION_MARKER));
    app.setPath("userData", destination);
    app.setPath("sessionData", destination);
    // Electron 43 PostCreateMainMessageLoop snapshots the name into OSCrypt's
    // Linux config/mac KeychainPassword; PreMainMessageLoopRun creates async
    // providers. Both precede ready. Restore display identity only afterwards;
    // this does not switch/reinitialize encryption backends or rewrite ciphertext.
    // https://github.com/electron/electron/blob/v43.0.0/shell/browser/electron_browser_main_parts.cc
    // https://github.com/electron/electron/blob/v43.0.0/shell/browser/browser_process_impl.cc
    app.setName(legacyEncryption ? LEGACY_PRODUCT_IDENTITY : PRODUCT_IDENTITY);
    if (legacyEncryption) app.once("ready", () => app.setName(PRODUCT_IDENTITY));
    return { directory: destination, legacyEncryption };
  } finally {
    if (sourceLock) app.releaseSingleInstanceLock();
    fs.rmdirSync(guard);
  }
}
