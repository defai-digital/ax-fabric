/**
 * JsonlObserver — appends pipeline events as JSONL to a log file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { PipelineEvent, PipelineObserver } from "./types.js";

export class JsonlObserver implements PipelineObserver {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
  }

  onEvent(event: PipelineEvent): void {
    const line = JSON.stringify(event) + "\n";
    try {
      appendFileSync(this.logPath, line, "utf8");
    } catch {
      // Best effort — don't crash the pipeline on log write failure.
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}
