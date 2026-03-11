/**
 * Tests for pipeline observer modules.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { PipelineEvent } from "./types.js";
import { ConsoleObserver } from "./console.js";
import { JsonlObserver } from "./jsonl.js";
import { MetricsObserver } from "./metrics.js";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeCycleStart(): PipelineEvent {
  return {
    type: "cycle_start",
    timestamp: "2026-01-01T00:00:00Z",
    cycleId: "cycle-1",
    sourcePaths: ["/docs", "/notes"],
  };
}

function makeFileProcessed(
  status: "success" | "error" | "skipped" = "success",
): PipelineEvent {
  return {
    type: "file_processed",
    timestamp: "2026-01-01T00:00:01Z",
    cycleId: "cycle-1",
    sourcePath: "/docs/readme.md",
    status,
    chunksGenerated: status === "success" ? 5 : 0,
    durationMs: 150,
    errorMessage: status === "error" ? "Parse error" : undefined,
  };
}

function makeCycleEnd(): PipelineEvent {
  return {
    type: "cycle_end",
    timestamp: "2026-01-01T00:00:10Z",
    cycleId: "cycle-1",
    filesProcessed: 10,
    filesFailed: 1,
    filesSkipped: 2,
    recordsGenerated: 50,
    tombstonesGenerated: 3,
    compacted: true,
    durationMs: 10000,
    totalChunksGenerated: 50,
    averageChunkSizeChars: 128,
    duplicateChunks: 4,
    duplicateRatio: 0.08,
    chunkCountBySource: {
      "/docs/readme.md": 30,
      "/docs/guide.txt": 20,
    },
    labelDistribution: {
      paragraph: 40,
      heading: 10,
    },
  };
}

function makeError(): PipelineEvent {
  return {
    type: "error",
    timestamp: "2026-01-01T00:00:05Z",
    cycleId: "cycle-1",
    errorCode: "EMBED_FAIL",
    message: "Embedding service timeout",
    sourcePath: "/docs/big.pdf",
  };
}

// ─── ConsoleObserver ────────────────────────────────────────────────────────

describe("ConsoleObserver", () => {
  it("logs cycle_start to console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const observer = new ConsoleObserver();

    observer.onEvent(makeCycleStart());

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("cycle-1");
    expect(spy.mock.calls[0]?.[0]).toContain("2 source(s)");
    spy.mockRestore();
  });

  it("logs file_processed success", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const observer = new ConsoleObserver();

    observer.onEvent(makeFileProcessed("success"));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("5 chunks");
    spy.mockRestore();
  });

  it("logs file_processed error to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = new ConsoleObserver();

    observer.onEvent(makeFileProcessed("error"));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("ERROR");
    expect(spy.mock.calls[0]?.[0]).toContain("Parse error");
    spy.mockRestore();
  });

  it("logs cycle_end summary", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const observer = new ConsoleObserver();

    observer.onEvent(makeCycleEnd());

    expect(spy).toHaveBeenCalledOnce();
    const msg = spy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("10 files");
    expect(msg).toContain("50 records");
    expect(msg).toContain("4 duplicate chunks");
    expect(msg).toContain("compacted");
    spy.mockRestore();
  });

  it("logs error events", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = new ConsoleObserver();

    observer.onEvent(makeError());

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("EMBED_FAIL");
    spy.mockRestore();
  });

  it("respects custom prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const observer = new ConsoleObserver({ prefix: "[test]" });

    observer.onEvent(makeCycleStart());

    expect(spy.mock.calls[0]?.[0]).toContain("[test]");
    spy.mockRestore();
  });
});

// ─── JsonlObserver ──────────────────────────────────────────────────────────

describe("JsonlObserver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jsonl-observer-"));
  });

  it("appends events as JSONL lines", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);

    observer.onEvent(makeCycleStart());
    observer.onEvent(makeFileProcessed());
    observer.onEvent(makeCycleEnd());

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("cycle_start");
    expect(parsed.cycleId).toBe("cycle-1");
  });

  it("creates parent directories", () => {
    const logPath = join(tmpDir, "nested", "deep", "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);

    observer.onEvent(makeCycleStart());

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("cycle_start");
  });

  it("reports its log path", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);
    expect(observer.getLogPath()).toBe(logPath);
  });

  it("handles all event types", () => {
    const logPath = join(tmpDir, "pipeline.jsonl");
    const observer = new JsonlObserver(logPath);

    observer.onEvent(makeCycleStart());
    observer.onEvent(makeFileProcessed("success"));
    observer.onEvent(makeFileProcessed("error"));
    observer.onEvent(makeError());
    observer.onEvent(makeCycleEnd());

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
  });
});

// ─── MetricsObserver ────────────────────────────────────────────────────────

describe("MetricsObserver", () => {
  it("counts cycles", () => {
    const observer = new MetricsObserver();

    observer.onEvent(makeCycleStart());
    observer.onEvent(makeCycleEnd());

    const c = observer.getCounters();
    expect(c.cyclesStarted).toBe(1);
    expect(c.cyclesCompleted).toBe(1);
  });

  it("counts files by status", () => {
    const observer = new MetricsObserver();

    observer.onEvent(makeFileProcessed("success"));
    observer.onEvent(makeFileProcessed("success"));
    observer.onEvent(makeFileProcessed("error"));
    observer.onEvent(makeFileProcessed("skipped"));

    const c = observer.getCounters();
    expect(c.filesProcessed).toBe(2);
    expect(c.filesFailed).toBe(1);
    expect(c.filesSkipped).toBe(1);
  });

  it("accumulates records and tombstones from cycle_end", () => {
    const observer = new MetricsObserver();

    observer.onEvent(makeCycleEnd());
    observer.onEvent(makeCycleEnd());

    const c = observer.getCounters();
    expect(c.recordsGenerated).toBe(100);
    expect(c.tombstonesGenerated).toBe(6);
    expect(c.compactions).toBe(2);
    expect(c.totalDurationMs).toBe(20000);
    expect(c.totalDuplicateChunks).toBe(8);
    expect(c.totalChunksGenerated).toBe(100);
  });

  it("counts errors", () => {
    const observer = new MetricsObserver();

    observer.onEvent(makeError());
    observer.onEvent(makeError());

    expect(observer.getCounters().errors).toBe(2);
  });

  it("resets counters", () => {
    const observer = new MetricsObserver();

    observer.onEvent(makeCycleStart());
    observer.onEvent(makeFileProcessed());
    observer.onEvent(makeError());
    observer.onEvent(makeCycleEnd());

    observer.reset();
    const c = observer.getCounters();
    expect(c.cyclesStarted).toBe(0);
    expect(c.filesProcessed).toBe(0);
    expect(c.errors).toBe(0);
    expect(c.cyclesCompleted).toBe(0);
  });

  it("returns a copy of counters (not reference)", () => {
    const observer = new MetricsObserver();
    observer.onEvent(makeCycleStart());

    const c1 = observer.getCounters();
    observer.onEvent(makeCycleStart());
    const c2 = observer.getCounters();

    expect(c1.cyclesStarted).toBe(1);
    expect(c2.cyclesStarted).toBe(2);
  });
});
