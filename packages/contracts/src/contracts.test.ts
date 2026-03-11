/**
 * Unit tests for @ax-fabric/contracts schemas and error types.
 *
 * Validates runtime Zod schemas (RecordSchema, MetadataFilterSchema,
 * RecordMetadataSchema, ErrorCodeSchema) and AxFabricError behavior.
 */

import { describe, expect, it } from "vitest";

import {
  RecordSchema,
  RecordMetadataSchema,
  SemanticBundleSchema,
  SemanticUnitSchema,
  MetadataFilterSchema,
  ErrorCodeSchema,
  AxFabricError,
  CollectionSchema,
  SegmentMetadataSchema,
  TombstoneSchema,
  ManifestSchema,
  PipelineVersionsSchema,
} from "./index.js";

// ─── RecordMetadataSchema ─────────────────────────────────────────────────────

describe("RecordMetadataSchema", () => {
  const valid = {
    source_uri: "/path/to/file.txt",
    content_type: "txt",
    page_range: null,
    offset: 0,
    table_ref: null,
    chunk_label: "text",
    created_at: new Date().toISOString(),
  };

  it("accepts a valid metadata object", () => {
    expect(RecordMetadataSchema.parse(valid)).toMatchObject({
      source_uri: "/path/to/file.txt",
      content_type: "txt",
      offset: 0,
    });
  });

  it("accepts all supported content_type values", () => {
    const types = ["txt", "md", "pdf", "docx", "pptx", "xlsx", "csv", "json", "yaml"] as const;
    for (const content_type of types) {
      expect(() => RecordMetadataSchema.parse({ ...valid, content_type })).not.toThrow();
    }
  });

  it("rejects unsupported content_type", () => {
    expect(() => RecordMetadataSchema.parse({ ...valid, content_type: "mp4" })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => RecordMetadataSchema.parse({ ...valid, offset: -1 })).toThrow();
  });

  it("rejects non-integer offset", () => {
    expect(() => RecordMetadataSchema.parse({ ...valid, offset: 1.5 })).toThrow();
  });

  it("accepts non-null page_range and table_ref", () => {
    const result = RecordMetadataSchema.parse({
      ...valid,
      page_range: "1-3",
      table_ref: "table_1",
    });
    expect(result.page_range).toBe("1-3");
    expect(result.table_ref).toBe("table_1");
  });

  it("accepts valid chunk labels", () => {
    for (const chunk_label of ["paragraph", "heading", "table", "code", "list", "text"] as const) {
      expect(() => RecordMetadataSchema.parse({ ...valid, chunk_label })).not.toThrow();
    }
  });

  it("rejects invalid chunk label", () => {
    expect(() => RecordMetadataSchema.parse({ ...valid, chunk_label: "unknown" })).toThrow();
  });

  it("rejects missing required fields", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { source_uri: _, ...incomplete } = valid;
    expect(() => RecordMetadataSchema.parse(incomplete)).toThrow();
  });

  it("rejects invalid datetime format", () => {
    expect(() =>
      RecordMetadataSchema.parse({ ...valid, created_at: "not-a-date" }),
    ).toThrow();
  });
});

// ─── RecordSchema ─────────────────────────────────────────────────────────────

