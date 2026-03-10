/**
 * Ingest pipeline benchmark fixture.
 *
 * Validates that the EmbeddingScheduler produces measurably better batch
 * fill ratios than per-file embedding would on small-file workloads, and
 * that stage timing fields are always populated in PipelineMetrics.
 *
 * Three scenarios:
 *   A — many small files  (30 files × ~5 chunks each → needs cross-file batching)
 *   B — few large files   (3 files × ~50 chunks each → batches fill on own)
 *   C — mixed workload    (20 small + 3 large)
 *
 * These tests use MockEmbedder (synchronous, no network) and run in standard
 * vitest; they are NOT gated on CLOUDFLARE_API_TOKEN.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AkiDB } from "@ax-fabric/akidb";
import { MockEmbedder } from "../embedder/index.js";
import { Pipeline } from "../pipeline/index.js";
import type { PipelineMetrics } from "../pipeline/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "benchmark-"));
}

/**
 * Write a plain-text file that produces approximately `targetChunks` chunks.
 * Each chunk is ~200 characters; the default chunkSize is 2800 chars.
 */
function writeChunkyFile(dir: string, name: string, targetChunks: number): string {
  // ~200 chars per paragraph, 14 paragraphs per chunk at 2800-char chunks
  const paragraphsPerChunk = 14;
  const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim.\n\n";
  const content = paragraph.repeat(paragraphsPerChunk * targetChunks);
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function createPipeline(
  sourceDir: string,
  storageDir: string,
  registryDbPath: string,
): Pipeline {
  const db = new AkiDB({ storagePath: storageDir });
  db.createCollection({
    collectionId: "bench-col",
    dimension: 64,
    metric: "cosine",
    embeddingModelId: "mock-bench-v1",
  });

  const embedder = new MockEmbedder({ modelId: "mock-bench-v1", dimension: 64 });

  return new Pipeline({
    sourcePaths: [sourceDir],
    akidb: db,
    collectionId: "bench-col",
    embedder,
    registryDbPath,
    // Use a small batchSize so cross-file batching is observable even with few chunks.
    schedulerOptions: { batchSize: 10, maxConcurrency: 4, initialConcurrency: 4, maxQueueAgeMs: 50 },
  });
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

interface ScenarioResult {
  metrics: PipelineMetrics;
  storageDir: string;
  sourceDir: string;
}

async function runScenario(
  files: Array<{ name: string; targetChunks: number }>,
): Promise<ScenarioResult> {
  const sourceDir = makeTmpDir();
  const storageDir = makeTmpDir();
  const dbDir = makeTmpDir();
  const registryDbPath = join(dbDir, "registry.db");

  for (const { name, targetChunks } of files) {
    writeChunkyFile(sourceDir, name, targetChunks);
  }

  const pipeline = createPipeline(sourceDir, storageDir, registryDbPath);
  let metrics: PipelineMetrics;
  try {
    metrics = await pipeline.run();
  } finally {
    pipeline.close();
  }

  return { metrics, storageDir, sourceDir };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Benchmark — Scenario A: many small files", () => {
  let result: ScenarioResult;

  beforeEach(async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: `small-${String(i).padStart(2, "0")}.txt`,
      targetChunks: 2, // ~2 chunks each → 40 total
    }));
    result = await runScenario(files);
  }, 30_000);

  afterEach(() => {
    rmSync(result.storageDir, { recursive: true, force: true });
    rmSync(result.sourceDir, { recursive: true, force: true });
  });

  it("processes all files successfully", () => {
    expect(result.metrics.filesFailed).toBe(0);
    expect(result.metrics.filesSucceeded).toBeGreaterThan(0);
  });

  it("populates all stage timing fields", () => {
    expect(result.metrics.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.processDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.publishDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.durationMs).toBeGreaterThan(0);
  });

  it("populates embedStats", () => {
    const s = result.metrics.embedStats;
    expect(s.batchesFired).toBeGreaterThan(0);
    expect(s.vectorsEmbedded).toBeGreaterThan(0);
    expect(s.avgFillRatio).toBeGreaterThan(0);
    expect(s.avgFillRatio).toBeLessThanOrEqual(1);
  });

  it("achieves higher fill ratio than per-file batching would on small files", () => {
    // With 20 files × ~2 chunks, per-file batching would give ~2/10 = 20% fill.
    // The scheduler should batch across files → higher fill ratio.
    // We assert > 30% (conservative) to avoid flakiness from chunk count variance.
    expect(result.metrics.embedStats.avgFillRatio).toBeGreaterThan(0.3);
  });

  it("vectorsPerSec is non-negative and finite", () => {
    expect(result.metrics.embedStats.vectorsPerSec).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.metrics.embedStats.vectorsPerSec)).toBe(true);
  });
});

describe("Benchmark — Scenario B: few large files", () => {
  let result: ScenarioResult;

  beforeEach(async () => {
    const files = [
      { name: "large-a.txt", targetChunks: 15 },
      { name: "large-b.txt", targetChunks: 15 },
      { name: "large-c.txt", targetChunks: 15 },
    ];
    result = await runScenario(files);
  }, 30_000);

  afterEach(() => {
    rmSync(result.storageDir, { recursive: true, force: true });
    rmSync(result.sourceDir, { recursive: true, force: true });
  });

  it("processes all files successfully", () => {
    expect(result.metrics.filesFailed).toBe(0);
    expect(result.metrics.filesSucceeded).toBe(3);
  });

  it("populates all stage timing fields", () => {
    expect(result.metrics.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.processDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.publishDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("embedStats reflects actual vectors embedded", () => {
    const s = result.metrics.embedStats;
    expect(s.vectorsEmbedded).toBeGreaterThan(0);
    expect(s.batchesFired).toBeGreaterThan(0);
    expect(s.errorsEncountered).toBe(0);
  });
});

describe("Benchmark — Scenario C: mixed workload", () => {
  let result: ScenarioResult;

  beforeEach(async () => {
    const small = Array.from({ length: 15 }, (_, i) => ({
      name: `mix-small-${String(i)}.txt`,
      targetChunks: 2,
    }));
    const large = [
      { name: "mix-large-a.txt", targetChunks: 12 },
      { name: "mix-large-b.txt", targetChunks: 12 },
    ];
    result = await runScenario([...small, ...large]);
  }, 30_000);

  afterEach(() => {
    rmSync(result.storageDir, { recursive: true, force: true });
    rmSync(result.sourceDir, { recursive: true, force: true });
  });

  it("processes all files without errors", () => {
    expect(result.metrics.filesFailed).toBe(0);
    expect(result.metrics.filesSucceeded).toBe(17);
  });

  it("total duration is scan + process + publish (roughly)", () => {
    const staged =
      result.metrics.scanDurationMs +
      result.metrics.processDurationMs +
      result.metrics.publishDurationMs;
    // Total may be slightly larger due to overhead, but should be in the same ballpark.
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(staged);
  });

  it("per-run embedStats are scoped to this run only (not cumulative)", () => {
    // vectorsEmbedded should match recordsGenerated (1 vector per record)
    expect(result.metrics.embedStats.vectorsEmbedded).toBe(result.metrics.recordsGenerated);
  });
});
