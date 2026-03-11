/**
 * MetricsObserver — in-memory counters for pipeline monitoring.
 */

import type { PipelineEvent, PipelineObserver } from "./types.js";

export interface PipelineCounters {
  cyclesStarted: number;
  cyclesCompleted: number;
  filesProcessed: number;
  filesFailed: number;
  filesSkipped: number;
  recordsGenerated: number;
  tombstonesGenerated: number;
  compactions: number;
  errors: number;
  totalDurationMs: number;
  // Stage timing aggregates
  totalScanMs: number;
  totalProcessMs: number;
  totalPublishMs: number;
  // Embed scheduler aggregates
  totalBatchesFired: number;
  totalVectorsEmbedded: number;
  totalEmbedErrors: number;
}

export class MetricsObserver implements PipelineObserver {
  private counters: PipelineCounters = {
    cyclesStarted: 0,
    cyclesCompleted: 0,
    filesProcessed: 0,
    filesFailed: 0,
    filesSkipped: 0,
    recordsGenerated: 0,
    tombstonesGenerated: 0,
    compactions: 0,
    errors: 0,
    totalDurationMs: 0,
    totalScanMs: 0,
    totalProcessMs: 0,
    totalPublishMs: 0,
    totalBatchesFired: 0,
    totalVectorsEmbedded: 0,
    totalEmbedErrors: 0,
  };

  onEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "cycle_start":
        this.counters.cyclesStarted++;
        break;

      case "file_processed":
        if (event.status === "success") {
          this.counters.filesProcessed++;
        } else if (event.status === "error") {
          this.counters.filesFailed++;
        } else if (event.status === "skipped") {
          this.counters.filesSkipped++;
        }
        break;

      case "cycle_end":
        this.counters.cyclesCompleted++;
        this.counters.recordsGenerated += event.recordsGenerated;
        this.counters.tombstonesGenerated += event.tombstonesGenerated;
        this.counters.totalDurationMs += event.durationMs;
        if (event.compacted) {
          this.counters.compactions++;
        }
        if (event.stageDurations) {
          this.counters.totalScanMs += event.stageDurations.scanMs;
          this.counters.totalProcessMs += event.stageDurations.processMs;
          this.counters.totalPublishMs += event.stageDurations.publishMs;
        }
        if (event.embedStats) {
          this.counters.totalBatchesFired += event.embedStats.batchesFired;
          this.counters.totalVectorsEmbedded += event.embedStats.vectorsEmbedded;
          this.counters.totalEmbedErrors += event.embedStats.errorsEncountered;
        }
        break;

      case "error":
        this.counters.errors++;
        break;
    }
  }

  getCounters(): Readonly<PipelineCounters> {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = {
      cyclesStarted: 0,
      cyclesCompleted: 0,
      filesProcessed: 0,
      filesFailed: 0,
      filesSkipped: 0,
      recordsGenerated: 0,
      tombstonesGenerated: 0,
      compactions: 0,
      errors: 0,
      totalDurationMs: 0,
      totalScanMs: 0,
      totalProcessMs: 0,
      totalPublishMs: 0,
      totalBatchesFired: 0,
      totalVectorsEmbedded: 0,
      totalEmbedErrors: 0,
    };
  }
}
