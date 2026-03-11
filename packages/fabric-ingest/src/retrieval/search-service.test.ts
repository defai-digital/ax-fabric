import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { AkiDB } from "@ax-fabric/akidb";
import type { Record } from "@ax-fabric/contracts";

import { SemanticReviewEngine, SemanticStore } from "../semantic/index.js";

import { buildCliFilters, executeSearch, parseRequestedLayer } from "./search-service.js";

describe("search-service", () => {
  it("parses requested retrieval layer flags", () => {
    expect(parseRequestedLayer({})).toBe("auto");
    expect(parseRequestedLayer({ semantic: true })).toBe("semantic");
    expect(parseRequestedLayer({ fuse: true })).toBe("fused");
    expect(parseRequestedLayer({ layer: "raw" })).toBe("raw");
  });

  it("builds metadata filters from CLI options", () => {
    expect(buildCliFilters({
      sourceUri: "/docs/a.txt",
      contentType: "txt",
      chunkLabel: "paragraph",
    })).toEqual({
      source_uri: "/docs/a.txt",
      content_type: "txt",
      chunk_label: "paragraph",
    });
  });

  it("falls back to raw retrieval when semantic collection is not published", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "search-service-fallback-"));
    const akidbRoot = join(workdir, "akidb");
    const dataRoot = join(workdir, "data");
    const db = new AkiDB({ storagePath: akidbRoot });

    try {
      db.createCollection({
        collectionId: "docs",
        dimension: 4,
        metric: "cosine",
        embeddingModelId: "mock",
      });

      const records: Record[] = [{
        chunk_id: "chunk-1",
        doc_id: "doc-1",
        doc_version: "v1",
        chunk_hash: "hash-1",
        pipeline_signature: "sig-1",
        embedding_model_id: "mock",
        vector: [0.1, 0.1, 0.1, 0.1],
        metadata: {
          source_uri: "/docs/a.txt",
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          chunk_label: "paragraph",
          created_at: new Date().toISOString(),
        },
        chunk_text: "hello world",
      }];

      await db.upsertBatch("docs", records);
      await db.publish("docs", { embeddingModelId: "mock", pipelineSignature: "sig-1" });

      const result = await executeSearch({
        db,
        dataRoot,
        rawCollectionId: "docs",
        semanticCollectionId: "docs-semantic",
        requestedLayer: "semantic",
        defaultLayer: "auto",
        queryVector: new Float32Array([0.1, 0.1, 0.1, 0.1]),
        topK: 5,
        mode: "vector",
      });

      expect(result.layer).toBe("raw");
      expect(result.collectionId).toBe("docs");
      expect(result.results[0]!.matchedLayers).toEqual(["raw"]);
    } finally {
      db.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("deduplicates raw and semantic hits by shared provenance in fused mode", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "search-service-fused-"));
    const akidbRoot = join(workdir, "akidb");
    const dataRoot = join(workdir, "data");
    const db = new AkiDB({ storagePath: akidbRoot });
    const semanticDbPath = join(dataRoot, "semantic.db");
    const sourcePath = join(workdir, "guide.txt");
    writeFileSync(sourcePath, "Shared provenance should collapse duplicate raw and semantic hits.", "utf8");

    try {
      db.createCollection({
        collectionId: "docs",
        dimension: 4,
        metric: "cosine",
        embeddingModelId: "mock",
      });
      db.createCollection({
        collectionId: "docs-semantic",
        dimension: 4,
        metric: "cosine",
        embeddingModelId: "mock",
      });

      const rawRecord: Record = {
        chunk_id: "raw-chunk-1",
        doc_id: "doc-1",
        doc_version: "v1",
        chunk_hash: "hash-1",
        pipeline_signature: "sig-1",
        embedding_model_id: "mock",
        vector: [0.1, 0.1, 0.1, 0.1],
        metadata: {
          source_uri: sourcePath,
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          chunk_label: "paragraph",
          created_at: new Date().toISOString(),
        },
        chunk_text: "shared provenance raw text",
      };

      await db.upsertBatch("docs", [rawRecord]);
      await db.publish("docs", { embeddingModelId: "mock", pipelineSignature: "sig-1" });

      const reviewEngine = new SemanticReviewEngine();
      const bundle = await reviewEngine.createBundle(sourcePath);
      const approved = reviewEngine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.1,
        duplicatePolicy: "warn",
      });
      const patchedBundle = {
        ...approved,
        units: approved.units.map((unit) => ({
          ...unit,
          source_spans: unit.source_spans.map((span) => ({ ...span, chunk_id: "raw-chunk-1" })),
        })),
      };

      const store = new SemanticStore(semanticDbPath);
      store.upsertBundle(patchedBundle);
      store.markPublished(patchedBundle.bundle_id, {
        collectionId: "docs-semantic",
        manifestVersion: 1,
        publishedAt: new Date().toISOString(),
      });

      const semanticRecords: Record[] = patchedBundle.units.map((unit) => ({
        chunk_id: `semantic:${unit.unit_id}`,
        doc_id: patchedBundle.doc_id,
        doc_version: patchedBundle.doc_version,
        chunk_hash: `semantic-${unit.unit_id}`,
        pipeline_signature: "semantic-sig",
        embedding_model_id: "mock",
        vector: [0.1, 0.1, 0.1, 0.1],
        metadata: {
          source_uri: sourcePath,
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          chunk_label: "paragraph",
          created_at: new Date().toISOString(),
        },
        chunk_text: `${unit.title}\n${unit.summary}`,
      }));

      await db.upsertBatch("docs-semantic", semanticRecords);
      await db.publish("docs-semantic", { embeddingModelId: "mock", pipelineSignature: "semantic-sig" });

      const result = await executeSearch({
        db,
        dataRoot,
        rawCollectionId: "docs",
        semanticCollectionId: "docs-semantic",
        requestedLayer: "fused",
        defaultLayer: "auto",
        queryVector: new Float32Array([0.1, 0.1, 0.1, 0.1]),
        topK: 10,
        mode: "vector",
      });

      expect(result.layer).toBe("fused");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.collection).toBe("raw+semantic");
      expect(result.results[0]!.matchedLayers).toEqual(["raw", "semantic"]);
      expect(result.results[0]!.semanticQualityScore).toBeGreaterThan(0);
      expect(result.results[0]!.semanticTitle).toBeTruthy();
      store.close();
    } finally {
      db.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Additional tests for parseRequestedLayer
// ---------------------------------------------------------------------------

describe("parseRequestedLayer — additional cases", () => {
  it("throws a descriptive error for an invalid layer string", () => {
    expect(() => parseRequestedLayer({ layer: "invalid" })).toThrow(
      "--layer must be one of: auto, raw, semantic, fused",
    );
  });

  it("returns 'fused' when fuse: true is set even if layer is also specified", () => {
    // fuse: true takes priority over the layer option.
    expect(parseRequestedLayer({ fuse: true, layer: "raw" })).toBe("fused");
  });

  it("throws for any unrecognised non-empty layer value", () => {
    // Empty string is treated as falsy by the implementation (returns "auto"),
    // so only test genuinely unrecognised non-empty values here.
    for (const bad of ["all", "FUSED", "Raw", "0", "none"]) {
      expect(() => parseRequestedLayer({ layer: bad })).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional tests for buildCliFilters
// ---------------------------------------------------------------------------

describe("buildCliFilters — additional cases", () => {
  it("returns undefined when called with an empty options object", () => {
    expect(buildCliFilters({})).toBeUndefined();
  });

  it("returns a filter with only source_uri when only sourceUri is provided", () => {
    const filter = buildCliFilters({ sourceUri: "/docs/readme.txt" });
    expect(filter).toEqual({ source_uri: "/docs/readme.txt" });
    // contentType and chunk_label must NOT be present.
    expect(filter).not.toHaveProperty("content_type");
    expect(filter).not.toHaveProperty("chunk_label");
  });

  it("throws an error for an invalid contentType (e.g. 'exe')", () => {
    expect(() => buildCliFilters({ contentType: "exe" })).toThrow();
  });

  it("throws an error for an invalid chunkLabel (e.g. 'footer')", () => {
    expect(() => buildCliFilters({ chunkLabel: "footer" })).toThrow();
  });

  it("accepts all valid content types without throwing", () => {
    const valid = ["txt", "md", "pdf", "docx", "pptx", "xlsx", "csv", "tsv", "json", "jsonl", "yaml", "html", "rtf", "sql", "log"];
    for (const ct of valid) {
      expect(() => buildCliFilters({ contentType: ct })).not.toThrow();
    }
  });

  it("accepts all valid chunk labels without throwing", () => {
    const valid = ["paragraph", "heading", "table", "code", "list", "text"];
    for (const label of valid) {
      expect(() => buildCliFilters({ chunkLabel: label })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional tests for executeSearch — raw layer
// ---------------------------------------------------------------------------

describe("executeSearch with requestedLayer: 'raw'", () => {
  it("uses the raw collection and returns layer: 'raw'", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "search-service-raw-"));
    const akidbRoot = join(workdir, "akidb");
    const dataRoot = join(workdir, "data");
    const db = new AkiDB({ storagePath: akidbRoot });

    try {
      db.createCollection({
        collectionId: "docs",
        dimension: 4,
        metric: "cosine",
        embeddingModelId: "mock",
      });

      const records: Record[] = [
        {
          chunk_id: "raw-only-chunk",
          doc_id: "doc-raw",
          doc_version: "v1",
          chunk_hash: "hash-raw",
          pipeline_signature: "sig-raw",
          embedding_model_id: "mock",
          vector: [0.1, 0.2, 0.3, 0.4],
          metadata: {
            source_uri: "/docs/raw.txt",
            content_type: "txt",
            page_range: null,
            offset: 0,
            table_ref: null,
            chunk_label: "paragraph",
            created_at: new Date().toISOString(),
          },
          chunk_text: "raw collection test content",
        },
      ];

      await db.upsertBatch("docs", records);
      await db.publish("docs", { embeddingModelId: "mock", pipelineSignature: "sig-raw" });

      const result = await executeSearch({
        db,
        dataRoot,
        rawCollectionId: "docs",
        semanticCollectionId: "docs-semantic",
        requestedLayer: "raw",
        defaultLayer: "auto",
        queryVector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        topK: 5,
        mode: "vector",
      });

      expect(result.layer).toBe("raw");
      expect(result.collectionId).toBe("docs");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.chunkId).toBe("raw-only-chunk");
    } finally {
      db.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
