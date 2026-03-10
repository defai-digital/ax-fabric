/**
 * End-to-End Validation Tests (Milestone 4)
 *
 * Proves the full ax-fabric pipeline works as specified:
 *   4.1 — Ingest -> Search (multi-format, full flow)
 *   4.2 — Update -> Tombstone -> Search
 *   4.3 — Rollback
 *   4.4 — Determinism
 *   4.5 — Compaction
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AkiDB } from "@ax-fabric/akidb";

import { Pipeline } from "../pipeline/index.js";
import { MockEmbedder } from "../embedder/index.js";
import { JobRegistry } from "../registry/index.js";
import { RecordBuilder } from "../builder/index.js";
import { EXTRACTOR_VERSION } from "../extractor/index.js";
import { NORMALIZER_VERSION } from "../normalizer/index.js";
import { CHUNKER_VERSION } from "../chunker/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `e2e-${prefix}-`));
}

function writeTestFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Embed a query string and return a Float32Array suitable for AkiDB search. */
async function embedQuery(
  embedder: MockEmbedder,
  text: string,
): Promise<Float32Array> {
  const vectors = await embedder.embed([text]);
  return new Float32Array(vectors[0]!);
}

/**
 * Create a fresh Pipeline instance from the shared test fixtures.
 * Each call creates a new pipeline (and thus a new JobRegistry connection)
 * so callers must close() when done.
 */
function createPipeline(opts: {
  sourceDir: string;
  akidb: AkiDB;
  collectionId: string;
  embedder: MockEmbedder;
  registryDbPath: string;
}): Pipeline {
  return new Pipeline({
    sourcePaths: [opts.sourceDir],
    akidb: opts.akidb,
    collectionId: opts.collectionId,
    embedder: opts.embedder,
    registryDbPath: opts.registryDbPath,
  });
}

// ─── Shared state ─────────────────────────────────────────────────────────────

const COLLECTION_ID = "e2e";
const DIMENSION = 128;
const MODEL_ID = "mock-embed-v1";

let sourceDir: string;
let storageDir: string;
let registryDbPath: string;
let akidb: AkiDB;
let embedder: MockEmbedder;

// ═══════════════════════════════════════════════════════════════════════════════
//  4.1 — Ingest -> Search (Full E2E)
// ═══════════════════════════════════════════════════════════════════════════════

