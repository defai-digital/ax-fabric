/**
 * Unit tests for the pure pipeline stage functions.
 *
 * Each stage is tested in isolation with controlled inputs.
 * No real embedder or file I/O is used (mocks only).
 */

import { describe, expect, it, vi } from "vitest";
import { AxFabricError } from "@ax-fabric/contracts";
import type { EmbedderProvider } from "@ax-fabric/contracts";

import { stageExtract, stageNormalize, stageChunk, stageEmbed, stageBuild } from "./stages.js";
import type { ExtractOutput, ChunkOutput } from "./stages.js";
import type { ScanResult } from "../scanner/index.js";
import type { ExtractorRegistry } from "../extractor/index.js";
import { RecordBuilder } from "../builder/index.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    sourcePath: "/docs/sample.txt",
    fingerprint: "fp-abc123",
    sizeBytes: 1024,
    mtimeMs: Date.now(),
    contentType: "txt",
    ...overrides,
  };
}

function makeExtractOutput(overrides: Partial<ExtractOutput> = {}): ExtractOutput {
  return {
    text: "This is the extracted text from the file.",
    pageRange: null,
    tableRef: null,
    ...overrides,
  };
}

function makeExtractorRegistry(
  extractorFn: () => Promise<{ text: string; pageRange?: string; tableRef?: string }> | null,
): ExtractorRegistry {
  return {
    getExtractor: vi.fn().mockReturnValue(
      extractorFn === null ? null : { extract: vi.fn().mockResolvedValue(extractorFn()) },
    ),
    getSupportedExtensions: vi.fn().mockReturnValue([".txt"]),
  } as unknown as ExtractorRegistry;
}

function makeMockEmbedder(vectors?: number[][]): EmbedderProvider {
  return {
    modelId: "test-model",
    dimension: 4,
    embed: vi.fn().mockResolvedValue(vectors ?? [[0.1, 0.2, 0.3, 0.4]]),
  };
}

function makeBuilder(): RecordBuilder {
  return new RecordBuilder({
    embeddingModelId: "test-model",
    pipelineSignature: "sig-v1",
  });
}

// ─── stageExtract ─────────────────────────────────────────────────────────────

describe("stageExtract", () => {
  it("returns ExtractOutput for a file with non-empty text", async () => {
    const registry = makeExtractorRegistry(() =>
      Promise.resolve({ text: "Hello world" }),
    );
    const file = makeScanResult();
    const result = await stageExtract(file, registry);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello world");
  });

  it("returns null when extracted text is empty/whitespace", async () => {
    const registry = makeExtractorRegistry(() =>
      Promise.resolve({ text: "   \n  " }),
    );
    const result = await stageExtract(makeScanResult(), registry);
    expect(result).toBeNull();
  });

  it("propagates pageRange and tableRef from extracted result", async () => {
    const registry = makeExtractorRegistry(() =>
      Promise.resolve({ text: "content", pageRange: "1-3", tableRef: "table_1" }),
    );
    const result = await stageExtract(makeScanResult(), registry);
    expect(result!.pageRange).toBe("1-3");
    expect(result!.tableRef).toBe("table_1");
  });

  it("uses null for absent pageRange and tableRef", async () => {
    const registry = makeExtractorRegistry(() =>
      Promise.resolve({ text: "content" }),
    );
    const result = await stageExtract(makeScanResult(), registry);
    expect(result!.pageRange).toBeNull();
    expect(result!.tableRef).toBeNull();
  });

  it("throws EXTRACT_ERROR when no extractor is registered for the file", async () => {
    const registry = makeExtractorRegistry(null as unknown as () => Promise<{ text: string }>);
    let caught: unknown;
    try {
      await stageExtract(makeScanResult(), registry);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AxFabricError);
    expect((caught as AxFabricError).code).toBe("EXTRACT_ERROR");
  });
});

// ─── stageNormalize ───────────────────────────────────────────────────────────

describe("stageNormalize", () => {
  it("returns normalized text", () => {
    const extracted = makeExtractOutput({ text: "Hello   World\r\n" });
    const result = stageNormalize(extracted);
    expect(result.normalizedText).toBeDefined();
    expect(result.normalizedText.length).toBeGreaterThan(0);
  });

  it("normalizes Windows line endings to Unix", () => {
    const extracted = makeExtractOutput({ text: "line1\r\nline2\r\n" });
    const result = stageNormalize(extracted);
    expect(result.normalizedText).not.toContain("\r\n");
  });

  it("collapses excessive whitespace", () => {
    const extracted = makeExtractOutput({ text: "word1   word2" });
    const result = stageNormalize(extracted);
    // Normalizer reduces multiple spaces
    expect(result.normalizedText).not.toContain("   ");
  });

  it("handles empty text", () => {
    const extracted = makeExtractOutput({ text: "" });
    const result = stageNormalize(extracted);
    expect(result.normalizedText).toBe("");
  });
});

// ─── stageChunk ───────────────────────────────────────────────────────────────

