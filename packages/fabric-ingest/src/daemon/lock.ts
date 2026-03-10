/**
 * Daemon lock file — prevents multiple daemon instances from running simultaneously.
 *
 * Uses `O_EXCL` for atomic create-or-fail semantics. Writes the current PID
 * to the lock file. Detects stale locks by checking if the PID is still alive.
 */

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  constants,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface LockResult {
  acquired: boolean;
  lockPath: string;
  reason?: string;
}

/**
 * Attempt to acquire the daemon lock.
 *
 * Returns `{ acquired: true }` on success or `{ acquired: false, reason }` on failure.
 * The lock file is automatically released on process exit (SIGINT, SIGTERM, exit).
 */
export function acquireLock(lockPath: string): LockResult {
  const resolvedPath = resolve(lockPath);

  // Ensure parent directory exists.
  mkdirSync(dirname(resolvedPath), { recursive: true });

  // Try to create the lock file atomically with O_EXCL (create-or-fail).
  // This is the correct POSIX approach: attempt first, inspect after failure.
  // It eliminates the TOCTOU race between existsSync() and openSync().
  let fd: number;
  try {
    fd = openSync(
      resolvedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o644,
    );
  } catch (err) {
    // Lock file already exists — check if the holder is still alive.
    const stalePid = readStalePid(resolvedPath);
    if (stalePid !== null && isProcessAlive(stalePid)) {
      return {
        acquired: false,
        lockPath: resolvedPath,
        reason: `Daemon already running (PID ${stalePid})`,
      };
    }

    // Stale lock (dead PID or unreadable file) — remove and retry once.
    try {
      unlinkSync(resolvedPath);
      fd = openSync(
        resolvedPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
    } catch {
      return {
        acquired: false,
        lockPath: resolvedPath,
        reason: `Failed to acquire lock at ${resolvedPath}`,
      };
    }
  }

  // Write PID.
  const pid = process.pid.toString();
  writeSync(fd, pid);
  closeSync(fd);

  // Register cleanup on process exit only. Do NOT register SIGINT/SIGTERM
  // handlers here — the daemon (watch.ts) manages graceful shutdown via its
  // own signal handlers. If we called process.exit() here, it would bypass
  // the daemon's "finish current cycle" logic and risk interrupting mid-write.
  const cleanup = () => {
    try {
      unlinkSync(resolvedPath);
    } catch {
      // Best effort.
    }
  };

  process.on("exit", cleanup);

  return { acquired: true, lockPath: resolvedPath };
}

/**
 * Release the daemon lock by removing the lock file.
 */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(resolve(lockPath));
  } catch {
    // Already removed or doesn't exist.
  }
}

function readStalePid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
