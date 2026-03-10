/**
 * Tests for pluggable chunking strategies (Phase 2c).
 */

import { describe, expect, it } from "vitest";

import { FixedSizeChunker } from "./fixed.js";
import { StructuredTextChunker } from "./structured.js";
import { MarkdownChunker } from "./markdown.js";
import { detectStrategy, getStrategy } from "./auto-detect.js";
import type { ChunkOpts } from "./strategy.js";

const defaultOpts: ChunkOpts = { maxChunkSize: 100, overlap: 15 };

// ─── FixedSizeChunker ────────────────────────────────────────────────────────

describe("FixedSizeChunker", () => {
  const chunker = new FixedSizeChunker();

  it("returns empty for empty text", () => {
    expect(chunker.chunk("", defaultOpts)).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    const result = chunker.chunk("Hello world.", defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Hello world.");
    expect(result[0]!.label).toBe("text");
    expect(result[0]!.offset).toBe(0);
  });

  it("splits long text into multiple chunks", () => {
    const text = "A".repeat(250);
    const result = chunker.chunk(text, defaultOpts);
    expect(result.length).toBeGreaterThan(1);
    // All offsets should be non-negative.
    for (const c of result) {
      expect(c.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("has name 'fixed'", () => {
    expect(chunker.name).toBe("fixed");
  });
});

// ─── StructuredTextChunker ───────────────────────────────────────────────────

describe("StructuredTextChunker", () => {
  const chunker = new StructuredTextChunker();

  it("returns empty for empty text", () => {
    expect(chunker.chunk("", defaultOpts)).toEqual([]);
  });

  it("preserves code blocks as single chunks", () => {
    const text = [
      "Some intro text.",
      "",
      "```python",
      "def hello():",
      '    print("world")',
      "```",
      "",
      "After code.",
    ].join("\n");

    const result = chunker.chunk(text, { maxChunkSize: 500, overlap: 0 });
    const labels = result.map((c) => c.label);
    expect(labels).toContain("code");
  });

  it("detects table rows", () => {
    const text = [
      "Header text.",
      "",
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
      "| Bob | 25 |",
      "",
      "Footer text.",
    ].join("\n");

    const result = chunker.chunk(text, { maxChunkSize: 500, overlap: 0 });
    const labels = result.map((c) => c.label);
    expect(labels).toContain("table");
    expect(labels).toContain("paragraph");
  });

  it("detects list items", () => {
    const text = [
      "Introduction.",
      "",
      "- Item one",
      "- Item two",
      "- Item three",
    ].join("\n");

    const result = chunker.chunk(text, { maxChunkSize: 500, overlap: 0 });
    const labels = result.map((c) => c.label);
    expect(labels).toContain("list");
  });

  it("sub-chunks large blocks", () => {
    const text = "A".repeat(300);
    const result = chunker.chunk(text, defaultOpts);
    expect(result.length).toBeGreaterThan(1);
  });

  it("has name 'structured'", () => {
    expect(chunker.name).toBe("structured");
  });
});

// ─── MarkdownChunker ─────────────────────────────────────────────────────────

describe("MarkdownChunker", () => {
  const chunker = new MarkdownChunker();

  it("returns empty for empty text", () => {
    expect(chunker.chunk("", defaultOpts)).toEqual([]);
  });

  it("splits on headings", () => {
    const text = [
      "# Introduction",
      "",
      "Some intro text.",
      "",
      "## Methods",
      "",
      "Method details.",
      "",
      "## Results",
      "",
      "Result findings.",
    ].join("\n");

    const result = chunker.chunk(text, { maxChunkSize: 500, overlap: 0 });
    expect(result.length).toBe(3);
    expect(result[0]!.text).toContain("# Introduction");
    expect(result[0]!.label).toBe("heading");
    expect(result[1]!.text).toContain("## Methods");
    expect(result[2]!.text).toContain("## Results");
  });

  it("handles text before first heading", () => {
    const text = [
      "Some preamble text.",
      "",
      "# First Section",
      "",
      "Content.",
    ].join("\n");

    const result = chunker.chunk(text, { maxChunkSize: 500, overlap: 0 });
    expect(result.length).toBe(2);
    expect(result[0]!.text).toContain("preamble");
    expect(result[0]!.label).toBe("paragraph");
  });

  it("sub-chunks large sections", () => {
    const text = [
      "# Big Section",
      "",
      "A".repeat(300),
    ].join("\n");

    const result = chunker.chunk(text, defaultOpts);
    expect(result.length).toBeGreaterThan(1);
  });

  it("has name 'markdown'", () => {
    expect(chunker.name).toBe("markdown");
  });
});

// ─── Auto-detect ─────────────────────────────────────────────────────────────

describe("detectStrategy", () => {
  it("returns MarkdownChunker for .md files", () => {
    const s = detectStrategy("README.md");
    expect(s.name).toBe("markdown");
  });

  it("returns StructuredTextChunker for .pdf files", () => {
    const s = detectStrategy("document.pdf");
    expect(s.name).toBe("structured");
  });

  it("returns StructuredTextChunker for .txt files", () => {
    const s = detectStrategy("notes.txt");
    expect(s.name).toBe("structured");
  });

  it("returns FixedSizeChunker for unknown extensions", () => {
    const s = detectStrategy("data.csv");
    expect(s.name).toBe("fixed");
  });

  it("respects override parameter", () => {
    const s = detectStrategy("README.md", "fixed");
    expect(s.name).toBe("fixed");
  });
});

describe("getStrategy", () => {
  it("returns the named strategy", () => {
    expect(getStrategy("fixed").name).toBe("fixed");
    expect(getStrategy("structured").name).toBe("structured");
    expect(getStrategy("markdown").name).toBe("markdown");
  });
});