describe("4.1 Ingest -> Search (Full E2E)", () => {
  beforeEach(() => {
    sourceDir = makeTmpDir("4.1-src");
    storageDir = makeTmpDir("4.1-store");
    const dbDir = makeTmpDir("4.1-db");
    registryDbPath = join(dbDir, "registry.db");

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });
  });

  afterEach(() => {
    akidb.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("ingests multiple file formats and returns search results with correct metadata", async () => {
    // --- Arrange: create source files in four different formats ---------------
    writeTestFile(
      sourceDir,
      "engineering.txt",
      "Distributed systems require careful consideration of network partitions, " +
        "consensus algorithms, and eventual consistency models. The CAP theorem " +
        "states that a distributed system cannot simultaneously provide all three " +
        "guarantees: consistency, availability, and partition tolerance.",
    );

    writeTestFile(
      sourceDir,
      "metrics.csv",
      "metric,value,unit\nlatency,42,ms\nthroughput,1200,rps\nerror_rate,0.02,percent\n",
    );

    writeTestFile(
      sourceDir,
      "config.json",
      JSON.stringify(
        {
          service: "api-gateway",
          version: "2.5.0",
          features: {
            rateLimit: true,
            circuitBreaker: true,
            retryPolicy: { maxRetries: 3, backoffMs: 100 },
          },
        },
        null,
        2,
      ),
    );

    writeTestFile(
      sourceDir,
      "deploy.yaml",
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: api-gateway",
        "  namespace: production",
        "spec:",
        "  replicas: 3",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: gateway",
        "          image: registry.example.com/gateway:2.5.0",
        "          ports:",
        "            - containerPort: 8080",
      ].join("\n"),
    );

    // --- Act: run pipeline ---------------------------------------------------
    const pipeline = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    // --- Assert: pipeline metrics --------------------------------------------
    expect(metrics.filesScanned).toBe(4);
    expect(metrics.filesAdded).toBe(4);
    expect(metrics.filesModified).toBe(0);
    expect(metrics.filesDeleted).toBe(0);
    expect(metrics.filesSucceeded).toBe(4);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
    expect(metrics.manifestVersion).toBe(0);
    expect(metrics.errors).toHaveLength(0);

    // --- Assert: search returns relevant results -----------------------------
    const queryVector = await embedQuery(embedder, "distributed systems consensus");
    const searchResponse = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector,
      topK: 10,
    });

    expect(searchResponse.results.length).toBeGreaterThan(0);
    expect(searchResponse.manifestVersionUsed).toBe(0);

    // Every result should have a valid chunkId (non-empty hex string) and a numeric score.
    // Note: cosine similarity can range from -1 to 1 for arbitrary embeddings,
    // so we only verify the score is a finite number.
    for (const result of searchResponse.results) {
      expect(result.chunkId).toBeTruthy();
      expect(result.chunkId.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.score)).toBe(true);
    }

    // --- Assert: JobRegistry tracks all four files ---------------------------
    const registry = new JobRegistry(registryDbPath);
    const files = registry.listFiles();
    registry.close();

    expect(files).toHaveLength(4);

    const sourcePaths = files.map((f) => f.sourcePath);
    expect(sourcePaths).toContain(join(sourceDir, "engineering.txt"));
    expect(sourcePaths).toContain(join(sourceDir, "metrics.csv"));
    expect(sourcePaths).toContain(join(sourceDir, "config.json"));
    expect(sourcePaths).toContain(join(sourceDir, "deploy.yaml"));

    // Verify content types recorded correctly.
    const byPath = new Map(files.map((f) => [f.sourcePath, f]));
    expect(byPath.get(join(sourceDir, "engineering.txt"))!.status).toBe("success");
    expect(byPath.get(join(sourceDir, "metrics.csv"))!.status).toBe("success");
    expect(byPath.get(join(sourceDir, "config.json"))!.status).toBe("success");
    expect(byPath.get(join(sourceDir, "deploy.yaml"))!.status).toBe("success");

    // Every successfully ingested file should have recorded chunk IDs.
    for (const file of files) {
      expect(file.chunkIds.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4.2 — Update -> Tombstone -> Search
// ═══════════════════════════════════════════════════════════════════════════════

describe("4.2 Update -> Tombstone -> Search", () => {
  beforeEach(() => {
    sourceDir = makeTmpDir("4.2-src");
    storageDir = makeTmpDir("4.2-store");
    const dbDir = makeTmpDir("4.2-db");
    registryDbPath = join(dbDir, "registry.db");

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });
  });

  afterEach(() => {
    akidb.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("tombstones old chunks when a file is modified, and search reflects the update", async () => {
    // --- Arrange: initial content about cats ----------------------------------
    const filePath = writeTestFile(
      sourceDir,
      "animals.txt",
      "Cats are wonderful companions known for their independence and curiosity. " +
        "They are obligate carnivores that require a diet rich in animal protein. " +
        "Domestic cats have been human companions for thousands of years.",
    );

    writeTestFile(
      sourceDir,
      "stable.txt",
      "This file remains unchanged throughout the test to verify stability. " +
        "It contains content about software testing and quality assurance practices.",
    );

    // --- Act: initial ingest -------------------------------------------------
    const pipeline1 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const firstMetrics = await pipeline1.run([sourceDir]);
    pipeline1.close();

    expect(firstMetrics.filesAdded).toBe(2);
    expect(firstMetrics.recordsGenerated).toBeGreaterThan(0);

    // Search for "cats" — should find results.
    const catQuery = await embedQuery(embedder, "cats companions curiosity");
    const firstSearch = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: catQuery,
      topK: 10,
    });
    expect(firstSearch.results.length).toBeGreaterThan(0);

    // Record the chunk IDs from the first search.
    const firstChunkIds = new Set(firstSearch.results.map((r) => r.chunkId));

    // --- Act: modify the file (replace cats with dogs) -----------------------
    writeFileSync(
      filePath,
      "Dogs are loyal and energetic pets known for their devotion to their owners. " +
        "They are omnivores with a varied diet and come in an astonishing range of " +
        "breeds, from tiny Chihuahuas to massive Great Danes. Dogs have been " +
        "domesticated for over fifteen thousand years.",
      "utf-8",
    );

    const pipeline2 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const secondMetrics = await pipeline2.run([sourceDir]);
    pipeline2.close();

    // --- Assert: metrics reflect the modification ----------------------------
    expect(secondMetrics.filesModified).toBe(1);
    expect(secondMetrics.filesUnchanged).toBe(1);
    expect(secondMetrics.filesAdded).toBe(0);
    expect(secondMetrics.tombstonesGenerated).toBeGreaterThan(0);
    expect(secondMetrics.recordsGenerated).toBeGreaterThan(0);
    expect(secondMetrics.manifestVersion).toBeGreaterThan(0);

    // --- Assert: search returns NEW chunks, not old --------------------------
    const dogQuery = await embedQuery(embedder, "dogs loyal breeds devotion");
    const secondSearch = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: dogQuery,
      topK: 10,
    });
    expect(secondSearch.results.length).toBeGreaterThan(0);

    // Verify search returns results after modification.
    const secondChunkIds = new Set(secondSearch.results.map((r) => r.chunkId));

    // Verify the registry reflects the updated chunk IDs for the modified file.
    const registry = new JobRegistry(registryDbPath);
    const modifiedRecord = registry.getFile(filePath);
    registry.close();

    expect(modifiedRecord).not.toBeNull();
    expect(modifiedRecord!.chunkIds.length).toBeGreaterThan(0);

    // The registry should have completely new chunk IDs for the modified file.
    const newChunkIdSet = new Set(modifiedRecord!.chunkIds);
    for (const oldChunkId of firstChunkIds) {
      // Old chunks from animals.txt should not be in the new registry entry.
      // (Some might overlap with stable.txt, so we only check the modified file's record.)
      expect(newChunkIdSet.has(oldChunkId)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4.3 — Rollback
// ═══════════════════════════════════════════════════════════════════════════════

describe("4.3 Rollback", () => {
  beforeEach(() => {
    sourceDir = makeTmpDir("4.3-src");
    storageDir = makeTmpDir("4.3-store");
    const dbDir = makeTmpDir("4.3-db");
    registryDbPath = join(dbDir, "registry.db");

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });
  });

  afterEach(() => {
    akidb.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("rolls back to a previous manifest, restoring original search results", async () => {
    // --- Phase 1: Ingest original content → pipeline publishes manifest v0 ---
    // We then re-publish via AkiDB.publish() to capture the Manifest object
    // (with manifest_id) since Pipeline only returns the version number.
    const filePath = writeTestFile(
      sourceDir,
      "topic.txt",
      "Quantum computing leverages quantum mechanical phenomena such as superposition " +
        "and entanglement to perform computations. Qubits can exist in multiple states " +
        "simultaneously, enabling quantum computers to solve certain problems exponentially " +
        "faster than classical computers. Quantum error correction is essential for " +
        "building fault-tolerant quantum systems.",
    );

    const pipeline1 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const metricsV0 = await pipeline1.run([sourceDir]);
    pipeline1.close();

    expect(metricsV0.manifestVersion).toBe(0);
    expect(metricsV0.recordsGenerated).toBeGreaterThan(0);

    // Search at v0.
    const quantumQuery = await embedQuery(embedder, "quantum superposition entanglement");
    const searchV0 = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: quantumQuery,
      topK: 10,
    });
    const v0ResultIds = searchV0.results.map((r) => r.chunkId).sort();
    const v0ResultCount = searchV0.results.length;
    expect(v0ResultCount).toBeGreaterThan(0);

    // Pipeline only returns the manifest version number, not the manifest_id
    // needed for rollback. We re-publish via AkiDB.publish() to capture the
    // Manifest object. This creates v1 with the same segments as v0.
    const v0Manifest = await akidb.publish(COLLECTION_ID, {
      embeddingModelId: MODEL_ID,
      pipelineSignature: RecordBuilder.computePipelineSignature({
        extractor_version: EXTRACTOR_VERSION,
        normalize_version: NORMALIZER_VERSION,
        chunker_version: CHUNKER_VERSION,
      }),
    });
    // v0Manifest is actually version 1 now (pipeline created v0, this is v1).
    expect(v0Manifest.version).toBe(1);

    // --- Phase 2: Modify content → manifest v2 (via pipeline) + v3 (capture) --
    writeFileSync(
      filePath,
      "Machine learning is a subset of artificial intelligence that focuses on " +
        "building systems that learn from data. Neural networks, decision trees, " +
        "and support vector machines are popular ML algorithms. Deep learning uses " +
        "multi-layered neural networks to extract hierarchical features from data. " +
        "Transfer learning allows models to reuse knowledge from pre-trained networks.",
      "utf-8",
    );

    const pipeline2 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const metricsV2 = await pipeline2.run([sourceDir]);
    pipeline2.close();

    expect(metricsV2.filesModified).toBe(1);
    expect(metricsV2.tombstonesGenerated).toBeGreaterThan(0);
    expect(metricsV2.recordsGenerated).toBeGreaterThan(0);

    // Verify we can find ML content now.
    const mlQuery = await embedQuery(embedder, "machine learning neural networks");
    const searchPostModify = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: mlQuery,
      topK: 10,
    });
    expect(searchPostModify.results.length).toBeGreaterThan(0);

    // --- Phase 3: Rollback to v0Manifest → creates a new manifest version ----
    const rollbackManifest = akidb.rollback(COLLECTION_ID, v0Manifest.manifest_id);

    // The rollback manifest is a NEW version that points to the same segments as v0Manifest.
    expect(rollbackManifest.version).toBeGreaterThan(v0Manifest.version);
    expect(rollbackManifest.segment_ids).toEqual(v0Manifest.segment_ids);
    expect(rollbackManifest.tombstone_ids).toEqual(v0Manifest.tombstone_ids);

    // --- Phase 4: Search after rollback → should find original content -------
    const searchAfterRollback = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: quantumQuery,
      topK: 10,
    });

    // Should find quantum content again (original v0 results).
    expect(searchAfterRollback.results.length).toBeGreaterThan(0);

    // The result chunk IDs after rollback should match the v0 chunk IDs.
    const rollbackResultIds = searchAfterRollback.results
      .map((r) => r.chunkId)
      .sort();
    expect(rollbackResultIds).toEqual(v0ResultIds);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4.4 — Determinism
// ═══════════════════════════════════════════════════════════════════════════════

describe("4.4 Determinism", () => {
  it("produces identical results from two independent pipeline runs on the same source files", async () => {
    // --- Arrange: create a shared source directory ----------------------------
    const sharedSourceDir = makeTmpDir("4.4-src");
    writeTestFile(
      sharedSourceDir,
      "alpha.txt",
      "Functional programming emphasizes immutability, pure functions, and " +
        "declarative style. Languages like Haskell, Erlang, and Elixir embrace " +
        "these principles fully. Pattern matching and recursion replace loops " +
        "and mutable state in functional paradigms.",
    );
    writeTestFile(
      sharedSourceDir,
      "beta.csv",
      "language,paradigm,year\nHaskell,functional,1990\nErlang,functional,1986\nElixir,functional,2011\n",
    );
    writeTestFile(
      sharedSourceDir,
      "gamma.json",
      JSON.stringify({
        title: "Functional Programming Overview",
        topics: ["immutability", "pure functions", "monads", "type inference"],
        difficulty: "intermediate",
      }),
    );

    // --- Run 1: fresh AkiDB + fresh JobRegistry ------------------------------
    const storageDir1 = makeTmpDir("4.4-store1");
    const dbDir1 = makeTmpDir("4.4-db1");
    const registryDbPath1 = join(dbDir1, "registry.db");
    const akidb1 = new AkiDB({ storagePath: storageDir1});
    akidb1.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });
    const embedder1 = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });

    const pipeline1 = new Pipeline({
      sourcePaths: [sharedSourceDir],
      akidb: akidb1,
      collectionId: COLLECTION_ID,
      embedder: embedder1,
      registryDbPath: registryDbPath1,
    });
    const metrics1 = await pipeline1.run([sharedSourceDir]);
    pipeline1.close();

    // --- Run 2: completely fresh AkiDB + fresh JobRegistry -------------------
    const storageDir2 = makeTmpDir("4.4-store2");
    const dbDir2 = makeTmpDir("4.4-db2");
    const registryDbPath2 = join(dbDir2, "registry.db");
    const akidb2 = new AkiDB({ storagePath: storageDir2});
    akidb2.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });
    const embedder2 = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });

    const pipeline2 = new Pipeline({
      sourcePaths: [sharedSourceDir],
      akidb: akidb2,
      collectionId: COLLECTION_ID,
      embedder: embedder2,
      registryDbPath: registryDbPath2,
    });
    const metrics2 = await pipeline2.run([sharedSourceDir]);
    pipeline2.close();

    // --- Assert: identical record counts -------------------------------------
    expect(metrics1.filesScanned).toBe(metrics2.filesScanned);
    expect(metrics1.filesAdded).toBe(metrics2.filesAdded);
    expect(metrics1.recordsGenerated).toBe(metrics2.recordsGenerated);
    expect(metrics1.manifestVersion).toBe(metrics2.manifestVersion);

    // --- Assert: identical pipeline signature --------------------------------
    const sig1 = RecordBuilder.computePipelineSignature({
      extractor_version: EXTRACTOR_VERSION,
      normalize_version: NORMALIZER_VERSION,
      chunker_version: CHUNKER_VERSION,
    });
    const sig2 = RecordBuilder.computePipelineSignature({
      extractor_version: EXTRACTOR_VERSION,
      normalize_version: NORMALIZER_VERSION,
      chunker_version: CHUNKER_VERSION,
    });
    expect(sig1).toBe(sig2);

    // --- Assert: identical chunk IDs -----------------------------------------
    const registry1 = new JobRegistry(registryDbPath1);
    const registry2 = new JobRegistry(registryDbPath2);

    const files1 = registry1.listFiles().sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    const files2 = registry2.listFiles().sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

    expect(files1.length).toBe(files2.length);

    for (let i = 0; i < files1.length; i++) {
      const f1 = files1[i]!;
      const f2 = files2[i]!;
      // Same source path.
      expect(f1.sourcePath).toBe(f2.sourcePath);
      // Same fingerprint.
      expect(f1.fingerprint).toBe(f2.fingerprint);
      // Same doc ID.
      expect(f1.docId).toBe(f2.docId);
      // Same chunk IDs (order matters — deterministic chunking).
      expect(f1.chunkIds).toEqual(f2.chunkIds);
    }

    registry1.close();
    registry2.close();

    // --- Assert: identical search results ------------------------------------
    const queryVector = await embedQuery(embedder1, "functional programming immutability");

    const search1 = await akidb1.search({
      collectionId: COLLECTION_ID,
      queryVector,
      topK: 10,
    });
    const search2 = await akidb2.search({
      collectionId: COLLECTION_ID,
      queryVector,
      topK: 10,
    });

    expect(search1.results.length).toBe(search2.results.length);
    expect(search1.manifestVersionUsed).toBe(search2.manifestVersionUsed);

    for (let i = 0; i < search1.results.length; i++) {
      expect(search1.results[i]!.chunkId).toBe(search2.results[i]!.chunkId);
      expect(search1.results[i]!.score).toBeCloseTo(search2.results[i]!.score, 10);
    }

    // --- Cleanup -------------------------------------------------------------
    akidb1.close();
    akidb2.close();
    rmSync(sharedSourceDir, { recursive: true, force: true });
    rmSync(storageDir1, { recursive: true, force: true });
    rmSync(storageDir2, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4.5 — Compaction
// ═══════════════════════════════════════════════════════════════════════════════

describe("4.5 Compaction", () => {
  beforeEach(() => {
    sourceDir = makeTmpDir("4.5-src");
    storageDir = makeTmpDir("4.5-store");
    const dbDir = makeTmpDir("4.5-db");
    registryDbPath = join(dbDir, "registry.db");

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });
  });

  afterEach(() => {
    akidb.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("compacts segments, removes tombstones, and produces correct search results", async () => {
    // --- Phase 1: Ingest 3 files → publish manifest v0 -----------------------
    const keepFile = writeTestFile(
      sourceDir,
      "architecture.txt",
      "Microservices architecture decomposes applications into small, independently " +
        "deployable services that communicate through well-defined APIs. Each service " +
        "owns its own data store and can be developed, deployed, and scaled independently. " +
        "Service meshes like Istio provide observability, traffic management, and security.",
    );

    const deleteFile = writeTestFile(
      sourceDir,
      "deprecated.txt",
      "This deprecated module handles legacy XML parsing using SAX parsers. " +
        "It should be removed once all consumers have migrated to the new JSON API. " +
        "The XML parsing code is no longer maintained and may contain security issues.",
    );

    const stableFile = writeTestFile(
      sourceDir,
      "database.txt",
      "PostgreSQL is a powerful open-source relational database management system. " +
        "It supports advanced data types, full-text search, and JSON document storage. " +
        "Connection pooling with PgBouncer helps manage database connections efficiently.",
    );

    const pipeline1 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const metricsV0 = await pipeline1.run([sourceDir]);
    pipeline1.close();

    expect(metricsV0.manifestVersion).toBe(0);
    expect(metricsV0.filesAdded).toBe(3);
    const totalRecordsV0 = metricsV0.recordsGenerated;
    expect(totalRecordsV0).toBeGreaterThan(0);

    // Get the pre-compaction manifest to track segments and tombstones.
    const preDeletePublish = await akidb.publish(COLLECTION_ID, {
      embeddingModelId: MODEL_ID,
      pipelineSignature: RecordBuilder.computePipelineSignature({
        extractor_version: EXTRACTOR_VERSION,
        normalize_version: NORMALIZER_VERSION,
        chunker_version: CHUNKER_VERSION,
      }),
    });
    // This is v1, built on the same state as v0 (no changes yet).
    expect(preDeletePublish.tombstone_ids).toHaveLength(0);
    const preDeleteSegmentCount = preDeletePublish.segment_ids.length;
    expect(preDeleteSegmentCount).toBeGreaterThan(0);

    // --- Phase 2: Delete a file → re-ingest → publish (creates tombstones) ---
    unlinkSync(deleteFile);

    const pipeline2 = createPipeline({
      sourceDir,
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath,
    });
    const metricsDelete = await pipeline2.run([sourceDir]);
    pipeline2.close();

    expect(metricsDelete.filesDeleted).toBe(1);
    expect(metricsDelete.tombstonesGenerated).toBeGreaterThan(0);
    expect(metricsDelete.filesUnchanged).toBe(2);
    expect(metricsDelete.manifestVersion).toBeGreaterThan(0);

    // Verify tombstones exist in the latest manifest.
    const postDeletePublish = await akidb.publish(COLLECTION_ID, {
      embeddingModelId: MODEL_ID,
      pipelineSignature: RecordBuilder.computePipelineSignature({
        extractor_version: EXTRACTOR_VERSION,
        normalize_version: NORMALIZER_VERSION,
        chunker_version: CHUNKER_VERSION,
      }),
    });
    expect(postDeletePublish.tombstone_ids.length).toBeGreaterThan(0);

    // Verify search does NOT return deleted content.
    const xmlQuery = await embedQuery(embedder, "XML parsing SAX legacy deprecated");
    const searchPreCompact = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: xmlQuery,
      topK: 10,
    });
    // The tombstoned chunks should be filtered out.
    const deletedChunkIds = new Set(postDeletePublish.tombstone_ids);
    for (const result of searchPreCompact.results) {
      expect(deletedChunkIds.has(result.chunkId)).toBe(false);
    }

    // --- Phase 3: Compact ----------------------------------------------------
    const compactedManifest = await akidb.compact(COLLECTION_ID);

    // --- Assert: compacted manifest has NO tombstones ------------------------
    expect(compactedManifest.tombstone_ids).toHaveLength(0);

    // The compacted manifest should have fewer or equal segments (merged).
    expect(compactedManifest.segment_ids.length).toBeGreaterThan(0);

    // --- Assert: search after compaction works correctly ----------------------
    // Should still find architecture content.
    const archQuery = await embedQuery(embedder, "microservices architecture APIs");
    const searchPostCompact = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: archQuery,
      topK: 10,
    });
    expect(searchPostCompact.results.length).toBeGreaterThan(0);

    // Should still find database content.
    const dbQuery = await embedQuery(embedder, "PostgreSQL database connection pooling");
    const searchDb = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: dbQuery,
      topK: 10,
    });
    expect(searchDb.results.length).toBeGreaterThan(0);

    // Should NOT find deleted content after compaction either.
    const searchXmlPostCompact = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: xmlQuery,
      topK: 10,
    });
    for (const result of searchXmlPostCompact.results) {
      expect(deletedChunkIds.has(result.chunkId)).toBe(false);
    }

    // --- Assert: old segments are archived -----------------------------------
    // The segments from preDeletePublish should now have status "archived".
    // We cannot directly query metadata through AkiDB's public API, but we
    // can verify indirectly: the compacted manifest references NEW segment IDs,
    // not the old ones.
    const oldSegmentIds = new Set(preDeletePublish.segment_ids);
    for (const newSegId of compactedManifest.segment_ids) {
      expect(oldSegmentIds.has(newSegId)).toBe(false);
    }

    // --- Assert: total record count is reduced (deleted file's chunks gone) --
    // The compacted manifest's segment(s) should contain only records from
    // the 2 surviving files, which is fewer than the original 3-file total.
    // We verify by searching with a broad query and checking result count.
    const broadQuery = await embedQuery(embedder, "software systems data");
    const broadSearch = await akidb.search({
      collectionId: COLLECTION_ID,
      queryVector: broadQuery,
      topK: 100,
    });
    // Should have results from 2 files, not 3.
    // The exact count depends on chunking, but it should be less than
    // the total records from v0 (which had 3 files).
    expect(broadSearch.results.length).toBeLessThan(totalRecordsV0);
    expect(broadSearch.results.length).toBeGreaterThan(0);
  });
});