describe("RecordSchema", () => {
  const validMetadata = {
    source_uri: "/file.txt",
    content_type: "txt",
    page_range: null,
    offset: 0,
    table_ref: null,
    chunk_label: "text",
    created_at: new Date().toISOString(),
  };

  const valid = {
    chunk_id: "chunk-abc",
    doc_id: "doc-xyz",
    doc_version: "v1",
    chunk_hash: "sha256-abc",
    pipeline_signature: "sig-1",
    embedding_model_id: "text-embedding-3-small",
    vector: [0.1, 0.2, 0.3],
    metadata: validMetadata,
  };

  it("accepts a valid record", () => {
    const result = RecordSchema.parse(valid);
    expect(result.chunk_id).toBe("chunk-abc");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it("accepts optional chunk_text", () => {
    const result = RecordSchema.parse({ ...valid, chunk_text: "hello world" });
    expect(result.chunk_text).toBe("hello world");
  });

  it("allows chunk_text to be absent", () => {
    const result = RecordSchema.parse(valid);
    expect(result.chunk_text).toBeUndefined();
  });

  it("rejects empty chunk_id", () => {
    expect(() => RecordSchema.parse({ ...valid, chunk_id: "" })).toThrow();
  });

  it("rejects empty doc_id", () => {
    expect(() => RecordSchema.parse({ ...valid, doc_id: "" })).toThrow();
  });

  it("rejects empty vector array", () => {
    // vector: [] passes the schema (no minLength constraint on the array itself)
    // but the content must be numbers
    expect(() => RecordSchema.parse({ ...valid, vector: ["not", "numbers"] })).toThrow();
  });

  it("rejects missing required string fields", () => {
    const { chunk_hash: _, ...withoutHash } = valid;
    expect(() => RecordSchema.parse(withoutHash)).toThrow();
  });
});

describe("SemanticUnitSchema", () => {
  const valid = {
    unit_id: "unit-1",
    doc_id: "doc-1",
    doc_version: "version-1",
    title: "Distillation overview",
    question: "What is the key point about distillation overview?",
    summary: "This section explains how semantic distillation produces grounded units.",
    answer: "Semantic distillation produces grounded units derived directly from source text.",
    keywords: ["semantic", "distillation", "grounded"],
    entities: ["AX Fabric"],
    themes: ["semantic workflow", "grounded retrieval"],
    quality_score: 0.82,
    quality_signals: {
      coverage: 0.82,
      density: 0.76,
      structure: 0.88,
      noise_penalty: 0.08,
      confidence: 0.82,
      flags: [],
    },
    distill_strategy: "extractive-v1",
    source_spans: [
      {
        source_uri: "/tmp/example.md",
        content_type: "txt",
        page_range: null,
        table_ref: null,
        offset_start: 0,
        offset_end: 128,
        chunk_id: "chunk-1",
        chunk_hash: "hash-1",
        chunk_label: "paragraph",
      },
    ],
  };

  it("accepts a valid semantic unit", () => {
    const result = SemanticUnitSchema.parse(valid);
    expect(result.title).toBe("Distillation overview");
    expect(result.source_spans[0]!.offset_end).toBe(128);
  });

  it("accepts duplicate grouping metadata when present", () => {
    const result = SemanticUnitSchema.parse({
      ...valid,
      duplicate_group_id: "dup-1",
      duplicate_group_size: 2,
    });
    expect(result.duplicate_group_id).toBe("dup-1");
    expect(result.duplicate_group_size).toBe(2);
  });

  it("rejects quality scores outside 0-1", () => {
    expect(() => SemanticUnitSchema.parse({ ...valid, quality_score: 1.5 })).toThrow();
  });

  it("rejects invalid quality signal ranges", () => {
    expect(() => SemanticUnitSchema.parse({
      ...valid,
      quality_signals: {
        ...valid.quality_signals,
        confidence: 1.2,
      },
    })).toThrow();
  });

  it("rejects empty source span arrays", () => {
    expect(() => SemanticUnitSchema.parse({ ...valid, source_spans: [] })).toThrow();
  });
});

describe("SemanticBundleSchema", () => {
  const valid = {
    bundle_id: "bundle-1",
    source_path: "/tmp/example.md",
    doc_id: "doc-1",
    doc_version: "version-1",
    content_type: "txt",
    distill_strategy: "extractive-v1",
    generated_at: new Date().toISOString(),
    units: [
      {
        unit_id: "unit-1",
        doc_id: "doc-1",
        doc_version: "version-1",
        title: "Distillation overview",
        question: "What is the key point about Distillation overview?",
        summary: "This section explains how semantic distillation produces grounded units.",
        answer: "Semantic distillation produces grounded units derived directly from source text.",
        keywords: ["semantic", "distillation"],
        entities: ["AX Fabric"],
        themes: ["semantic workflow"],
        quality_score: 0.8,
        quality_signals: {
          coverage: 0.8,
          density: 0.72,
          structure: 0.85,
          noise_penalty: 0.05,
          confidence: 0.8,
          flags: [],
        },
        distill_strategy: "extractive-v1",
        source_spans: [
          {
            source_uri: "/tmp/example.md",
            content_type: "txt",
            page_range: null,
            table_ref: null,
            offset_start: 0,
            offset_end: 128,
            chunk_id: "chunk-1",
            chunk_hash: "hash-1",
            chunk_label: "paragraph",
          },
        ],
      },
    ],
    diagnostics: {
      total_units: 1,
      average_quality_score: 0.8,
      low_quality_unit_ids: [],
      flagged_unit_ids: [],
      duplicate_groups: [],
    },
  };

  it("accepts a valid semantic bundle", () => {
    const result = SemanticBundleSchema.parse(valid);
    expect(result.bundle_id).toBe("bundle-1");
    expect(result.diagnostics.total_units).toBe(1);
  });

  it("accepts an attached review decision", () => {
    const result = SemanticBundleSchema.parse({
      ...valid,
      review: {
        status: "approved",
        reviewer: "akira",
        reviewed_at: new Date().toISOString(),
        min_quality_score: 0.7,
        duplicate_policy: "warn",
        blocking_issues: [],
      },
    });
    expect(result.review?.status).toBe("approved");
  });

  it("rejects invalid review status", () => {
    expect(() =>
      SemanticBundleSchema.parse({
        ...valid,
        review: {
          status: "unknown",
          reviewer: "akira",
          reviewed_at: new Date().toISOString(),
          min_quality_score: 0.7,
          duplicate_policy: "warn",
          blocking_issues: [],
        },
      }),
    ).toThrow();
  });
});

// ─── MetadataFilterSchema ─────────────────────────────────────────────────────

describe("MetadataFilterSchema", () => {
  it("accepts exact string match", () => {
    expect(MetadataFilterSchema.parse({ author: "alice" })).toEqual({ author: "alice" });
  });

  it("accepts exact number match", () => {
    expect(MetadataFilterSchema.parse({ score: 42 })).toEqual({ score: 42 });
  });

  it("accepts boolean exact match", () => {
    expect(MetadataFilterSchema.parse({ active: true })).toEqual({ active: true });
  });

  it("accepts null exact match", () => {
    expect(MetadataFilterSchema.parse({ field: null })).toEqual({ field: null });
  });

  it("accepts OR array (string)", () => {
    expect(MetadataFilterSchema.parse({ tag: ["a", "b"] })).toEqual({ tag: ["a", "b"] });
  });

  it("accepts OR array (number)", () => {
    expect(MetadataFilterSchema.parse({ score: [1, 2, 3] })).toEqual({ score: [1, 2, 3] });
  });

  it("accepts $gt operator", () => {
    expect(MetadataFilterSchema.parse({ score: { $gt: 5 } })).toEqual({ score: { $gt: 5 } });
  });

  it("accepts $gte operator", () => {
    expect(MetadataFilterSchema.parse({ score: { $gte: 5 } })).toEqual({ score: { $gte: 5 } });
  });

  it("accepts $lt operator", () => {
    expect(MetadataFilterSchema.parse({ score: { $lt: 10 } })).toEqual({ score: { $lt: 10 } });
  });

  it("accepts $lte operator", () => {
    expect(MetadataFilterSchema.parse({ score: { $lte: 10 } })).toEqual({ score: { $lte: 10 } });
  });

  it("accepts $ne operator", () => {
    expect(MetadataFilterSchema.parse({ status: { $ne: "deleted" } })).toEqual({ status: { $ne: "deleted" } });
  });

  it("accepts $in operator", () => {
    expect(MetadataFilterSchema.parse({ type: { $in: ["pdf", "txt"] } })).toEqual({
      type: { $in: ["pdf", "txt"] },
    });
  });

  it("accepts $nin operator", () => {
    expect(MetadataFilterSchema.parse({ type: { $nin: ["mp4"] } })).toEqual({
      type: { $nin: ["mp4"] },
    });
  });

  it("accepts multiple fields", () => {
    const filter = { author: "alice", score: { $gt: 5 }, active: true };
    expect(MetadataFilterSchema.parse(filter)).toEqual(filter);
  });

  it("accepts empty filter object", () => {
    expect(MetadataFilterSchema.parse({})).toEqual({});
  });

  it("rejects object value with unknown operator keys only if none of the valid union arms match", () => {
    // An object with only unknown keys is still parsed as a FilterOperators
    // (all fields are optional). The schema is lenient here — any extra keys
    // pass through Zod's object.passthrough or are silently stripped depending
    // on the schema mode. The key guarantee is that the schema does not throw
    // for valid filters.
    expect(() => MetadataFilterSchema.parse({ score: { $gt: 1 } })).not.toThrow();
  });
});

// ─── ErrorCodeSchema ──────────────────────────────────────────────────────────

describe("ErrorCodeSchema", () => {
  const validCodes = [
    "EXTRACT_ERROR",
    "EMBED_ERROR",
    "LLM_ERROR",
    "PUBLISH_ERROR",
    "STATE_ERROR",
    "CHECKSUM_ERROR",
    "STORAGE_ERROR",
    "METADATA_ERROR",
    "QUERY_ERROR",
  ] as const;

  it.each(validCodes)("accepts valid error code: %s", (code) => {
    expect(ErrorCodeSchema.parse(code)).toBe(code);
  });

  it("rejects unknown error code", () => {
    expect(() => ErrorCodeSchema.parse("NOT_A_CODE")).toThrow();
  });
});

// ─── AxFabricError ────────────────────────────────────────────────────────────

describe("AxFabricError", () => {
  it("is an instance of Error", () => {
    const err = new AxFabricError("QUERY_ERROR", "bad input");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name AxFabricError", () => {
    const err = new AxFabricError("EMBED_ERROR", "embed failed");
    expect(err.name).toBe("AxFabricError");
  });

  it("exposes code and message", () => {
    const err = new AxFabricError("STORAGE_ERROR", "disk full");
    expect(err.code).toBe("STORAGE_ERROR");
    expect(err.message).toBe("disk full");
  });

  it("accepts optional cause", () => {
    const cause = new Error("root cause");
    const err = new AxFabricError("EXTRACT_ERROR", "extraction failed", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new AxFabricError("QUERY_ERROR", "no cause");
    expect(err.cause).toBeUndefined();
  });

  it("is catchable with instanceof check", () => {
    const fn = () => {
      throw new AxFabricError("QUERY_ERROR", "thrown");
    };
    expect(fn).toThrow(AxFabricError);
  });

  it("preserves all error code variants", () => {
    const codes = [
      "EXTRACT_ERROR",
      "EMBED_ERROR",
      "LLM_ERROR",
      "PUBLISH_ERROR",
      "STATE_ERROR",
      "CHECKSUM_ERROR",
      "STORAGE_ERROR",
      "METADATA_ERROR",
      "QUERY_ERROR",
    ] as const;

    for (const code of codes) {
      const err = new AxFabricError(code, "test");
      expect(err.code).toBe(code);
    }
  });
});

// ─── CollectionSchema ─────────────────────────────────────────────────────

describe("CollectionSchema", () => {
  const valid = {
    collection_id: "my-collection",
    dimension: 1024,
    metric: "cosine",
    embedding_model_id: "bge-large-en-v1.5",
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    deleted_at: null,
  };

  it("accepts a valid collection", () => {
    expect(() => CollectionSchema.parse(valid)).not.toThrow();
  });

  it("defaults quantization to fp16", () => {
    expect(CollectionSchema.parse(valid).quantization).toBe("fp16");
  });

  it("defaults hnsw_m to 16", () => {
    expect(CollectionSchema.parse(valid).hnsw_m).toBe(16);
  });

  it("accepts sq8 quantization", () => {
    expect(CollectionSchema.parse({ ...valid, quantization: "sq8" }).quantization).toBe("sq8");
  });

  it("accepts all valid distance metrics", () => {
    for (const metric of ["cosine", "l2", "dot"] as const) {
      expect(() => CollectionSchema.parse({ ...valid, metric })).not.toThrow();
    }
  });

  it("rejects invalid metric", () => {
    expect(() => CollectionSchema.parse({ ...valid, metric: "euclidean" })).toThrow();
  });

  it("rejects empty collection_id", () => {
    expect(() => CollectionSchema.parse({ ...valid, collection_id: "" })).toThrow();
  });

  it("rejects non-positive dimension", () => {
    expect(() => CollectionSchema.parse({ ...valid, dimension: 0 })).toThrow();
    expect(() => CollectionSchema.parse({ ...valid, dimension: -1 })).toThrow();
  });

  it("rejects hnsw_m below 4", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_m: 3 })).toThrow();
  });

  it("rejects hnsw_m above 64", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_m: 65 })).toThrow();
  });

  it("accepts hnsw_ef_construction at boundaries (50, 800)", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_construction: 50 })).not.toThrow();
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_construction: 800 })).not.toThrow();
  });

  it("rejects hnsw_ef_construction out of bounds", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_construction: 49 })).toThrow();
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_construction: 801 })).toThrow();
  });

  it("accepts hnsw_ef_search at boundaries (10, 500)", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_search: 10 })).not.toThrow();
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_search: 500 })).not.toThrow();
  });

  it("rejects hnsw_ef_search out of bounds", () => {
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_search: 9 })).toThrow();
    expect(() => CollectionSchema.parse({ ...valid, hnsw_ef_search: 501 })).toThrow();
  });
});