describe("stageChunk", () => {
  const file = makeScanResult();

  it("returns ChunkOutput with at least one chunk for non-empty text", () => {
    const normalized = { normalizedText: "This is some document text for chunking." };
    const result = stageChunk(normalized, file);
    expect(result).not.toBeNull();
    expect(result!.chunks.length).toBeGreaterThan(0);
  });

  it("returns null for empty normalized text", () => {
    const result = stageChunk({ normalizedText: "" }, file);
    expect(result).toBeNull();
  });

  it("handles whitespace-only text without throwing", () => {
    // Normalizer may or may not collapse to empty; chunker may produce 0 or more chunks
    expect(() => stageChunk({ normalizedText: "   " }, file)).not.toThrow();
  });

  it("docId and docVersion are set on ChunkOutput", () => {
    const normalized = { normalizedText: "Sample document text here." };
    const result = stageChunk(normalized, file);
    expect(result!.docId).toBeTruthy();
    expect(result!.docVersion).toBe(file.fingerprint);
  });

  it("keeps docId stable when only the file fingerprint changes", () => {
    const normalized = { normalizedText: "Sample document text here." };
    const first = stageChunk(normalized, makeScanResult({ sourcePath: "/docs/file.txt", fingerprint: "fp-1" }));
    const second = stageChunk(normalized, makeScanResult({ sourcePath: "/docs/file.txt", fingerprint: "fp-2" }));
    expect(first!.docId).toBe(second!.docId);
    expect(first!.docVersion).not.toBe(second!.docVersion);
  });

  it("chunks have chunkId, chunkHash, text, and offset", () => {
    const normalized = { normalizedText: "Sample document text here." };
    const result = stageChunk(normalized, file);
    for (const chunk of result!.chunks) {
      expect(chunk.chunkId).toBeTruthy();
      expect(chunk.chunkHash).toBeTruthy();
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
      expect(chunk.label).toBeTruthy();
    }
  });

  it("splits long text into multiple chunks", () => {
    const normalized = { normalizedText: "A".repeat(10000) };
    const result = stageChunk(normalized, file);
    expect(result!.chunks.length).toBeGreaterThan(1);
  });

  it("supports explicit fixed strategy override", () => {
    const normalized = { normalizedText: "# Heading\n\nBody paragraph here." };
    const result = stageChunk(normalized, makeScanResult({ sourcePath: "/docs/readme.md", contentType: "txt" }), {
      strategy: "fixed",
    });
    expect(result!.chunks[0]!.label).toBe("text");
  });

  it("uses auto-detected markdown strategy when configured", () => {
    const normalized = { normalizedText: "# Heading\n\nBody paragraph here." };
    const result = stageChunk(normalized, makeScanResult({ sourcePath: "/docs/readme.md", contentType: "txt" }), {
      strategy: "auto",
    });
    expect(result!.chunks[0]!.label).toBe("heading");
  });
});

// ─── stageEmbed ───────────────────────────────────────────────────────────────

describe("stageEmbed", () => {
  function makeChunkOutput(chunkCount: number): ChunkOutput {
    const docId = "doc-1";
    const docVersion = "fp-abc";
    const chunks = Array.from({ length: chunkCount }, (_, i) => ({
      chunkId: `chunk-${i}`,
      chunkHash: `hash-${i}`,
      text: `chunk text ${i}`,
      offset: i * 50,
      label: "text" as const,
    }));
    return { docId, docVersion, chunks };
  }

  it("returns EmbedOutput with vectors matching chunk count", async () => {
    const chunked = makeChunkOutput(3);
    const embedder = makeMockEmbedder([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ]);

    const result = await stageEmbed(chunked, embedder);
    expect(result.vectors).toHaveLength(3);
    expect(result.docId).toBe("doc-1");
    expect(result.docVersion).toBe("fp-abc");
  });

  it("passes chunk texts to the embedder", async () => {
    const chunked = makeChunkOutput(2);
    const embedder = makeMockEmbedder([[0.1, 0.2], [0.3, 0.4]]);

    await stageEmbed(chunked, embedder);

    expect(embedder.embed).toHaveBeenCalledWith(["chunk text 0", "chunk text 1"]);
  });

  it("preserves chunk metadata in EmbedOutput", async () => {
    const chunked = makeChunkOutput(1);
    const embedder = makeMockEmbedder([[0.5, 0.5]]);

    const result = await stageEmbed(chunked, embedder);
    expect(result.chunks[0]!.chunkId).toBe("chunk-0");
    expect(result.chunks[0]!.text).toBe("chunk text 0");
  });

  it("throws EMBED_ERROR when embedder returns wrong vector count", async () => {
    const chunked = makeChunkOutput(3);
    // Embedder returns only 2 vectors for 3 chunks
    const embedder = makeMockEmbedder([[0.1], [0.2]]);

    let caught: unknown;
    try {
      await stageEmbed(chunked, embedder);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AxFabricError);
    expect((caught as AxFabricError).code).toBe("EMBED_ERROR");
  });
});

// ─── stageChunk (additional) ──────────────────────────────────────────────────

