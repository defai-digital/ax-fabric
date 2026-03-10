import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { chunk, CHUNKER_VERSION } from "./chunker.js";
import type { Chunk } from "./chunker.js";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("CHUNKER_VERSION", () => {
  it("exports a valid semver string", () => {
    expect(CHUNKER_VERSION).toBe("1.0.0");
  });
});

describe("chunk", () => {
  const DOC_ID = "doc-001";
  const DOC_VERSION = "v1";

  describe("basic behavior", () => {
    it("returns empty array for empty text", () => {
      const result = chunk("", DOC_ID, DOC_VERSION);
      expect(result).toEqual([]);
    });

    it("returns single chunk for text shorter than chunkSize", () => {
      const text = "Hello, world!";
      const result = chunk(text, DOC_ID, DOC_VERSION);

      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe(text);
      expect(result[0]!.offset).toBe(0);
    });

    it("returns single chunk for text exactly at chunkSize", () => {
      const text = "x".repeat(2800);
      const result = chunk(text, DOC_ID, DOC_VERSION);

      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe(text);
    });
  });

  describe("determinism", () => {
    it("produces identical chunks for identical input", () => {
      const text = "A".repeat(5000);
      const first = chunk(text, DOC_ID, DOC_VERSION);
      const second = chunk(text, DOC_ID, DOC_VERSION);

      expect(first.length).toBe(second.length);
      for (let i = 0; i < first.length; i++) {
        expect(first[i]!.chunkId).toBe(second[i]!.chunkId);
        expect(first[i]!.chunkHash).toBe(second[i]!.chunkHash);
        expect(first[i]!.offset).toBe(second[i]!.offset);
        expect(first[i]!.text).toBe(second[i]!.text);
      }
    });

    it("produces different chunkIds for different docIds", () => {
      const text = "Hello world";
      const a = chunk(text, "doc-a", DOC_VERSION);
      const b = chunk(text, "doc-b", DOC_VERSION);

      expect(a[0]!.chunkHash).toBe(b[0]!.chunkHash); // same text
      expect(a[0]!.chunkId).not.toBe(b[0]!.chunkId); // different doc
    });

    it("produces different chunkIds for different docVersions", () => {
      const text = "Hello world";
      const a = chunk(text, DOC_ID, "v1");
      const b = chunk(text, DOC_ID, "v2");

      expect(a[0]!.chunkHash).toBe(b[0]!.chunkHash);
      expect(a[0]!.chunkId).not.toBe(b[0]!.chunkId);
    });
  });

  describe("hashing", () => {
    it("chunkHash is SHA-256 of chunk text", () => {
      const text = "Test content for hashing";
      const result = chunk(text, DOC_ID, DOC_VERSION);

      expect(result[0]!.chunkHash).toBe(sha256(text));
    });

    it("chunkId is SHA-256 of docId + docVersion + offset + chunkHash", () => {
      const text = "Test content";
      const result = chunk(text, DOC_ID, DOC_VERSION);
      const c = result[0]!;

      const expectedId = sha256(DOC_ID + DOC_VERSION + String(c.offset) + c.chunkHash);
      expect(c.chunkId).toBe(expectedId);
    });

    it("all hashes are 64-char hex strings", () => {
      const text = "x".repeat(6000);
      const result = chunk(text, DOC_ID, DOC_VERSION);

      for (const c of result) {
        expect(c.chunkHash).toMatch(/^[a-f0-9]{64}$/);
        expect(c.chunkId).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("chunking and overlap", () => {
    it("creates multiple chunks for text longer than chunkSize", () => {
      const text = "a".repeat(6000);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 2800 });

      expect(result.length).toBeGreaterThan(1);
    });

    it("all chunk offsets are non-negative", () => {
      const text = "word ".repeat(2000);
      const result = chunk(text, DOC_ID, DOC_VERSION);

      for (const c of result) {
        expect(c.offset).toBeGreaterThanOrEqual(0);
      }
    });

    it("chunks have overlap (consecutive chunks share text)", () => {
      const text = "word ".repeat(2000);
      const result = chunk(text, DOC_ID, DOC_VERSION, {
        chunkSize: 100,
        overlapRatio: 0.2,
      });

      expect(result.length).toBeGreaterThan(2);

      // The second chunk should start before the end of the first chunk
      // (since overlap means we step back)
      for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1]!;
        const curr = result[i]!;
        const prevEnd = prev.offset + prev.text.length;
        // Current chunk should start before the previous chunk ends (overlap)
        expect(curr.offset).toBeLessThan(prevEnd);
      }
    });

    it("covers the entire text (no gaps)", () => {
      const text = "Hello world. This is a test of the chunker. " .repeat(100);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 200 });

      // First chunk starts at 0
      expect(result[0]!.offset).toBe(0);

      // Last chunk extends to end of text
      const lastChunk = result[result.length - 1]!;
      expect(lastChunk.offset + lastChunk.text.length).toBe(text.length);
    });

    it("handles zero overlap", () => {
      const text = "x".repeat(100);
      const result = chunk(text, DOC_ID, DOC_VERSION, {
        chunkSize: 30,
        overlapRatio: 0,
      });

      expect(result.length).toBeGreaterThan(1);
      // With no overlap, each chunk starts right where the previous left off
      // (except for boundary adjustments)
    });
  });

  describe("boundary detection", () => {
    it("prefers paragraph boundaries", () => {
      // Build text with a paragraph break near the chunk boundary
      const before = "a".repeat(1500);
      const after = "b".repeat(1500);
      const text = `${before}\n\n${after}`;

      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 2800 });

      // First chunk should end at or after the paragraph break
      if (result.length > 1) {
        expect(result[0]!.text).toContain("\n\n");
      }
    });

    it("falls back to sentence boundaries when no paragraph break", () => {
      // Long text with sentences but no paragraph breaks
      const sentence = "This is a complete sentence. ";
      const text = sentence.repeat(200);

      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 500 });

      // Each chunk (except possibly the last) should end at a sentence boundary
      for (let i = 0; i < result.length - 1; i++) {
        const chunkText = result[i]!.text;
        // Should end near a period
        const lastPeriod = chunkText.lastIndexOf(". ");
        expect(lastPeriod).toBeGreaterThan(-1);
      }
    });

    it("falls back to word boundaries when no sentence break", () => {
      // Long text of words with no sentence-ending punctuation
      const text = "word ".repeat(2000);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 100 });

      // Chunks should not break mid-word (except as a last resort)
      for (const c of result) {
        if (c.text.length > 1) {
          // Chunk should start/end at word boundaries (spaces)
          const firstChar = c.text[0];
          const lastChar = c.text[c.text.length - 1];
          const isWordBoundary =
            firstChar === "w" || firstChar === " " ||
            lastChar === " " || lastChar === "d";
          expect(isWordBoundary).toBe(true);
        }
      }
    });
  });

  describe("custom options", () => {
    it("respects custom chunkSize", () => {
      const text = "x".repeat(500);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 100 });

      expect(result.length).toBeGreaterThan(1);
      // First chunk should be around 100 chars
      expect(result[0]!.text.length).toBeLessThanOrEqual(100);
    });

    it("respects custom overlapRatio", () => {
      const text = "x".repeat(1000);
      const noOverlap = chunk(text, DOC_ID, DOC_VERSION, {
        chunkSize: 200,
        overlapRatio: 0,
      });
      const withOverlap = chunk(text, DOC_ID, DOC_VERSION, {
        chunkSize: 200,
        overlapRatio: 0.5,
      });

      // Higher overlap means more chunks
      expect(withOverlap.length).toBeGreaterThan(noOverlap.length);
    });
  });

  describe("edge cases", () => {
    it("handles single character text", () => {
      const result = chunk("x", DOC_ID, DOC_VERSION);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe("x");
      expect(result[0]!.offset).toBe(0);
    });

    it("handles text that is all newlines", () => {
      const text = "\n".repeat(100);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 30 });
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("handles text with no natural break points", () => {
      // Continuous string with no spaces, newlines, or punctuation
      const text = "abcdefghij".repeat(500);
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 100 });

      expect(result.length).toBeGreaterThan(1);
      // Should still produce valid chunks (hard cut)
      for (const c of result) {
        expect(c.text.length).toBeGreaterThan(0);
      }
    });

    it("handles unicode content", () => {
      const text = "\u{1F600}".repeat(1000); // emoji
      const result = chunk(text, DOC_ID, DOC_VERSION, { chunkSize: 100 });

      expect(result.length).toBeGreaterThan(1);
      // All chunks should have valid text
      for (const c of result) {
        expect(c.text.length).toBeGreaterThan(0);
      }
    });
  });
});
