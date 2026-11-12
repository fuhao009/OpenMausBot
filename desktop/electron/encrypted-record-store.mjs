import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Electron 43's safeStorage.decryptStringAsync resolves to { shouldReEncrypt, result }; test fakes resolve to the string. */
const decryptedText = decrypted => typeof decrypted === "string" ? decrypted : decrypted?.result;

/** Never readable: not a small regular file, a key that no longer opens it (Windows reinstall), or not JSON. A locked keychain is never this. */
export const unreadableRecord = error => error?.code === "unreadable_record";
const unreadable = message => Object.assign(new Error(message), { code: "unreadable_record" });

/**
 * OS-encrypted JSON record at `file`; secrets never go into config.json, backups, renderer storage, environment variables or CLI homes.
 * The caller owns the file's name and contents: this module never changes either.
 */
export function createEncryptedRecordStore({ file, encryption }) {
  let tail = Promise.resolve();
  const available = async () => {
    if (!(await encryption.available())) throw new Error("Unlock your system keychain before reading or saving this record.");
  };
  return {
    async read() {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) throw unreadable("Invalid saved record.");
        await available();
        const encrypted = await handle.readFile();
        let text;
        try { text = decryptedText(await encryption.decrypt(encrypted)); } catch { throw unreadable("This computer can no longer decrypt the saved record."); }
        // Not unreadable(): an unknown decrypt shape is this app's mistake, and the record must not be removed.
        if (typeof text !== "string") throw new Error("Unexpected decrypt result.");
        try { return JSON.parse(text); } catch { throw unreadable("The saved record is not JSON."); }
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw Object.assign(new Error("The saved record could not be read. Unlock your system keychain and try again."),
          unreadableRecord(error) ? { code: error.code } : {});
      }
      finally { await handle?.close(); }
    },
    write(value) {
      const operation = tail.catch(() => {}).then(async () => {
        // Forgetting must work while the keychain is locked; the file is removed in the same queue as pending writes.
        if (value === null) {
          try { await fs.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
          return;
        }
        await available();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const encrypted = await encryption.encrypt(JSON.stringify(value));
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      tail = operation;
      return operation;
    },
  };
}