describe("stageChunk — strategy selection", () => {
  it("explicit 'markdown' strategy on a non-.md extension still chunks", () => {
    const normalized = { normalizedText: "# Title\n\nSome paragraph text here." };
    const file = makeScanResult({ sourcePath: "/docs/notes.txt", contentType: "txt" });
    const result = stageChunk(normalized, file, { strategy: "markdown" });
    expect(result).not.toBeNull();
    expect(result!.chunks.length).toBeGreaterThan(0);
  });

  it("preserves docVersion equal to file fingerprint", () => {
    const normalized = { normalizedText: "Content for version check." };
    const file = makeScanResult({ fingerprint: "fp-versioned" });
    const result = stageChunk(normalized, file);
    expect(result!.docVersion).toBe("fp-versioned");
  });
});

// ─── stageEmbed (additional) ──────────────────────────────────────────────────

describe("stageEmbed — edge cases", () => {
  it("handles zero chunks by returning EmbedOutput with empty vectors", async () => {
    const chunked: ChunkOutput = { docId: "doc-x", docVersion: "fp-x", chunks: [] };
    const embedder = makeMockEmbedder([]);
    (embedder.embed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await stageEmbed(chunked, embedder);
    expect(result.vectors).toHaveLength(0);
    expect(result.chunks).toHaveLength(0);
  });

  it("preserves docId and docVersion from ChunkOutput unchanged", async () => {
    const chunked: ChunkOutput = {
      docId: "stable-doc-id",
      docVersion: "stable-version",
      chunks: [{ chunkId: "c0", chunkHash: "h0", text: "text", offset: 0, label: "text" }],
    };
    const embedder = makeMockEmbedder([[0.1, 0.2]]);
    const result = await stageEmbed(chunked, embedder);
    expect(result.docId).toBe("stable-doc-id");
    expect(result.docVersion).toBe("stable-version");
  });
});

// ─── stageBuild ───────────────────────────────────────────────────────────────

describe("stageBuild", () => {
  it("builds one Record per chunk", () => {
    const embedded = {
      docId: "doc-1",
      docVersion: "fp-abc",
      chunks: [
        { chunkId: "chunk-0", chunkHash: "hash-0", text: "text 0", offset: 0, label: "text" as const },
        { chunkId: "chunk-1", chunkHash: "hash-1", text: "text 1", offset: 50, label: "text" as const },
      ],
      vectors: [[0.1, 0.2], [0.3, 0.4]],
    };
    const file = makeScanResult();
    const extracted = makeExtractOutput();
    const builder = makeBuilder();

    const result = stageBuild(embedded, file, extracted, builder);

    expect(result.records).toHaveLength(2);
  });

  it("each record has required AkiDB fields", () => {
    const embedded = {
      docId: "doc-1",
      docVersion: "fp-abc",
      chunks: [{ chunkId: "chunk-0", chunkHash: "hash-0", text: "hello", offset: 0, label: "text" as const }],
      vectors: [[0.1, 0.2, 0.3]],
    };
    const file = makeScanResult();
    const extracted = makeExtractOutput();
    const builder = makeBuilder();

    const { records } = stageBuild(embedded, file, extracted, builder);
    const r = records[0]!;

    expect(r.chunk_id).toBeTruthy();
    expect(r.doc_id).toBeTruthy();
    expect(r.doc_version).toBeTruthy();
    expect(r.chunk_hash).toBeTruthy();
    expect(r.pipeline_signature).toBeTruthy();
    expect(r.embedding_model_id).toBe("test-model");
    expect(Array.isArray(r.vector)).toBe(true);
  });

  it("populates metadata with source_uri and content_type", () => {
    const embedded = {
      docId: "doc-1",
      docVersion: "fp-abc",
      chunks: [{ chunkId: "c0", chunkHash: "h0", text: "txt", offset: 0, label: "paragraph" as const }],
      vectors: [[1.0]],
    };
    const file = makeScanResult({ sourcePath: "/docs/file.txt", contentType: "txt" });
    const extracted = makeExtractOutput();
    const builder = makeBuilder();

    const { records } = stageBuild(embedded, file, extracted, builder);

    expect(records[0]!.metadata.source_uri).toBe("/docs/file.txt");
    expect(records[0]!.metadata.content_type).toBe("txt");
    expect(records[0]!.metadata.chunk_label).toBe("paragraph");
  });

  it("propagates pageRange and tableRef into metadata", () => {
    const embedded = {
      docId: "doc-1",
      docVersion: "fp-abc",
      chunks: [{ chunkId: "c0", chunkHash: "h0", text: "txt", offset: 0, label: "table" as const }],
      vectors: [[1.0]],
    };
    const file = makeScanResult();
    const extracted = makeExtractOutput({ pageRange: "2-5", tableRef: "table_3" });
    const builder = makeBuilder();

    const { records } = stageBuild(embedded, file, extracted, builder);

    expect(records[0]!.metadata.page_range).toBe("2-5");
    expect(records[0]!.metadata.table_ref).toBe("table_3");
  });

  it("returns empty records array for zero chunks", () => {
    const embedded = { docId: "doc-1", docVersion: "fp-abc", chunks: [], vectors: [] };
    const { records } = stageBuild(embedded, makeScanResult(), makeExtractOutput(), makeBuilder());
    expect(records).toHaveLength(0);
  });
});
