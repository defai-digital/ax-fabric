/**
 * PDF Ingestion Speed Test
 *
 * Ingests data/gwu-deng-student-guidelines.pdf using MockEmbedder (no API token
 * required), measures wall-clock time per pipeline stage, and logs a speed report.
 *
 * Run:
 *   npx vitest run packages/fabric-ingest/src/e2e/pdf-speed.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { AkiDB } from "@ax-fabric/akidb";
import { Pipeline } from "../pipeline/pipeline.js";
import { MockEmbedder } from "../embedder/mock-embedder.js";
import type { PipelineMetrics } from "../pipeline/pipeline.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PDF_DIR = resolve(import.meta.dirname!, "../../../../data");
const PDF_PATH = join(PDF_DIR, "gwu-deng-student-guidelines.pdf");
const COLLECTION_ID = "pdf-speed";
const DIMENSION = 128;
const MODEL_ID = "mock-embed-v1";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

// ─── Test ────────────────────────────────────────────────────────────────────

describe("PDF Ingestion Speed Test", () => {
  let storageDir: string;
  let registryDir: string;
  let akidb: AkiDB;
  let metrics: PipelineMetrics;
  let setupMs: number;
  let ingestMs: number;
  let searchMs: number;
  let reingestMs: number;

  afterAll(() => {
    akidb?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    if (registryDir) rmSync(registryDir, { recursive: true, force: true });
  });

  it("ingests the PDF, searches, and re-ingests (idempotent)", async () => {
    // ── 1. Setup ──────────────────────────────────────────────────────────
    const t0 = performance.now();

    storageDir = mkdtempSync(join(tmpdir(), "pdf-speed-store-"));
    registryDir = mkdtempSync(join(tmpdir(), "pdf-speed-reg-"));

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    const embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });

    setupMs = performance.now() - t0;

    // ── 2. First Ingestion ────────────────────────────────────────────────
    const t1 = performance.now();

    const pipeline = new Pipeline({
      sourcePaths: [PDF_DIR],
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath: join(registryDir, "registry.db"),
    });

    metrics = await pipeline.run([PDF_DIR]);
    ingestMs = performance.now() - t1;

    // Verify successful ingestion
    expect(metrics.filesScanned).toBeGreaterThanOrEqual(1);
    expect(metrics.filesSucceeded).toBeGreaterThanOrEqual(1);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
    expect(metrics.errors).toHaveLength(0);

    // ── 3. Search ─────────────────────────────────────────────────────────
    const queries = [
      "student guidelines requirements",
      "GWU DENG program data engineering",
      "graduation requirements credits",
      "academic policies grading",
      "advisor registration enrollment",
    ];

    const searchLatencies: number[] = [];

    for (const query of queries) {
      const vecs = await embedder.embed([query]);
      const ts = performance.now();
      const result = await akidb.search({
        collectionId: COLLECTION_ID,
        queryVector: new Float32Array(vecs[0]!),
        topK: 5,
      });
      searchLatencies.push(performance.now() - ts);
      expect(result.results.length).toBeGreaterThan(0);
    }

    searchMs = searchLatencies.reduce((a, b) => a + b, 0);
    const searchP50 = [...searchLatencies].sort((a, b) => a - b)[
      Math.floor(searchLatencies.length * 0.5)
    ]!;
    const searchP95 = [...searchLatencies].sort((a, b) => a - b)[
      Math.ceil(searchLatencies.length * 0.95) - 1
    ]!;

    // ── 4. Idempotent Re-ingestion ────────────────────────────────────────
    const t3 = performance.now();
    const reMetrics = await pipeline.run([PDF_DIR]);
    reingestMs = performance.now() - t3;

    expect(reMetrics.filesUnchanged).toBeGreaterThanOrEqual(1);
    expect(reMetrics.recordsGenerated).toBe(0);

    pipeline.close();

    // ── 5. Speed Report ───────────────────────────────────────────────────
    const pdfSize = statSync(PDF_PATH).size;
    const chunksPerSec =
      metrics.recordsGenerated / (ingestMs / 1000);
    const mbPerSec = pdfSize / (1024 * 1024) / (ingestMs / 1000);

    const report = [
      "",
      "╔══════════════════════════════════════════════════════════════╗",
      "║              PDF Ingestion Speed Report                     ║",
      "╠══════════════════════════════════════════════════════════════╣",
      `║  File: gwu-deng-student-guidelines.pdf                      ║`,
      `║  Size: ${formatBytes(pdfSize).padEnd(52)}║`,
      "╠══════════════════════════════════════════════════════════════╣",
      `║  Setup (AkiDB + collection):  ${formatMs(setupMs).padEnd(30)}║`,
      `║  Ingestion (extract→embed→store):  ${formatMs(ingestMs).padEnd(25)}║`,
      `║    ├─ Pipeline.durationMs:  ${formatMs(metrics.durationMs).padEnd(32)}║`,
      `║    ├─ Files scanned:   ${String(metrics.filesScanned).padEnd(37)}║`,
      `║    ├─ Files succeeded:  ${String(metrics.filesSucceeded).padEnd(36)}║`,
      `║    ├─ Chunks generated: ${String(metrics.recordsGenerated).padEnd(36)}║`,
      `║    └─ Manifest version: ${String(metrics.manifestVersion).padEnd(35)}║`,
      `║  Search (${String(queries.length)} queries):  ${formatMs(searchMs).padEnd(36)}║`,
      `║    ├─ P50 latency:  ${formatMs(searchP50).padEnd(39)}║`,
      `║    └─ P95 latency:  ${formatMs(searchP95).padEnd(39)}║`,
      `║  Re-ingestion (idempotent skip):  ${formatMs(reingestMs).padEnd(26)}║`,
      "╠══════════════════════════════════════════════════════════════╣",
      `║  Throughput:  ${chunksPerSec.toFixed(1)} chunks/sec`.padEnd(63) + "║",
      `║  Throughput:  ${mbPerSec.toFixed(3)} MB/sec (raw PDF)`.padEnd(63) + "║",
      "╚══════════════════════════════════════════════════════════════╝",
      "",
    ];

    console.log(report.join("\n"));
  }, 120_000);
});
