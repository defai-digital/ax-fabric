import { describe, it, expect } from "vitest";
import { checkBudget } from "./budget.js";

const GB = 1024 * 1024 * 1024;

describe("checkBudget", () => {
  // ── Action thresholds ─────────────────────────────────────────────────────

  it("returns 'normal' when usage is below 70%", () => {
    const result = checkBudget(0.6 * 10 * GB, 10);
    expect(result.action).toBe("normal");
  });

  it("returns 'warn' when usage is between 70% and 85%", () => {
    const result = checkBudget(0.77 * 10 * GB, 10);
    expect(result.action).toBe("warn");
  });

  it("returns 'compact' when usage is between 85% and 95%", () => {
    const result = checkBudget(0.9 * 10 * GB, 10);
    expect(result.action).toBe("compact");
  });

  it("returns 'skip' when usage exceeds 95%", () => {
    const result = checkBudget(0.96 * 10 * GB, 10);
    expect(result.action).toBe("skip");
  });

  // ── Exact boundary values ─────────────────────────────────────────────────

  it("returns 'normal' at exactly 70% (threshold is exclusive)", () => {
    // percent === 70 → falls through all > conditions → normal
    const result = checkBudget(0.7 * 10 * GB, 10);
    expect(result.action).toBe("normal");
  });

  it("returns 'warn' just above 70%", () => {
    const result = checkBudget(0.7 * 10 * GB + 1, 10);
    expect(result.action).toBe("warn");
  });

  it("returns 'warn' at exactly 85%", () => {
    const result = checkBudget(0.85 * 10 * GB, 10);
    expect(result.action).toBe("warn");
  });

  it("returns 'compact' just above 85%", () => {
    const result = checkBudget(0.85 * 10 * GB + 1, 10);
    expect(result.action).toBe("compact");
  });

  it("returns 'compact' at exactly 95%", () => {
    const result = checkBudget(0.95 * 10 * GB, 10);
    expect(result.action).toBe("compact");
  });

  it("returns 'skip' just above 95%", () => {
    const result = checkBudget(0.95 * 10 * GB + 1, 10);
    expect(result.action).toBe("skip");
  });

  it("returns 'skip' at 100% usage", () => {
    const result = checkBudget(10 * GB, 10);
    expect(result.action).toBe("skip");
  });

  it("returns 'skip' when usedBytes exceeds maxBytes", () => {
    const result = checkBudget(15 * GB, 10);
    expect(result.action).toBe("skip");
  });

  // ── Return fields ─────────────────────────────────────────────────────────

  it("returns the correct usedBytes", () => {
    const used = 3 * GB;
    const result = checkBudget(used, 10);
    expect(result.usedBytes).toBe(used);
  });

  it("returns maxBytes derived from maxStorageGb", () => {
    const result = checkBudget(0, 4);
    expect(result.maxBytes).toBe(4 * GB);
  });

  it("returns the correct percent (rounded implicitly via floating point)", () => {
    const result = checkBudget(5 * GB, 10);
    expect(result.percent).toBeCloseTo(50, 5);
  });

  it("returns percent=0 when usedBytes is 0", () => {
    const result = checkBudget(0, 10);
    expect(result.percent).toBe(0);
    expect(result.action).toBe("normal");
  });

  // ── Zero maxStorageGb edge case ───────────────────────────────────────────

  it("returns percent=0 and action='normal' when maxStorageGb is 0", () => {
    const result = checkBudget(100, 0);
    expect(result.percent).toBe(0);
    expect(result.action).toBe("normal");
  });

  // ── Fractional GB limits ──────────────────────────────────────────────────

  it("handles sub-GB limits correctly", () => {
    // maxStorageGb = 0.5 GB = 536870912 bytes
    const maxBytes = 0.5 * GB;
    const result = checkBudget(maxBytes * 0.6, 0.5);
    expect(result.action).toBe("normal");
  });
});