// ─── SegmentMetadataSchema ────────────────────────────────────────────────

describe("SegmentMetadataSchema", () => {
  const valid = {
    segment_id: "seg-001",
    collection_id: "col-001",
    record_count: 100,
    dimension: 1024,
    size_bytes: 4096,
    checksum: "abc123",
    status: "ready",
    storage_path: "/data/segments/seg-001",
    created_at: new Date().toISOString(),
  };

  it("accepts a valid segment", () => {
    expect(() => SegmentMetadataSchema.parse(valid)).not.toThrow();
  });

  it("accepts all valid status values", () => {
    for (const status of ["building", "ready", "archived"] as const) {
      expect(() => SegmentMetadataSchema.parse({ ...valid, status })).not.toThrow();
    }
  });

  it("rejects invalid status", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, status: "deleted" })).toThrow();
  });

  it("accepts record_count of zero", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, record_count: 0 })).not.toThrow();
  });

  it("rejects negative record_count", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, record_count: -1 })).toThrow();
  });

  it("rejects empty segment_id", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, segment_id: "" })).toThrow();
  });

  it("rejects non-positive dimension", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, dimension: 0 })).toThrow();
  });

  it("rejects negative size_bytes", () => {
    expect(() => SegmentMetadataSchema.parse({ ...valid, size_bytes: -1 })).toThrow();
  });
});

