/**
 * SmartCompactionPolicy — evaluates whether a compaction cycle should run.
 *
 * Three triggers (evaluated in priority order):
 *  1. Budget pressure: caller signals the collection is near its storage limit.
 *  2. Tombstone density: tombstones / max(1, filesScanned) >= densityThreshold.
 *  3. Cycle limit: cyclesSinceLastCompact >= maxCyclesWithoutCompact.
 *
 * This replaces the single `compact_threshold` integer with a richer policy
 * that avoids compacting on every cycle for tiny collections and ensures
 * compaction is never deferred indefinitely on low-churn workloads.
 */

import {
  DEFAULT_TOMBSTONE_DENSITY_THRESHOLD,
  DEFAULT_MAX_CYCLES_WITHOUT_COMPACT,
  DEFAULT_MIN_TOMBSTONES_FOR_DENSITY_CHECK,
} from "../constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompactionPolicyOptions {
  /**
   * Tombstone-to-file density threshold.
   * When `tombstoneCount / max(1, filesScanned) >= threshold`, compact.
   * Default: 0.3 (30% tombstone density).
   */
  tombstoneDensityThreshold?: number;

  /**
   * Maximum number of cycles that may pass without compaction.
   * Forces a compaction cycle even on low-churn workloads.
   * Default: 20.
   */
  maxCyclesWithoutCompact?: number;

  /**
   * Minimum absolute tombstone count before the density check activates.
   * Prevents compaction churn on brand-new or tiny collections where a
   * single delete would exceed the density threshold.
   * Default: 5.
   */
  minTombstonesForDensityCheck?: number;
}

export interface CompactionInput {
  /** Number of tombstoned chunks in the collection. */
  tombstoneCount: number;
  /** Number of source files scanned in the most recent pipeline run. */
  filesScanned: number;
  /** True when the storage budget check returned "compact" or "skip". */
  budgetPressure: boolean;
  /** Cycles elapsed since the last successful compaction. */
  cyclesSinceLastCompact: number;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  /** Human-readable trigger label, e.g. "tombstone_density:0.42". */
  reason: string;
}

// ─── SmartCompactionPolicy ───────────────────────────────────────────────────

export class SmartCompactionPolicy {
  private readonly densityThreshold: number;
  private readonly maxCyclesWithoutCompact: number;
  private readonly minTombstonesForDensityCheck: number;

  constructor(opts: CompactionPolicyOptions = {}) {
    this.densityThreshold = opts.tombstoneDensityThreshold ?? DEFAULT_TOMBSTONE_DENSITY_THRESHOLD;
    this.maxCyclesWithoutCompact = opts.maxCyclesWithoutCompact ?? DEFAULT_MAX_CYCLES_WITHOUT_COMPACT;
    this.minTombstonesForDensityCheck = opts.minTombstonesForDensityCheck ?? DEFAULT_MIN_TOMBSTONES_FOR_DENSITY_CHECK;
  }

  /**
   * Evaluate compaction triggers and return a decision.
   * Triggers are checked in priority order: budget > density > cycle limit.
   */
  evaluate(input: CompactionInput): CompactionDecision {
    // 1. Budget pressure — always compact to free space.
    if (input.budgetPressure) {
      return { shouldCompact: true, reason: "budget_pressure" };
    }

    // 2. Tombstone density — compact when the collection has accumulated
    //    enough dead chunks relative to its live file count.
    if (input.tombstoneCount >= this.minTombstonesForDensityCheck) {
      const density = input.tombstoneCount / Math.max(1, input.filesScanned);
      if (density >= this.densityThreshold) {
        return {
          shouldCompact: true,
          reason: `tombstone_density:${density.toFixed(2)}`,
        };
      }
    }

    // 3. Cycle limit — prevent indefinite deferral on low-churn workloads.
    if (input.cyclesSinceLastCompact >= this.maxCyclesWithoutCompact) {
      return { shouldCompact: true, reason: "cycle_limit" };
    }

    return { shouldCompact: false, reason: "no_trigger" };
  }
}
