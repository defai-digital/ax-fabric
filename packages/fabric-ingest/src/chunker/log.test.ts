/**
 * Unit tests for LogChunker.
 */

import { describe, expect, it } from "vitest";
import { LogChunker } from "./log.js";
import type { ChunkOpts } from "./strategy.js";

const defaultOpts: ChunkOpts = { maxChunkSize: 500, overlap: 0 };

function isoLine(suffix: string): string {
  return `2024-01-15T10:00:00 ${suffix}`;
}

function syslogLine(suffix: string): string {
  return `Jan 15 10:00:00 ${suffix}`;
}

describe("LogChunker", () => {
  const chunker = new LogChunker();

  it("has name 'log'", () => {
    expect(chunker.name).toBe("log");
  });

  it("returns empty for empty string", () => {
    expect(chunker.chunk("", defaultOpts)).toEqual([]);
  });

  it("returns empty for whitespace-only text", () => {
    expect(chunker.chunk("   ", defaultOpts)).toEqual([]);
  });

  // ─── Timestamp-based chunking ───────────────────────────────────────────────

  it("keeps single ISO 8601 log entry as one chunk", () => {
    const text = [
      "2024-01-15T10:00:00 INFO started",
      "  at stackframe1",
      "  at stackframe2",
    ].join("\n");
    const result = chunker.chunk(text, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain("INFO started");
    expect(result[0]!.text).toContain("stackframe1");
  });

  it("groups lines belonging to the same log entry (stack trace)", () => {
    const text = [
      "2024-01-15T10:00:00 ERROR panic",
      "  at line 1",
      "  at line 2",
      "2024-01-15T10:00:01 INFO recovered",
    ].join("\n");
    const result = chunker.chunk(text, defaultOpts);
    expect(result).toHaveLength(1); // both entries fit in one chunk
    expect(result[0]!.text).toContain("panic");
    expect(result[0]!.text).toContain("recovered");
  });

  it("splits multiple ISO 8601 entries into separate chunks when they overflow", () => {
    const entries: string[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = `2024-01-15T10:00:${String(i).padStart(2, "0")}`;
      entries.push(`${ts} INFO event-${i} ${"x".repeat(30)}`);
    }
    const text = entries.join("\n");
    const result = chunker.chunk(text, { maxChunkSize: 200, overlap: 0 });
    expect(result.length).toBeGreaterThan(1);
  });

  it("detects bracketed ISO timestamps [2024-01-15T...]", () => {
    const text = [
      "[2024-01-15T10:00:00] WARN something",
      "[2024-01-15T10:00:01] INFO all good",
    ].join("\n");
    const result = chunker.chunk(text, defaultOpts);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.text).toContain("WARN");
  });

  it("detects syslog timestamps (Jan 15 10:00:00)", () => {
    const text = [
      syslogLine("INFO started"),
      syslogLine("WARN degraded"),
    ].join("\n");
    const result = chunker.chunk(text, defaultOpts);
    expect(result.length).toBeGreaterThan(0);
  });

  it("emits oversized single entries as their own chunk", () => {
    const longEntry = isoLine("ERROR " + "x".repeat(600));
    const result = chunker.chunk(longEntry, { maxChunkSize: 100, overlap: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain("ERROR");
  });

  it("offsets are non-negative for timestamp-based chunks", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(isoLine(`INFO event-${i}`));
    }
    const result = chunker.chunk(lines.join("\n"), { maxChunkSize: 100, overlap: 0 });
    for (const chunk of result) {
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── Fallback line-based chunking ───────────────────────────────────────────

  it("falls back to line-based chunking when no timestamps detected", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `plain log line ${i}`);
    const text = lines.join("\n");
    const result = chunker.chunk(text, { maxChunkSize: 150, overlap: 0 });
    expect(result.length).toBeGreaterThan(1);
    // All text chunks use label "text"
    for (const chunk of result) {
      expect(chunk.label).toBe("text");
    }
  });

  it("line-based fallback: single line that fits is one chunk", () => {
    const result = chunker.chunk("plain single line", defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("plain single line");
  });

  it("line-based fallback: offsets are non-negative", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} ${"a".repeat(20)}`);
    const result = chunker.chunk(lines.join("\n"), { maxChunkSize: 100, overlap: 0 });
    for (const chunk of result) {
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("line-based fallback: chunks are non-empty", () => {
    const text = Array.from({ length: 10 }, (_, i) => `event ${i}`).join("\n");
    const result = chunker.chunk(text, { maxChunkSize: 50, overlap: 0 });
    for (const chunk of result) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });
});
