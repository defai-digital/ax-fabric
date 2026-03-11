/**
 * Storage budget checker — monitors disk usage and recommends actions.
 */

import {
  BUDGET_SKIP_THRESHOLD_PCT,
  BUDGET_COMPACT_THRESHOLD_PCT,
  BUDGET_WARN_THRESHOLD_PCT,
} from "../constants.js";

export type BudgetAction = "normal" | "warn" | "compact" | "skip";

export interface BudgetResult {
  usedBytes: number;
  maxBytes: number;
  percent: number;
  action: BudgetAction;
}

/**
 * Check the storage budget and recommend an action.
 *
 * - `normal`:  < 70% — continue normally
 * - `warn`:    70-85% — log a warning, continue
 * - `compact`: 85-95% — trigger compaction before next ingest
 * - `skip`:    > 95% — skip ingestion, only compact
 */
export function checkBudget(
  usedBytes: number,
  maxStorageGb: number,
): BudgetResult {
  const maxBytes = maxStorageGb * 1024 * 1024 * 1024;
  const percent = maxBytes > 0 ? (usedBytes / maxBytes) * 100 : 0;

  let action: BudgetAction;
  if (percent > BUDGET_SKIP_THRESHOLD_PCT) {
    action = "skip";
  } else if (percent > BUDGET_COMPACT_THRESHOLD_PCT) {
    action = "compact";
  } else if (percent > BUDGET_WARN_THRESHOLD_PCT) {
    action = "warn";
  } else {
    action = "normal";
  }

  return { usedBytes, maxBytes, percent, action };
}
