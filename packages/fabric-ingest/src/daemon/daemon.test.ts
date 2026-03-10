/**
 * Tests for daemon modules: lock, budget, and lifecycle.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireLock, releaseLock } from "./lock.js";
import { checkBudget } from "./budget.js";

// ─── Lock ─────────────────────────────────────────────────────────────────────

describe("acquireLock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "daemon-lock-test-"));
  });

  afterEach(() => {
    // Clean up lock files.
    const lockPath = join(tmpDir, "test.lock");
    releaseLock(lockPath);
  });

  it("acquires a lock when no lock file exists", () => {
    const lockPath = join(tmpDir, "test.lock");
    const result = acquireLock(lockPath);

    expect(result.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    const content = readFileSync(lockPath, "utf8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("fails to acquire when lock is held by current process", () => {
    const lockPath = join(tmpDir, "test.lock");

    // First acquisition succeeds.
    const first = acquireLock(lockPath);
    expect(first.acquired).toBe(true);

    // Second acquisition fails (same process, but O_EXCL prevents double-create).
    const second = acquireLock(lockPath);
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain("already running");
  });

  it("detects stale lock from non-existent PID", () => {
    const lockPath = join(tmpDir, "test.lock");

    // Write a lock file with a PID that doesn't exist.
    writeFileSync(lockPath, "9999999");

    const result = acquireLock(lockPath);
    expect(result.acquired).toBe(true);
  });

  it("handles corrupt lock file gracefully", () => {
    const lockPath = join(tmpDir, "test.lock");

    // Write garbage to lock file.
    writeFileSync(lockPath, "not-a-pid");

    // Should treat as stale (can't parse PID).
    const result = acquireLock(lockPath);
    expect(result.acquired).toBe(true);
  });
});

describe("releaseLock", () => {
  it("removes the lock file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "daemon-lock-release-"));
    const lockPath = join(tmpDir, "test.lock");

    acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is a no-op if lock file does not exist", () => {
    const lockPath = join(tmpdir(), "nonexistent-lock.lock");
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});

// ─── Budget ───────────────────────────────────────────────────────────────────

describe("checkBudget", () => {
  it("returns 'normal' when under 70%", () => {
    const result = checkBudget(5 * 1024 * 1024 * 1024, 50);
    expect(result.action).toBe("normal");
    expect(result.percent).toBe(10);
  });

  it("returns 'warn' between 70-85%", () => {
    const maxGb = 10;
    const usedBytes = 7.5 * 1024 * 1024 * 1024; // 75%
    const result = checkBudget(usedBytes, maxGb);
    expect(result.action).toBe("warn");
    expect(result.percent).toBe(75);
  });

  it("returns 'compact' between 85-95%", () => {
    const maxGb = 10;
    const usedBytes = 9 * 1024 * 1024 * 1024; // 90%
    const result = checkBudget(usedBytes, maxGb);
    expect(result.action).toBe("compact");
    expect(result.percent).toBe(90);
  });

  it("returns 'skip' above 95%", () => {
    const maxGb = 10;
    const usedBytes = 9.8 * 1024 * 1024 * 1024; // 98%
    const result = checkBudget(usedBytes, maxGb);
    expect(result.action).toBe("skip");
    expect(result.percent).toBeCloseTo(98, 0);
  });

  it("returns correct maxBytes", () => {
    const result = checkBudget(0, 50);
    expect(result.maxBytes).toBe(50 * 1024 * 1024 * 1024);
  });

  it("handles zero max storage", () => {
    const result = checkBudget(100, 0);
    expect(result.percent).toBe(0);
    expect(result.action).toBe("normal");
  });

  it("returns exact percentages", () => {
    const maxGb = 100;
    const usedBytes = 71 * 1024 * 1024 * 1024;
    const result = checkBudget(usedBytes, maxGb);
    expect(result.percent).toBeCloseTo(71, 0);
    expect(result.action).toBe("warn");
  });

  it("handles exact threshold boundaries", () => {
    const maxGb = 100;

    const at70 = checkBudget(70 * 1024 * 1024 * 1024, maxGb);
    expect(at70.action).toBe("normal"); // 70 is not > 70

    const at85 = checkBudget(85 * 1024 * 1024 * 1024, maxGb);
    expect(at85.action).toBe("warn"); // 85 is not > 85

    const at95 = checkBudget(95 * 1024 * 1024 * 1024, maxGb);
    expect(at95.action).toBe("compact"); // 95 is not > 95
  });
});
