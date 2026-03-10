/**
 * Tests for MarkdownChunker, StructuredTextChunker, and auto-detect strategy.
 *
 * Each chunker is tested with representative inputs covering normal use,
 * edge cases, and sub-chunking of large sections.
 */

import { describe, it, expect } from "vitest";
import { MarkdownChunker } from "./markdown.js";
import { StructuredTextChunker } from "./structured.js";
import { detectStrategy, getStrategy } from "./auto-detect.js";

const OPTS = { maxChunkSize: 200, overlap: 20 };
const SMALL_OPTS = { maxChunkSize: 50, overlap: 5 };

// ─── MarkdownChunker ──────────────────────────────────────────────────────

describe("MarkdownChunker", () => {
  const chunker = new MarkdownChunker();

  it("returns empty array for empty text", () => {
    expect(chunker.chunk("", OPTS)).toEqual([]);
  });

  it("produces one chunk for a small document with no headings", () => {
    const text = "Just a paragraph of text.";
    const chunks = chunker.chunk(text, OPTS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("Just a paragraph");
  });

  it("splits on headings — one chunk per section", () => {
    const text = "# Section One\n\nContent of one.\n\n## Section Two\n\nContent of two.";
    const chunks = chunker.chunk(text, OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes("Section One"))).toBe(true);
    expect(texts.some((t) => t.includes("Section Two"))).toBe(true);
  });

  it("each heading chunk includes the heading text", () => {
    const text = "# Title\n\nBody text here.";
    const chunks = chunker.chunk(text, OPTS);
    expect(chunks[0]!.text).toContain("# Title");
    expect(chunks[0]!.text).toContain("Body text here.");
  });

  it("sub-chunks oversized sections at paragraph boundaries", () => {
    const longBody = "Word ".repeat(200);
    const text = `# Big Section\n\n${longBody}`;
    const chunks = chunker.chunk(text, SMALL_OPTS);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("all chunk offsets are non-negative", () => {
    const text = "# A\n\nParagraph.\n\n# B\n\nAnother.";
    const chunks = chunker.chunk(text, OPTS);
    for (const chunk of chunks) {
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("chunk offsets are monotonically non-decreasing", () => {
    const text = "# A\n\nFirst.\n\n# B\n\nSecond.\n\n# C\n\nThird.";
    const chunks = chunker.chunk(text, OPTS);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.offset).toBeGreaterThanOrEqual(chunks[i - 1]!.offset);
    }
  });

  it("handles document with only headings and no body", () => {
    const text = "# H1\n## H2\n### H3";
    const chunks = chunker.chunk(text, OPTS);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("handles deeply nested heading levels", () => {
    const text = "# L1\n\nbody\n\n## L2\n\nbody\n\n### L3\n\nbody\n\n#### L4\n\nbody";
    const chunks = chunker.chunk(text, OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it("preserves text content — no characters dropped", () => {
    const text = "# Header\n\nSome body text that must survive.";
    const chunks = chunker.chunk(text, OPTS);
    const combined = chunks.map((c) => c.text).join(" ");
    expect(combined).toContain("Header");
    expect(combined).toContain("Some body text that must survive.");
  });
});

// ─── StructuredTextChunker ────────────────────────────────────────────────

describe("StructuredTextChunker", () => {
  const chunker = new StructuredTextChunker();

  it("returns empty array for empty text", () => {
    expect(chunker.chunk("", OPTS)).toEqual([]);
  });

  it("produces at least one chunk for non-empty text", () => {
    const chunks = chunker.chunk("Hello world.", OPTS);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("labels code fence blocks as 'code'", () => {
    const text = "Some prose.\n\n```\nconst x = 1;\n```\n\nMore prose.";
    const chunks = chunker.chunk(text, OPTS);
    const codeChunks = chunks.filter((c) => c.label === "code");
    expect(codeChunks.length).toBeGreaterThan(0);
    expect(codeChunks[0]!.text).toContain("const x = 1;");
  });

  it("labels markdown table rows as 'table'", () => {
    const text = "| Name | Value |\n| ---- | ----- |\n| foo  | 1     |";
    const chunks = chunker.chunk(text, OPTS);
    const tableChunks = chunks.filter((c) => c.label === "table");
    expect(tableChunks.length).toBeGreaterThan(0);
  });

  it("labels list items as 'list'", () => {
    const text = "- item one\n- item two\n- item three";
    const chunks = chunker.chunk(text, OPTS);
    const listChunks = chunks.filter((c) => c.label === "list");
    expect(listChunks.length).toBeGreaterThan(0);
  });

  it("sub-chunks oversized paragraph blocks", () => {
    const text = "word ".repeat(300);
    const chunks = chunker.chunk(text, SMALL_OPTS);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("all chunk offsets are non-negative", () => {
    const text = "Para one.\n\nPara two.\n\n```\ncode\n```";
    const chunks = chunker.chunk(text, OPTS);
    for (const c of chunks) {
      expect(c.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("offsets are monotonically non-decreasing", () => {
    const text = "First para.\n\nSecond para.\n\n```\ncode block\n```\n\nThird para.";
    const chunks = chunker.chunk(text, OPTS);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.offset).toBeGreaterThanOrEqual(chunks[i - 1]!.offset);
    }
  });

  it("handles unclosed code fence gracefully", () => {
    const text = "Normal text.\n\n```\nunclosed code block";
    expect(() => chunker.chunk(text, OPTS)).not.toThrow();
  });

  it("handles numbered list items", () => {
    const text = "1. First\n2. Second\n3. Third";
    const chunks = chunker.chunk(text, OPTS);
    const listChunks = chunks.filter((c) => c.label === "list");
    expect(listChunks.length).toBeGreaterThan(0);
  });
});

// ─── detectStrategy / getStrategy ─────────────────────────────────────────

describe("detectStrategy", () => {
  it("returns MarkdownChunker for .md extension", () => {
    const strategy = detectStrategy("document.md");
    expect(strategy.name).toBe("markdown");
  });

  it("returns MarkdownChunker for .markdown extension", () => {
    expect(detectStrategy("readme.markdown").name).toBe("markdown");
  });

  it("returns StructuredTextChunker for .pdf", () => {
    expect(detectStrategy("report.pdf").name).toBe("structured");
  });

  it("returns StructuredTextChunker for .docx", () => {
    expect(detectStrategy("doc.docx").name).toBe("structured");
  });

  it("returns StructuredTextChunker for .txt", () => {
    expect(detectStrategy("notes.txt").name).toBe("structured");
  });

  it("returns FixedSizeChunker for .json", () => {
    expect(detectStrategy("data.json").name).toBe("fixed");
  });

  it("returns FixedSizeChunker for unknown extension", () => {
    expect(detectStrategy("file.xyz").name).toBe("fixed");
  });

  it("extension matching is case-insensitive", () => {
    expect(detectStrategy("DOC.MD").name).toBe("markdown");
    expect(detectStrategy("report.PDF").name).toBe("structured");
  });

  it("override: 'markdown' always returns MarkdownChunker", () => {
    expect(detectStrategy("file.json", "markdown").name).toBe("markdown");
  });

  it("override: 'structured' always returns StructuredTextChunker", () => {
    expect(detectStrategy("file.json", "structured").name).toBe("structured");
  });

  it("override: 'fixed' always returns FixedSizeChunker", () => {
    expect(detectStrategy("file.md", "fixed").name).toBe("fixed");
  });
});

describe("getStrategy", () => {
  it("returns markdown strategy by name", () => {
    expect(getStrategy("markdown").name).toBe("markdown");
  });

  it("returns structured strategy by name", () => {
    expect(getStrategy("structured").name).toBe("structured");
  });

  it("returns fixed strategy by name", () => {
    expect(getStrategy("fixed").name).toBe("fixed");
  });
});
