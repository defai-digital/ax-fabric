/**
 * Pipeline observer types — typed event stream for logging, monitoring, debugging.
 */

export interface CycleStartEvent {
  type: "cycle_start";
  timestamp: string;
  cycleId: string;
  sourcePaths: string[];
}

export interface FileProcessedEvent {
  type: "file_processed";
  timestamp: string;
  cycleId: string;
  sourcePath: string;
  status: "success" | "error" | "skipped";
  chunksGenerated: number;
  durationMs: number;
  errorMessage?: string;
}

export interface EmbedStats {
  batchesFired: number;
  vectorsEmbedded: number;
  errorsEncountered: number;
  avgFillRatio: number;
  vectorsPerSec: number;
}

export interface StageDurations {
  scanMs: number;
  processDurationMs: number;
  publishMs: number;
}

export interface CycleEndEvent {
  type: "cycle_end";
  timestamp: string;
  cycleId: string;
  filesProcessed: number;
  filesFailed: number;
  filesSkipped: number;
  recordsGenerated: number;
  tombstonesGenerated: number;
  compacted: boolean;
  durationMs: number;
  stageDurations?: StageDurations;
  embedStats?: EmbedStats;
}

export interface ErrorEvent {
  type: "error";
  timestamp: string;
  cycleId?: string;
  errorCode: string;
  message: string;
  sourcePath?: string;
}

export type PipelineEvent =
  | CycleStartEvent
  | FileProcessedEvent
  | CycleEndEvent
  | ErrorEvent;

/**
 * Observer interface — implement to receive typed pipeline events.
 */
export interface PipelineObserver {
  onEvent(event: PipelineEvent): void;
}
