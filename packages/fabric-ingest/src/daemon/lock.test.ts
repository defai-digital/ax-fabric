import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLock, releaseLock } from "./lock.js";

let workdir: string;
let lockPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lock-test-"));
  lockPath = join(workdir, "daemon.lock");
});

afterEach(() => {
  // Clean up any lock file that may have been left by the test.
  releaseLock(lockPath);
  rmSync(workdir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("returns acquired: true on a fresh path and writes PID to the lock file", () => {
    const result = acquireLock(lockPath);
    expect(result.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    const pid = readFileSync(lockPath, "utf8").trim();
    expect(pid).toBe(String(process.pid));
  });

  it("returns the resolved lockPath in the result", () => {
    const result = acquireLock(lockPath);
    expect(result.lockPath).toBeTruthy();
    expect(typeof result.lockPath).toBe("string");
  });

  it("creates parent directories if they don't exist", () => {
    const nestedLock = join(workdir, "nested", "dir", "daemon.lock");
    const result = acquireLock(nestedLock);
    try {
      expect(result.acquired).toBe(true);
      expect(existsSync(nestedLock)).toBe(true);
    } finally {
      releaseLock(nestedLock);
    }
  });

  it("returns acquired: false when an already-running process holds the lock", () => {
    // Acquire once — simulates the live daemon.
    const first = acquireLock(lockPath);
    expect(first.acquired).toBe(true);

    // Second attempt from the same process (current PID) should fail because
    // the process is clearly alive.
    const second = acquireLock(lockPath);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBeDefined();
    expect(second.reason!.toLowerCase()).toContain("already running");
  });

  it("succeeds when the lock file contains a PID that does not exist (stale lock)", () => {
    // Write a lock file with a PID that will never be alive.
    writeFileSync(lockPath, "999999999");

    const result = acquireLock(lockPath);
    try {
      expect(result.acquired).toBe(true);
      // The new lock should contain our own PID.
      const pid = readFileSync(lockPath, "utf8").trim();
      expect(pid).toBe(String(process.pid));
    } finally {
      releaseLock(lockPath);
    }
  });

  it("succeeds when the lock file contains non-numeric content (corrupted lock)", () => {
    // Corrupted content — parseInt returns NaN, treated as stale.
    writeFileSync(lockPath, "not-a-pid");

    const result = acquireLock(lockPath);
    try {
      expect(result.acquired).toBe(true);
    } finally {
      releaseLock(lockPath);
    }
  });

  it("succeeds when the lock file is empty (treated as stale)", () => {
    writeFileSync(lockPath, "");

    const result = acquireLock(lockPath);
    try {
      expect(result.acquired).toBe(true);
    } finally {
      releaseLock(lockPath);
    }
  });
});

describe("releaseLock", () => {
  it("removes the lock file after a successful acquire", () => {
    acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not throw when the lock file does not exist", () => {
    // No acquireLock call — just releasing a path that was never locked.
    expect(() => releaseLock(join(workdir, "never-locked.lock"))).not.toThrow();
  });

  it("is idempotent — calling release twice does not throw", () => {
    acquireLock(lockPath);
    releaseLock(lockPath);
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});
