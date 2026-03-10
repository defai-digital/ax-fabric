/**
 * Live PDF ingestion test — ingests gwu-deng-student-guidelines.pdf via
 * Cloudflare Qwen3 embeddings into AkiDB, then runs search queries.
 *
 * Skipped unless CLOUDFLARE_API_TOKEN env var is set.
 *
 * Run:
 *   CLOUDFLARE_API_TOKEN=<token> npx vitest run packages/fabric-ingest/src/e2e/ingest-pdf.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AkiDB } from "@ax-fabric/akidb";
import { CloudflareEmbedder } from "../embedder/cloudflare-embedder.js";
import { Pipeline } from "../pipeline/pipeline.js";
import type { PipelineMetrics } from "../pipeline/pipeline.js";

const ACCOUNT_ID = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
const MODEL_ID = "@cf/qwen/qwen3-embedding-0.6b";
const DIMENSION = 1024;
const HAS_TOKEN = !!process.env["CLOUDFLARE_API_TOKEN"];

// Resolve the PDF path relative to the repo root
const PDF_DIR = resolve(import.meta.dirname!, "../../../../data");

describe.skipIf(!HAS_TOKEN)("PDF Ingestion E2E — gwu-deng-student-guidelines.pdf", () => {
  let storageDir: string;
  let registryDir: string;
  let akidb: AkiDB;
  let embedder: CloudflareEmbedder;
  let pipeline: Pipeline;
  let metrics: PipelineMetrics;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "pdf-e2e-store-"));
    registryDir = mkdtempSync(join(tmpdir(), "pdf-e2e-reg-"));

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: "pdf-test",
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new CloudflareEmbedder({
      accountId: ACCOUNT_ID,
      modelId: MODEL_ID,
      dimension: DIMENSION,
      apiToken: process.env["CLOUDFLARE_API_TOKEN"],
    });

    pipeline = new Pipeline({
      sourcePaths: [PDF_DIR],
      akidb,
      collectionId: "pdf-test",
      embedder,
      registryDbPath: join(registryDir, "registry.db"),
    });

    // Ingest the PDF
    console.log(`\n[ingest] Source dir: ${PDF_DIR}`);
    metrics = await pipeline.run([PDF_DIR]);

    console.log(`[ingest] Files scanned:   ${metrics.filesScanned}`);
    console.log(`[ingest] Files added:     ${metrics.filesAdded}`);
    console.log(`[ingest] Files succeeded: ${metrics.filesSucceeded}`);
    console.log(`[ingest] Files failed:    ${metrics.filesFailed}`);
    console.log(`[ingest] Records (chunks): ${metrics.recordsGenerated}`);
    console.log(`[ingest] Manifest ver:    ${metrics.manifestVersion}`);
    console.log(`[ingest] Duration:        ${metrics.durationMs}ms`);

    if (metrics.errors.length > 0) {
      for (const err of metrics.errors) {
        console.error(`[ingest] ERROR: ${err.sourcePath}: ${err.message}`);
      }
    }
  }, 300_000); // 5 minute timeout for PDF extraction + embedding

  afterAll(() => {
    pipeline?.close();
    akidb?.close();
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  });

  async function search(query: string, topK = 5): Promise<{ chunkId: string; score: number }[]> {
    const vecs = await embedder.embed([query]);
    const result = await akidb.search({
      collectionId: "pdf-test",
      queryVector: new Float32Array(vecs[0]!),
      topK,
    });
    return result.results.map((r) => ({ chunkId: r.chunkId, score: r.score }));
  }

  it("successfully ingests the PDF with no errors", () => {
    expect(metrics.filesScanned).toBeGreaterThanOrEqual(1);
    expect(metrics.filesSucceeded).toBeGreaterThanOrEqual(1);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
    expect(metrics.manifestVersion).not.toBeNull();
    console.log(`  PDF produced ${metrics.recordsGenerated} chunks`);
  });

  it(
    "finds relevant results for 'student guidelines' query",
    async () => {
      const results = await search("student guidelines requirements");
      console.log(`  "student guidelines" → top score: ${results[0]?.score.toFixed(4)}, ${results.length} results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0.3);
    },
    30_000,
  );

  it(
    "finds relevant results for 'GWU DENG program' query",
    async () => {
      const results = await search("GWU DENG program data engineering");
      console.log(`  "GWU DENG program" → top score: ${results[0]?.score.toFixed(4)}, ${results.length} results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0.3);
    },
    30_000,
  );

  it(
    "finds relevant results for 'graduation requirements' query",
    async () => {
      const results = await search("graduation requirements credits courses");
      console.log(`  "graduation requirements" → top score: ${results[0]?.score.toFixed(4)}, ${results.length} results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0.3);
    },
    30_000,
  );

  it(
    "finds relevant results for 'academic policies' query",
    async () => {
      const results = await search("academic policies grading exams attendance");
      console.log(`  "academic policies" → top score: ${results[0]?.score.toFixed(4)}, ${results.length} results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0.3);
    },
    30_000,
  );

  it(
    "finds relevant results for 'advisor registration' query",
    async () => {
      const results = await search("advisor registration enrollment schedule");
      console.log(`  "advisor registration" → top score: ${results[0]?.score.toFixed(4)}, ${results.length} results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0.3);
    },
    30_000,
  );

  it(
    "different queries produce different top results (semantic discrimination)",
    async () => {
      const q1 = await search("graduation requirements credits");
      const q2 = await search("advisor faculty contact information");
      const q3 = await search("academic integrity plagiarism cheating");

      const tops = new Set([q1[0]!.chunkId, q2[0]!.chunkId, q3[0]!.chunkId]);
      console.log(`  3 queries → ${tops.size} distinct top chunks`);

      // At least 2 of 3 queries should hit different chunks
      expect(tops.size).toBeGreaterThanOrEqual(2);
    },
    90_000,
  );

  it(
    "idempotent re-run produces no new records",
    async () => {
      const secondRun = await pipeline.run([PDF_DIR]);
      console.log(`  Re-run: scanned=${secondRun.filesScanned}, unchanged=${secondRun.filesUnchanged}, new records=${secondRun.recordsGenerated}`);
      expect(secondRun.filesUnchanged).toBeGreaterThanOrEqual(1);
      expect(secondRun.recordsGenerated).toBe(0);
    },
    300_000,
  );
});
