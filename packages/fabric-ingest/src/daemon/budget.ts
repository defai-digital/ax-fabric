/**
 * Storage budget checker — monitors disk usage and recommends actions.
 */

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
  if (percent > 95) {
    action = "skip";
  } else if (percent > 85) {
    action = "compact";
  } else if (percent > 70) {
    action = "warn";
  } else {
    action = "normal";
  }

  return { usedBytes, maxBytes, percent, action };
}
