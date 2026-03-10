/**
 * Tests for Layer 2.6 — Record Builder.
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { PipelineVersions } from "@ax-fabric/contracts";
import { describe, expect, it } from "vitest";

import type { ChunkWithEmbedding } from "./record-builder.js";
import { RecordBuilder } from "./record-builder.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PIPELINE_SIGNATURE = "abc123";
const EMBEDDING_MODEL_ID = "test-model-v1";

function makeBuilder(): RecordBuilder {
  return new RecordBuilder({
    embeddingModelId: EMBEDDING_MODEL_ID,
    pipelineSignature: PIPELINE_SIGNATURE,
  });
}

function makeChunk(index: number): ChunkWithEmbedding {
  return {
    chunkId: `chunk-${String(index).padStart(3, "0")}`,
    chunkHash: `hash-${String(index)}`,
    text: `This is chunk number ${String(index)}.`,
    offset: index * 100,
    vector: [0.1, 0.2, 0.3, 0.4],
    sourcePath: `file:///docs/test-${String(index)}.txt`,
    contentType: "txt",
    pageRange: null,
    tableRef: null,
  };
}

// ─── buildRecords ───────────────────────────────────────────────────────────

describe("RecordBuilder.buildRecords", () => {
  it("assembles valid Record objects from chunks", () => {
    const builder = makeBuilder();
    const chunks = [makeChunk(0), makeChunk(1)];

    const records = builder.buildRecords("doc-1", "v1", chunks);

    expect(records).toHaveLength(2);
    expect(records[0]!.chunk_id).toBe("chunk-000");
    expect(records[0]!.doc_id).toBe("doc-1");
    expect(records[0]!.doc_version).toBe("v1");
    expect(records[0]!.chunk_hash).toBe("hash-0");
    expect(records[0]!.pipeline_signature).toBe(PIPELINE_SIGNATURE);
    expect(records[0]!.embedding_model_id).toBe(EMBEDDING_MODEL_ID);
    expect(records[0]!.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("populates metadata correctly", () => {
    const builder = makeBuilder();
    const chunk: ChunkWithEmbedding = {
      ...makeChunk(0),
      sourcePath: "file:///data/report.pdf",
      contentType: "pdf",
      pageRange: "1-3",
      tableRef: null,
    };

    const [record] = builder.buildRecords("doc-pdf", "v2", [chunk]);

    expect(record!.metadata.source_uri).toBe("file:///data/report.pdf");
    expect(record!.metadata.content_type).toBe("pdf");
    expect(record!.metadata.page_range).toBe("1-3");
    expect(record!.metadata.offset).toBe(0);
    expect(record!.metadata.table_ref).toBeNull();
    expect(record!.metadata.created_at).toBeTruthy();
  });

  it("returns empty array for empty chunks", () => {
    const builder = makeBuilder();
    const records = builder.buildRecords("doc-1", "v1", []);
    expect(records).toEqual([]);
  });

  it("validates records against RecordSchema", () => {
    const builder = makeBuilder();
    // chunkId must be non-empty
    const badChunk: ChunkWithEmbedding = {
      ...makeChunk(0),
      chunkId: "",
    };

    expect(() => builder.buildRecords("doc-1", "v1", [badChunk])).toThrow(
      AxFabricError,
    );
  });

  it("sets created_at to a valid ISO datetime", () => {
    const builder = makeBuilder();
    const [record] = builder.buildRecords("doc-1", "v1", [makeChunk(0)]);
    const date = new Date(record!.metadata.created_at);
    expect(date.toISOString()).toBe(record!.metadata.created_at);
  });
});

// ─── buildTombstones ────────────────────────────────────────────────────────

describe("RecordBuilder.buildTombstones", () => {
  it("creates tombstones for given chunk IDs", () => {
    const builder = makeBuilder();
    const tombstones = builder.buildTombstones(
      ["chunk-001", "chunk-002"],
      "file_deleted",
    );

    expect(tombstones).toHaveLength(2);
    expect(tombstones[0]!.chunk_id).toBe("chunk-001");
    expect(tombstones[0]!.reason_code).toBe("file_deleted");
    expect(tombstones[1]!.chunk_id).toBe("chunk-002");
  });

  it("uses consistent deleted_at for all tombstones in a batch", () => {
    const builder = makeBuilder();
    const tombstones = builder.buildTombstones(
      ["a", "b", "c"],
      "file_updated",
    );

    const timestamps = tombstones.map((t) => t.deleted_at);
    expect(timestamps[0]).toBe(timestamps[1]);
    expect(timestamps[1]).toBe(timestamps[2]);
  });

  it("supports all tombstone reason codes", () => {
    const builder = makeBuilder();

    for (const reason of ["file_deleted", "file_updated", "manual_revoke"] as const) {
      const [t] = builder.buildTombstones(["x"], reason);
      expect(t!.reason_code).toBe(reason);
    }
  });

  it("returns empty array for empty input", () => {
    const builder = makeBuilder();
    const tombstones = builder.buildTombstones([], "file_deleted");
    expect(tombstones).toEqual([]);
  });
});

// ─── Static helpers ─────────────────────────────────────────────────────────

describe("RecordBuilder.computePipelineSignature", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const versions: PipelineVersions = {
      extractor_version: "1.0.0",
      normalize_version: "1.0.0",
      chunker_version: "1.0.0",
    };

    const sig = RecordBuilder.computePipelineSignature(versions);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const versions: PipelineVersions = {
      extractor_version: "2.0.0",
      normalize_version: "1.0.0",
      chunker_version: "1.0.0",
    };

    const sig1 = RecordBuilder.computePipelineSignature(versions);
    const sig2 = RecordBuilder.computePipelineSignature(versions);
    expect(sig1).toBe(sig2);
  });

  it("changes when any version component changes", () => {
    const base: PipelineVersions = {
      extractor_version: "1.0.0",
      normalize_version: "1.0.0",
      chunker_version: "1.0.0",
    };

    const withNewExtractor: PipelineVersions = {
      ...base,
      extractor_version: "1.0.1",
    };
    const withNewNormalizer: PipelineVersions = {
      ...base,
      normalize_version: "1.0.1",
    };
    const withNewChunker: PipelineVersions = {
      ...base,
      chunker_version: "1.0.1",
    };

    const baseSig = RecordBuilder.computePipelineSignature(base);
    expect(RecordBuilder.computePipelineSignature(withNewExtractor)).not.toBe(baseSig);
    expect(RecordBuilder.computePipelineSignature(withNewNormalizer)).not.toBe(baseSig);
    expect(RecordBuilder.computePipelineSignature(withNewChunker)).not.toBe(baseSig);
  });
});

describe("RecordBuilder.computeDocId", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const docId = RecordBuilder.computeDocId("/docs/file.txt", "abc123hash");
    expect(docId).toHaveLength(64);
    expect(docId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const id1 = RecordBuilder.computeDocId("/a/b.txt", "hash1");
    const id2 = RecordBuilder.computeDocId("/a/b.txt", "hash1");
    expect(id1).toBe(id2);
  });

  it("differs when path or hash differs", () => {
    const id1 = RecordBuilder.computeDocId("/a/b.txt", "hash1");
    const id2 = RecordBuilder.computeDocId("/a/c.txt", "hash1");
    const id3 = RecordBuilder.computeDocId("/a/b.txt", "hash2");
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });
});
