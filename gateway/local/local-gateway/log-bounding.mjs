// A launchd job's stdout and stderr go to a file the job opens once, in append
// mode, and never reopens. Left alone that file grows for as long as the
// service runs. This module keeps it bounded: once the file passes an upper
// size, only its last `retainBytes` — starting on a line boundary — survive.
//
// Truncating in place is safe because the descriptor launchd handed us is
// O_APPEND: the next write lands at the new end of the file. Nothing here ever
// renames or reopens the log, so no writer is left pointing at an unlinked
// inode.
import {
  chmodSync, closeSync, constants as fsConstants, ftruncateSync, lstatSync, mkdirSync, openSync,
  readSync, statSync, writeSync,
} from "node:fs";
import path from "node:path";

/** 8 MiB triggers a trim; the tail kept afterwards is 512 KiB. */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 512 * 1024;
export const LOG_INTERVAL_MS = 30_000;

/** Creates the log directory (0700) and the file (0600), refusing a symlink
 * or a non-regular file. launchd creates a missing log itself, with the
 * process umask and no private mode, so the file must exist first. */
export function prepareLogFile(file) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  const existed = statOrNull(directory) !== null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Only a directory this call created is ours to tighten: an operator may
  // deliberately point the log at a directory with a different policy.
  if (!existed && process.platform !== "win32") chmodSync(directory, 0o700);
  // `stat` follows a link, `lstat` does not; the link itself is what must not
  // exist, since launchd would otherwise append through it.
  const link = statOrNull(absolute, { noFollow: true });
  if (link?.isSymbolicLink()) throw new Error(`${absolute} must not be a symlink`);
  if (link && !link.isFile()) throw new Error(`${absolute} must be a regular file`);
  if (!link) {
    closeSync(openSync(absolute, "a", 0o600));
  }
  if (process.platform !== "win32") chmodSync(absolute, 0o600);
  return absolute;
}

function statOrNull(file, { noFollow = false } = {}) {
  try {
    return noFollow ? lstatSync(file) : statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Trims `file` when it is larger than `maxBytes`, keeping the last
 * `retainBytes` from a line start. Safe to call while another process appends
 * (its next write goes to the new end). Returns what happened, never throws
 * for a missing file.
 */
export function trimLogFile(file, { maxBytes = LOG_MAX_BYTES, retainBytes = LOG_RETAIN_BYTES } = {}) {
  const absolute = path.resolve(file);
  let before;
  try {
    before = statSync(absolute).size;
  } catch (error) {
    if (error?.code === "ENOENT") return { trimmed: false, before: 0, after: 0 };
    throw error;
  }
  if (before <= maxBytes) return { trimmed: false, before, after: before };

  // O_NOFOLLOW: never trim through a symlink someone swapped in.
  const fd = openSync(absolute, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const window = Math.min(retainBytes, before);
    const buffer = Buffer.alloc(window);
    readSync(fd, buffer, 0, window, before - window);
    const newline = buffer.indexOf(0x0a);
    const tail = newline === -1 ? buffer : buffer.subarray(newline + 1);
    ftruncateSync(fd, 0);
    if (tail.length > 0) writeSync(fd, tail, 0, tail.length, 0);
    return { trimmed: true, before, after: tail.length };
  } finally {
    closeSync(fd);
  }
}

/**
 * Starts bounding `file`: once now (so a crash loop's earlier output is
 * trimmed before this run adds to it) and every `intervalMs` after. The timer
 * does not keep the process alive on its own.
 */
export function boundLogFile(file, options = {}) {
  const check = () => {
    try {
      return trimLogFile(file, options);
    } catch {
      // A log that cannot be trimmed must never take the gateway down.
      return null;
    }
  };
  check();
  const timer = setInterval(check, options.intervalMs ?? LOG_INTERVAL_MS);
  timer.unref?.();
  return {
    check,
    stop() {
      clearInterval(timer);
    },
  };
}
