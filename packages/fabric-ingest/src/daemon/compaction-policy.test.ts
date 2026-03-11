import { describe, it, expect } from "vitest";
import { SmartCompactionPolicy } from "./compaction-policy.js";
import type { CompactionInput } from "./compaction-policy.js";

function input(overrides: Partial<CompactionInput> = {}): CompactionInput {
  return {
    tombstoneCount: 0,
    filesScanned: 100,
    budgetPressure: false,
    cyclesSinceLastCompact: 0,
    ...overrides,
  };
}

describe("SmartCompactionPolicy — budget pressure", () => {
  it("triggers compaction immediately on budget pressure", () => {
    const policy = new SmartCompactionPolicy();
    const d = policy.evaluate(input({ budgetPressure: true }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe("budget_pressure");
  });

  it("budget pressure overrides density check", () => {
    const policy = new SmartCompactionPolicy({ tombstoneDensityThreshold: 0.01 });
    // Even with zero tombstones, budget pressure compacts
    const d = policy.evaluate(input({ budgetPressure: true, tombstoneCount: 0 }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe("budget_pressure");
  });
});

describe("SmartCompactionPolicy — tombstone density", () => {
  it("triggers when density >= threshold", () => {
    const policy = new SmartCompactionPolicy({ tombstoneDensityThreshold: 0.3 });
    // 30 tombstones / 100 files = 0.30 density
    const d = policy.evaluate(input({ tombstoneCount: 30, filesScanned: 100 }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toMatch(/tombstone_density:0\.30/);
  });

  it("does not trigger when density < threshold", () => {
    const policy = new SmartCompactionPolicy({ tombstoneDensityThreshold: 0.3 });
    // 29 tombstones / 100 files = 0.29 density
    const d = policy.evaluate(input({ tombstoneCount: 29, filesScanned: 100 }));
    expect(d.shouldCompact).toBe(false);
  });

  it("skips density check when below minTombstonesForDensityCheck", () => {
    const policy = new SmartCompactionPolicy({
      tombstoneDensityThreshold: 0.01,
      minTombstonesForDensityCheck: 10,
    });
    // 5 tombstones / 5 files = 1.0 density, but minTombstones=10 prevents check
    const d = policy.evaluate(input({ tombstoneCount: 5, filesScanned: 5 }));
    expect(d.shouldCompact).toBe(false);
  });

  it("handles filesScanned=0 without division by zero", () => {
    const policy = new SmartCompactionPolicy({ tombstoneDensityThreshold: 0.3 });
    // denominator should be max(1, 0) = 1
    const d = policy.evaluate(input({ tombstoneCount: 10, filesScanned: 0 }));
    // 10 / 1 = 10.0 >= 0.3 → should compact
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toMatch(/tombstone_density/);
  });
});

describe("SmartCompactionPolicy — cycle limit", () => {
  it("triggers when cyclesSinceLastCompact >= maxCyclesWithoutCompact", () => {
    const policy = new SmartCompactionPolicy({ maxCyclesWithoutCompact: 5 });
    const d = policy.evaluate(input({ cyclesSinceLastCompact: 5 }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe("cycle_limit");
  });

  it("does not trigger when cyclesSinceLastCompact < maxCyclesWithoutCompact", () => {
    const policy = new SmartCompactionPolicy({ maxCyclesWithoutCompact: 5 });
    const d = policy.evaluate(input({ cyclesSinceLastCompact: 4 }));
    expect(d.shouldCompact).toBe(false);
  });
});

describe("SmartCompactionPolicy — no trigger", () => {
  it("returns no_trigger when none of the conditions are met", () => {
    const policy = new SmartCompactionPolicy({
      tombstoneDensityThreshold: 0.5,
      maxCyclesWithoutCompact: 20,
      minTombstonesForDensityCheck: 5,
    });
    const d = policy.evaluate(input({
      tombstoneCount: 3,
      filesScanned: 200,
      budgetPressure: false,
      cyclesSinceLastCompact: 10,
    }));
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toBe("no_trigger");
  });
});

describe("SmartCompactionPolicy — defaults", () => {
  it("uses reasonable defaults without explicit options", () => {
    const policy = new SmartCompactionPolicy();
    // No pressure, low tombstones, low cycle count → no compaction
    const d = policy.evaluate(input({ tombstoneCount: 1, filesScanned: 100, cyclesSinceLastCompact: 1 }));
    expect(d.shouldCompact).toBe(false);
  });

  it("default density threshold triggers at 30% with enough tombstones", () => {
    const policy = new SmartCompactionPolicy();
    // 30 tombstones / 100 files = 0.30 >= 0.30 default → compact
    const d = policy.evaluate(input({ tombstoneCount: 30, filesScanned: 100 }));
    expect(d.shouldCompact).toBe(true);
  });

  it("default maxCyclesWithoutCompact is 20", () => {
    const policy = new SmartCompactionPolicy();
    const d19 = policy.evaluate(input({ cyclesSinceLastCompact: 19 }));
    expect(d19.shouldCompact).toBe(false);
    const d20 = policy.evaluate(input({ cyclesSinceLastCompact: 20 }));
    expect(d20.shouldCompact).toBe(true);
    expect(d20.reason).toBe("cycle_limit");
  });
});
