/**
 * Unit tests for ConsoleObserver, JsonlObserver, and MetricsObserver.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ConsoleObserver } from "./console.js";
import { JsonlObserver } from "./jsonl.js";
import { MetricsObserver } from "./metrics.js";
import type { CycleStartEvent, FileProcessedEvent, CycleEndEvent, ErrorEvent } from "./types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const cycleStart: CycleStartEvent = {
  type: "cycle_start",
  timestamp: NOW,
  cycleId: "cycle-001",
  sourcePaths: ["/docs", "/src"],
};

const fileSuccess: FileProcessedEvent = {
  type: "file_processed",
  timestamp: NOW,
  cycleId: "cycle-001",
  sourcePath: "/docs/guide.md",
  status: "success",
  chunksGenerated: 5,
  durationMs: 42,
};

const fileError: FileProcessedEvent = {
  type: "file_processed",
  timestamp: NOW,
  cycleId: "cycle-001",
  sourcePath: "/docs/broken.pdf",
  status: "error",
  chunksGenerated: 0,
  durationMs: 10,
  errorMessage: "PDF parse failed",
};

const fileSkipped: FileProcessedEvent = {
  type: "file_processed",
  timestamp: NOW,
  cycleId: "cycle-001",
  sourcePath: "/docs/unchanged.md",
  status: "skipped",
  chunksGenerated: 0,
  durationMs: 1,
};

const cycleEnd: CycleEndEvent = {
  type: "cycle_end",
  timestamp: NOW,
  cycleId: "cycle-001",
  filesProcessed: 3,
  filesFailed: 1,
  filesSkipped: 2,
  recordsGenerated: 10,
  tombstonesGenerated: 2,
  compacted: true,
  durationMs: 500,
  totalChunksGenerated: 15,
  averageChunkSizeChars: 800,
  duplicateChunks: 1,
  duplicateRatio: 0.067,
  chunkCountBySource: { "/docs/guide.md": 5 },
  labelDistribution: { paragraph: 10, heading: 5 },
  stageDurations: { scanMs: 50, processMs: 400, publishMs: 50 },
  embedStats: { batchesFired: 2, vectorsEmbedded: 10, errorsEncountered: 0, avgFillRatio: 0.8, vectorsPerSec: 20 },
};

const errorEvent: ErrorEvent = {
  type: "error",
  timestamp: NOW,
  cycleId: "cycle-001",
  errorCode: "EXTRACT_ERROR",
  message: "Failed to read file",
  sourcePath: "/docs/bad.txt",
};

// ─── ConsoleObserver ──────────────────────────────────────────────────────────

describe("ConsoleObserver", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs cycle_start with cycleId and source count", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(cycleStart);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("cycle-001");
    expect(msg).toContain("2 source");
  });

  it("uses custom prefix when provided", () => {
    const observer = new ConsoleObserver({ prefix: "[test-prefix]" });
    observer.onEvent(cycleStart);
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("[test-prefix]");
  });

  it("uses default prefix '[ax-fabric]' when no prefix given", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(cycleStart);
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("[ax-fabric]");
  });

  it("logs file_processed success with path, chunks, duration", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(fileSuccess);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("/docs/guide.md");
    expect(msg).toContain("5 chunks");
    expect(msg).toContain("42ms");
  });

  it("logs file_processed error to console.error with path and message", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(fileError);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
    const msg = errorSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("/docs/broken.pdf");
    expect(msg).toContain("PDF parse failed");
  });

  it("does not log anything for file_processed skipped status", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(fileSkipped);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs cycle_end summary with files, records, tombstones, duration", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(cycleEnd);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("cycle-001");
    expect(msg).toContain("3 files");
    expect(msg).toContain("10 records");
    expect(msg).toContain("2 tombstones");
    expect(msg).toContain("500ms");
  });

  it("includes ', compacted' in cycle_end when compacted=true", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(cycleEnd);
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("compacted");
  });

  it("omits ', compacted' in cycle_end when compacted=false", () => {
    const observer = new ConsoleObserver();
    observer.onEvent({ ...cycleEnd, compacted: false });
    const msg = logSpy.mock.calls[0]![0] as string;
    expect(msg).not.toContain("compacted");
  });

  it("logs error events to console.error with errorCode and message", () => {
    const observer = new ConsoleObserver();
    observer.onEvent(errorEvent);
    expect(errorSpy).toHaveBeenCalledOnce();
    const msg = errorSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("EXTRACT_ERROR");
    expect(msg).toContain("Failed to read file");
  });
});

// ─── JsonlObserver ────────────────────────────────────────────────────────────

describe("JsonlObserver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jsonl-observer-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes each event as a JSON line to the log file", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    observer.onEvent(cycleStart);
    observer.onEvent(fileSuccess);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "cycle_start", cycleId: "cycle-001" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "file_processed", status: "success" });
  });

  it("each line is terminated by a newline", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    observer.onEvent(cycleStart);
    const raw = readFileSync(logPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("appends events across multiple onEvent calls", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    for (const evt of [cycleStart, fileSuccess, fileError, cycleEnd]) {
      observer.onEvent(evt);
    }
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(4);
  });

  it("creates parent directories if they don't exist", () => {
    const logPath = join(tmpDir, "nested", "deep", "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    observer.onEvent(cycleStart);
    const raw = readFileSync(logPath, "utf-8");
    expect(raw).toContain("cycle_start");
  });

  it("getLogPath() returns the configured path", () => {
    const logPath = join(tmpDir, "out.jsonl");
    const observer = new JsonlObserver(logPath);
    expect(observer.getLogPath()).toBe(logPath);
  });

  it("serialises error events with all fields", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    observer.onEvent(errorEvent);
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim()) as ErrorEvent;
    expect(parsed.type).toBe("error");
    expect(parsed.errorCode).toBe("EXTRACT_ERROR");
    expect(parsed.sourcePath).toBe("/docs/bad.txt");
  });
});

// ─── MetricsObserver ──────────────────────────────────────────────────────────

describe("MetricsObserver", () => {
  it("starts with all counters at zero", () => {
    const observer = new MetricsObserver();
    const c = observer.getCounters();
    expect(c.cyclesStarted).toBe(0);
    expect(c.cyclesCompleted).toBe(0);
    expect(c.filesProcessed).toBe(0);
    expect(c.filesFailed).toBe(0);
    expect(c.filesSkipped).toBe(0);
    expect(c.errors).toBe(0);
  });

  it("increments cyclesStarted on cycle_start", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleStart);
    observer.onEvent(cycleStart);
    expect(observer.getCounters().cyclesStarted).toBe(2);
  });

  it("increments filesProcessed on successful file_processed", () => {
    const observer = new MetricsObserver();
    observer.onEvent(fileSuccess);
    expect(observer.getCounters().filesProcessed).toBe(1);
    expect(observer.getCounters().filesFailed).toBe(0);
  });

  it("increments filesFailed on error file_processed", () => {
    const observer = new MetricsObserver();
    observer.onEvent(fileError);
    expect(observer.getCounters().filesFailed).toBe(1);
    expect(observer.getCounters().filesProcessed).toBe(0);
  });

  it("increments filesSkipped on skipped file_processed", () => {
    const observer = new MetricsObserver();
    observer.onEvent(fileSkipped);
    expect(observer.getCounters().filesSkipped).toBe(1);
  });

  it("accumulates cyclesCompleted and recordsGenerated from cycle_end", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleEnd);
    observer.onEvent(cycleEnd);
    const c = observer.getCounters();
    expect(c.cyclesCompleted).toBe(2);
    expect(c.recordsGenerated).toBe(20);
    expect(c.tombstonesGenerated).toBe(4);
    expect(c.totalDurationMs).toBe(1000);
  });

  it("increments compactions when cycle_end has compacted=true", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleEnd); // compacted=true
    observer.onEvent({ ...cycleEnd, compacted: false });
    expect(observer.getCounters().compactions).toBe(1);
  });

  it("accumulates stageDurations from cycle_end", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleEnd);
    observer.onEvent(cycleEnd);
    const c = observer.getCounters();
    expect(c.totalScanMs).toBe(100);
    expect(c.totalProcessMs).toBe(800);
    expect(c.totalPublishMs).toBe(100);
  });

  it("skips stageDurations accumulation when stageDurations is absent", () => {
    const observer = new MetricsObserver();
    const endNoStages: CycleEndEvent = { ...cycleEnd, stageDurations: undefined };
    observer.onEvent(endNoStages);
    const c = observer.getCounters();
    expect(c.totalScanMs).toBe(0);
    expect(c.totalProcessMs).toBe(0);
    expect(c.totalPublishMs).toBe(0);
  });

  it("accumulates embedStats counters from cycle_end", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleEnd);
    observer.onEvent(cycleEnd);
    const c = observer.getCounters();
    expect(c.totalBatchesFired).toBe(4);
    expect(c.totalVectorsEmbedded).toBe(20);
    expect(c.totalEmbedErrors).toBe(0);
  });

  it("accumulates duplicate chunk and chunk counters", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleEnd); // duplicateChunks=1, totalChunksGenerated=15
    observer.onEvent(cycleEnd);
    const c = observer.getCounters();
    expect(c.totalDuplicateChunks).toBe(2);
    expect(c.totalChunksGenerated).toBe(30);
  });

  it("accumulates totalChunkChars from averageChunkSizeChars * totalChunksGenerated", () => {
    const observer = new MetricsObserver();
    // averageChunkSizeChars=800, totalChunksGenerated=15 → 12000 per cycle
    observer.onEvent(cycleEnd);
    expect(observer.getCounters().totalChunkChars).toBe(12000);
  });

  it("increments errors on error event", () => {
    const observer = new MetricsObserver();
    observer.onEvent(errorEvent);
    observer.onEvent(errorEvent);
    expect(observer.getCounters().errors).toBe(2);
  });

  it("reset() clears all counters back to zero", () => {
    const observer = new MetricsObserver();
    observer.onEvent(cycleStart);
    observer.onEvent(fileSuccess);
    observer.onEvent(cycleEnd);
    observer.onEvent(errorEvent);

    observer.reset();

    const c = observer.getCounters();
    for (const value of Object.values(c)) {
      expect(value).toBe(0);
    }
  });

  it("getCounters() returns a snapshot (not a live reference)", () => {
    const observer = new MetricsObserver();
    const snapshot1 = observer.getCounters();
    observer.onEvent(cycleStart);
    expect(snapshot1.cyclesStarted).toBe(0); // unchanged
    expect(observer.getCounters().cyclesStarted).toBe(1);
  });
});