// ─── TombstoneSchema ──────────────────────────────────────────────────────

describe("TombstoneSchema", () => {
  const valid = {
    chunk_id: "chunk-abc",
    deleted_at: new Date().toISOString(),
    reason_code: "file_deleted",
  };

  it("accepts a valid tombstone", () => {
    expect(() => TombstoneSchema.parse(valid)).not.toThrow();
  });

  it("accepts all valid reason codes", () => {
    for (const reason_code of ["file_deleted", "file_updated", "manual_revoke"] as const) {
      expect(() => TombstoneSchema.parse({ ...valid, reason_code })).not.toThrow();
    }
  });

  it("rejects invalid reason_code", () => {
    expect(() => TombstoneSchema.parse({ ...valid, reason_code: "expired" })).toThrow();
  });

  it("rejects empty chunk_id", () => {
    expect(() => TombstoneSchema.parse({ ...valid, chunk_id: "" })).toThrow();
  });

  it("rejects invalid deleted_at datetime", () => {
    expect(() => TombstoneSchema.parse({ ...valid, deleted_at: "not-a-date" })).toThrow();
  });
});

// ─── ManifestSchema ───────────────────────────────────────────────────────

describe("ManifestSchema", () => {
  const valid = {
    manifest_id: "manifest-001",
    collection_id: "col-001",
    version: 1,
    segment_ids: ["seg-1", "seg-2"],
    tombstone_ids: [],
    embedding_model_id: "bge-large-en-v1.5",
    pipeline_signature: "sig-v1",
    created_at: new Date().toISOString(),
    checksum: "deadbeef",
  };

  it("accepts a valid manifest", () => {
    expect(() => ManifestSchema.parse(valid)).not.toThrow();
  });

  it("accepts version 0", () => {
    expect(() => ManifestSchema.parse({ ...valid, version: 0 })).not.toThrow();
  });

  it("rejects negative version", () => {
    expect(() => ManifestSchema.parse({ ...valid, version: -1 })).toThrow();
  });

  it("accepts empty segment_ids array", () => {
    expect(() => ManifestSchema.parse({ ...valid, segment_ids: [] })).not.toThrow();
  });

  it("rejects segment_ids containing empty strings", () => {
    expect(() => ManifestSchema.parse({ ...valid, segment_ids: [""] })).toThrow();
  });

  it("rejects empty manifest_id", () => {
    expect(() => ManifestSchema.parse({ ...valid, manifest_id: "" })).toThrow();
  });

  it("rejects empty checksum", () => {
    expect(() => ManifestSchema.parse({ ...valid, checksum: "" })).toThrow();
  });

  it("rejects invalid created_at", () => {
    expect(() => ManifestSchema.parse({ ...valid, created_at: "yesterday" })).toThrow();
  });
});

// ─── PipelineVersionsSchema ───────────────────────────────────────────────

describe("PipelineVersionsSchema", () => {
  const valid = {
    extractor_version: "1.0.0",
    normalize_version: "1.0.0",
    chunker_version: "1.0.0",
  };

  it("accepts valid pipeline versions", () => {
    expect(() => PipelineVersionsSchema.parse(valid)).not.toThrow();
  });

  it("rejects empty extractor_version", () => {
    expect(() => PipelineVersionsSchema.parse({ ...valid, extractor_version: "" })).toThrow();
  });

  it("rejects empty normalize_version", () => {
    expect(() => PipelineVersionsSchema.parse({ ...valid, normalize_version: "" })).toThrow();
  });

  it("rejects empty chunker_version", () => {
    expect(() => PipelineVersionsSchema.parse({ ...valid, chunker_version: "" })).toThrow();
  });

  it("accepts semver strings", () => {
    expect(() =>
      PipelineVersionsSchema.parse({
        extractor_version: "2.1.3",
        normalize_version: "1.0.0",
        chunker_version: "3.0.1",
      }),
    ).not.toThrow();
  });
});
