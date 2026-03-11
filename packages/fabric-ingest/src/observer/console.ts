/**
 * ConsoleObserver — human-readable terminal output for pipeline events.
 */

import type { PipelineEvent, PipelineObserver } from "./types.js";

export class ConsoleObserver implements PipelineObserver {
  private readonly prefix: string;

  constructor(opts?: { prefix?: string }) {
    this.prefix = opts?.prefix ?? "[ax-fabric]";
  }

  onEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "cycle_start":
        console.log(
          `${this.prefix} Cycle ${event.cycleId} started — scanning ${event.sourcePaths.length} source(s)`,
        );
        break;

      case "file_processed":
        if (event.status === "success") {
          console.log(
            `${this.prefix}   ${event.sourcePath} — ${event.chunksGenerated} chunks (${event.durationMs}ms)`,
          );
        } else if (event.status === "error") {
          console.error(
            `${this.prefix}   ${event.sourcePath} — ERROR: ${event.errorMessage}`,
          );
        }
        break;

      case "cycle_end":
        console.log(
          `${this.prefix} Cycle ${event.cycleId} done — ` +
            `${event.filesProcessed} files, ` +
            `${event.recordsGenerated} records, ` +
            `${event.tombstonesGenerated} tombstones, ` +
            `${event.duplicateChunks} duplicate chunks` +
            `${event.compacted ? ", compacted" : ""}` +
            ` (${event.durationMs}ms)`,
        );
        break;

      case "error":
        console.error(
          `${this.prefix} ERROR [${event.errorCode}]: ${event.message}`,
        );
        break;
    }
  }
}
