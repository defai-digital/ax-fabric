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
      store.close();
    } finally {
      db.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
