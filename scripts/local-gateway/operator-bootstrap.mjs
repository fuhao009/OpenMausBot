// Resolving an operator's account id without a session.
//
// The documented bootstrap is `whoami`: sign in with the account's own
// password (or code) and let the Worker name the id. That needs a running
// gateway and a credential the operator may not have yet. This module is the
// offline alternative: it reads the same D1 database Miniflare persists, while
// the gateway is stopped, and answers "which account id has this exact email?"
//
// It never writes: the caller opens the database read-only, every statement is
// a SELECT, and `PRAGMA query_only` is set before anything else. No account is
// created, no AI permission is opened, and no points are granted.
import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class AccountLookupError extends Error {}

/** The Miniflare D1 store for one data directory: the object directory and its
 * database files (Miniflare names them by hash, so they are discovered, not
 * assumed). The metadata database is not an account database. */
export function d1ObjectDirectory(dataDir) {
  return path.join(dataDir, "state", "d1", "miniflare-D1DatabaseObject");
}

export function d1DatabaseFiles(dataDir, readdir = readdirSync) {
  const directory = d1ObjectDirectory(dataDir);
  let names;
  try {
    names = readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .sort()
    .map((name) => path.join(directory, name));
}

function openReadOnly(file) {
  // A WAL that was never checkpointed still needs its `-shm`; opening normally
  // and turning on `query_only` lets SQLite read that state without writing.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA query_only = ON");
  return db;
}

function hasUserTable(db) {
  try {
    return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'user'").get() !== undefined;
  } catch {
    return false;
  }
}

function aiState(db, userId) {
  try {
    const row = db.prepare(
      'SELECT enabled, available_micro_points AS available, reserved_micro_points AS reserved FROM account_ai_balances WHERE owner_user_id = ?',
    ).get(userId);
    if (row === undefined) return { enabled: false, availableMicroPoints: 0, reservedMicroPoints: 0, row: false };
    return {
      enabled: row.enabled === 1 || row.enabled === true,
      availableMicroPoints: Number(row.available),
      reservedMicroPoints: Number(row.reserved),
      row: true,
    };
  } catch {
    // A database from before the AI migration has no balance table: that is
    // exactly "no permission, no points", not an error.
    return { enabled: false, availableMicroPoints: 0, reservedMicroPoints: 0, row: false };
  }
}

/**
 * The one account with this exact (already normalized) email, or null. An
 * address present in two database files is refused rather than guessed: two
 * stores in one data directory means the wrong one may be live.
 */
export function findAccountByEmail({ dataDir, email, files = d1DatabaseFiles(dataDir) }) {
  const found = [];
  for (const file of files) {
    let db;
    try {
      db = openReadOnly(file);
    } catch {
      continue;
    }
    try {
      if (!hasUserTable(db)) continue;
      const row = db.prepare('SELECT id, email, "emailVerified" AS verified FROM "user" WHERE lower(email) = lower(?)').get(email);
      if (row === undefined) continue;
      found.push({
        id: String(row.id),
        email: String(row.email),
        emailVerified: row.verified === 1 || row.verified === true || row.verified === "1",
        ai: aiState(db, String(row.id)),
        file,
      });
    } finally {
      db.close();
    }
  }
  if (found.length > 1) {
    throw new AccountLookupError(
      `${email} exists in ${found.length} local databases (${found.map((entry) => path.basename(entry.file)).join(", ")}); refusing to guess which one is live`,
    );
  }
  return found[0] ?? null;
}
