/**
 * Unit tests for the Daemon class (watch.ts).
 *
 * Tests use a real AkiDB + MockEmbedder with a minimal YAML config written
 * to a temp directory so the Daemon can be exercised without any network I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";

import { AkiDB } from "@ax-fabric/akidb";
import { MockEmbedder } from "../embedder/mock-embedder.js";
import { Daemon } from "./watch.js";
import type { CycleResult } from "./watch.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION_ID = "watch-test";
const DIMENSION = 16;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeMinimalConfig(configPath: string, dataRoot: string, maxStorageGb = 50): void {
  const cfg = {
    fabric: { data_root: dataRoot, max_storage_gb: maxStorageGb },
    akidb: {
      root: join(dataRoot, "akidb"),
      collection: COLLECTION_ID,
      metric: "cosine",
      dimension: DIMENSION,
    },
    ingest: {
      sources: [],
      scan: { mode: "incremental", fingerprint: "sha256" },
      chunking: { chunk_size: 512, overlap: 0.15, strategy: "auto" },
    },
    embedder: {
      type: "local",
      model_id: "mock-embed-v1",
      dimension: DIMENSION,
      batch_size: 64,
    },
  };
  writeFileSync(configPath, yamlStringify(cfg));
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

describe("Daemon", () => {
  let storageDir: string;
  let dataRoot: string;
  let configPath: string;
  let akidb: AkiDB;
  let embedder: MockEmbedder;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "daemon-test-akidb-"));
    dataRoot = mkdtempSync(join(tmpdir(), "daemon-test-data-"));
    configPath = join(dataRoot, "config.yaml");
    writeMinimalConfig(configPath, dataRoot);

    akidb = new AkiDB({ storagePath: storageDir });
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: "mock-embed-v1",
    });

    embedder = new MockEmbedder({ modelId: "mock-embed-v1", dimension: DIMENSION });
  });

  afterEach(() => {
    try { akidb.close(); } catch { /* best-effort */ }
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  // ── Lock acquisition ─────────────────────────────────────────────────────

  it("returns stopped=false and cycles=0 when lock is already held by the current process", async () => {
    // Pre-create the lock file with the current PID so acquireLock treats it as held.
    const lockPath = join(dataRoot, "daemon.lock");
    writeFileSync(lockPath, String(process.pid));

    const daemon = new Daemon({ configPath, akidb, embedder, collectionId: COLLECTION_ID });
    const result = await daemon.run();

    expect(result.cycles).toBe(0);
    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/PID|lock/i);
  });

  // ── Single cycle ─────────────────────────────────────────────────────────

  it("returns cycles=1, stopped=true with once=true and empty sources", async () => {
    const daemon = new Daemon({ configPath, akidb, embedder, collectionId: COLLECTION_ID });
    const result = await daemon.run({ once: true });

    expect(result.cycles).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.reason).toBe("Single cycle completed");
  });

  // ── Lifecycle callbacks ──────────────────────────────────────────────────

  it("calls onCycleStart once per cycle", async () => {
    const starts: number[] = [];
    const daemon = new Daemon({
      configPath,
      akidb,
      embedder,
      collectionId: COLLECTION_ID,
      onCycleStart: () => { starts.push(1); },
    });

    await daemon.run({ once: true });
    expect(starts).toHaveLength(1);
  });

  it("calls onCycleEnd with the CycleResult after each successful cycle", async () => {
    let endResult: CycleResult | undefined;
    const daemon = new Daemon({
      configPath,
      akidb,
      embedder,
      collectionId: COLLECTION_ID,
      onCycleEnd: (r) => { endResult = r; },
    });

    await daemon.run({ once: true });

    expect(endResult).toBeDefined();
    expect(endResult!.skipped).toBe(false);
    expect(endResult!.pipeline).toBeDefined();
    expect(endResult!.budget).toBeDefined();
    expect(endResult!.compactionDecision).toBeDefined();
  });

  it("calls onCycleError when the cycle throws and still increments cycle count", async () => {
    // Force an error by using a mock akidb that throws immediately on getStorageSizeBytes().
    const throwingAkidb = {
      getStorageSizeBytes: () => { throw new Error("AkiDB unavailable"); },
    } as unknown as AkiDB;

    const errors: unknown[] = [];
    const daemon = new Daemon({
      configPath,
      akidb: throwingAkidb,
      embedder,
      collectionId: COLLECTION_ID,
      onCycleError: (err) => { errors.push(err); },
    });

    const result = await daemon.run({ once: true });
    expect(errors).toHaveLength(1);
    expect(result.cycles).toBe(1);
  });

  // ── stop() ───────────────────────────────────────────────────────────────

  it("stop() can be called without throwing", () => {
    const daemon = new Daemon({ configPath, akidb, embedder, collectionId: COLLECTION_ID });
    expect(() => daemon.stop()).not.toThrow();
  });

  // ── runCycle() skips ingestion when over budget ──────────────────────────

  it("runCycle() skips ingestion and marks skipped=true when over storage budget", async () => {
    // Publish a manifest first so compact() has something to work with.
    const vec = new Array<number>(DIMENSION).fill(0);
    vec[0] = 1;
    await akidb.upsertBatch(COLLECTION_ID, [
      {
        chunk_id: "c1",
        doc_id: "d1",
        doc_version: "v1",
        chunk_hash: "h1",
        pipeline_signature: "p1",
        embedding_model_id: "mock-embed-v1",
        vector: vec,
        metadata: {
          source_uri: "/tmp/daemon-test.txt",
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          created_at: new Date().toISOString(),
        },
      },
    ]);
    await akidb.flushWrites(COLLECTION_ID);
    await akidb.publish(COLLECTION_ID, {
      embeddingModelId: "mock-embed-v1",
      pipelineSignature: "p1",
    });

    // Now set max_storage_gb to an absurdly small value so any storage triggers "skip".
    const tinyConfigPath = join(dataRoot, "tiny-config.yaml");
    writeMinimalConfig(tinyConfigPath, dataRoot, 0.000001); // ~1 KB limit

    const daemon = new Daemon({
      configPath: tinyConfigPath,
      akidb,
      embedder,
      collectionId: COLLECTION_ID,
    });

    const result = await daemon.runCycle();
    expect(result.skipped).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.pipeline).toBeNull();
    expect(result.compactionDecision.reason).toBe("budget_pressure");
  });

  // ── runCycle() happy path ────────────────────────────────────────────────

  it("runCycle() returns a full CycleResult with pipeline metrics for empty sources", async () => {
    const daemon = new Daemon({ configPath, akidb, embedder, collectionId: COLLECTION_ID });

    const result = await daemon.runCycle();

    expect(result.skipped).toBe(false);
    expect(result.budget.action).toBe("normal");
    expect(result.pipeline).not.toBeNull();
    expect(result.pipeline!.filesScanned).toBe(0);
    expect(result.pipeline!.filesSucceeded).toBe(0);
    expect(result.compactionDecision).toBeDefined();
  });
});
