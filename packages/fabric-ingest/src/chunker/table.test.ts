/**
 * Unit tests for TableChunker.
 */

import { describe, expect, it } from "vitest";
import { TableChunker } from "./table.js";
import type { ChunkOpts } from "./strategy.js";

const defaultOpts: ChunkOpts = { maxChunkSize: 200, overlap: 0 };

function makeRows(count: number, cols: string[] = ["id", "name"]): string {
  const header = `Columns: ${cols.join(", ")}`;
  const rows = Array.from(
    { length: count },
    (_, i) => cols.map((c) => `${c}: val${i}`).join(", "),
  );
  return [header, ...rows].join("\n");
}

describe("TableChunker", () => {
  const chunker = new TableChunker();

  it("has name 'table'", () => {
    expect(chunker.name).toBe("table");
  });

  it("returns empty for empty text", () => {
    expect(chunker.chunk("", defaultOpts)).toEqual([]);
  });

  it("returns empty for schema header only", () => {
    expect(chunker.chunk("Columns: id, name", defaultOpts)).toEqual([]);
  });

  it("returns empty for whitespace-only rows", () => {
    expect(chunker.chunk("Columns: id\n   \n   ", defaultOpts)).toEqual([]);
  });

  it("emits single chunk when all rows fit", () => {
    const text = "Columns: a, b\na: 1, b: 2\na: 3, b: 4";
    const result = chunker.chunk(text, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("table");
    expect(result[0]!.text).toContain("Columns: a, b");
  });

  it("prepends schema header to every chunk", () => {
    // Create enough rows to force multiple chunks
    const text = makeRows(20, ["id", "name", "description"]);
    const result = chunker.chunk(text, { maxChunkSize: 100, overlap: 0 });
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text).toContain("Columns:");
    }
  });

  it("splits rows into multiple chunks when they exceed maxChunkSize", () => {
    const text = makeRows(50, ["id", "value"]);
    const result = chunker.chunk(text, { maxChunkSize: 150, overlap: 0 });
    expect(result.length).toBeGreaterThan(1);
  });

  it("handles text without a schema header (no 'Columns:' line)", () => {
    const text = "row one\nrow two\nrow three";
    const result = chunker.chunk(text, defaultOpts);
    // No schema prefix; rows are still chunked
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.label).toBe("table");
    expect(result[0]!.text).not.toContain("Columns:");
  });

  it("emits an oversized row as its own chunk when it exceeds maxChunkSize", () => {
    const longRow = "id: " + "x".repeat(300);
    const text = `Columns: id\n${longRow}`;
    const result = chunker.chunk(text, { maxChunkSize: 100, overlap: 0 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((c) => c.text.includes(longRow))).toBe(true);
  });

  it("offset of first chunk reflects position after schema header", () => {
    const text = "Columns: id\nid: 1\nid: 2";
    const result = chunker.chunk(text, defaultOpts);
    // First chunk's offset should be after "Columns: id\n"
    expect(result[0]!.offset).toBeGreaterThan(0);
  });

  it("all chunks have non-negative offsets", () => {
    const text = makeRows(30, ["a", "b"]);
    const result = chunker.chunk(text, { maxChunkSize: 120, overlap: 0 });
    for (const chunk of result) {
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
    }
  });
});
