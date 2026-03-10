/**
 * Live integration test — Cloudflare Workers AI Qwen3 Embedding + AkiDB + Pipeline.
 *
 * Skipped unless CLOUDFLARE_API_TOKEN env var is set.
 *
 * Run:  CLOUDFLARE_API_TOKEN=<token> pnpm test -- packages/fabric-ingest/src/e2e/live-cloudflare.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AkiDB } from "@ax-fabric/akidb";
import { CloudflareEmbedder } from "../embedder/cloudflare-embedder.js";
import { Pipeline } from "../pipeline/pipeline.js";

const ACCOUNT_ID = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
const MODEL_ID = "@cf/qwen/qwen3-embedding-0.6b";
const DIMENSION = 1024;
const HAS_TOKEN = !!process.env["CLOUDFLARE_API_TOKEN"];

describe.skipIf(!HAS_TOKEN)("Live Cloudflare Qwen3 Embedding E2E", () => {
  let sourceDir: string;
  let storageDir: string;
  let registryDir: string;
  let akidb: AkiDB;
  let embedder: CloudflareEmbedder;
  let pipeline: Pipeline;

  const docs = [
    {
      name: "typescript.txt",
      content:
        "TypeScript is a strongly typed programming language that builds on JavaScript. It adds optional static typing, classes, and interfaces. TypeScript compiles to plain JavaScript and runs in any browser or Node.js environment.",
    },
    {
      name: "rust.txt",
      content:
        "Rust is a systems programming language focused on safety, speed, and concurrency. It achieves memory safety without garbage collection through its ownership system and borrow checker.",
    },
    {
      name: "python.txt",
      content:
        "Python is a high-level interpreted programming language known for its readability and simplicity. It is widely used in data science, machine learning, artificial intelligence, and web development.",
    },
    {
      name: "cooking.txt",
      content:
        "The art of French cooking involves mastering fundamental techniques like sautéing, braising, and making sauces. A classic béchamel sauce starts with a roux of butter and flour, then slowly incorporating warm milk.",
    },
    {
      name: "astronomy.txt",
      content:
        "The James Webb Space Telescope launched in December 2021 and observes in infrared wavelengths. It can peer through cosmic dust clouds and detect light from galaxies formed shortly after the Big Bang.",
    },
  ];

  beforeAll(async () => {
    sourceDir = mkdtempSync(join(tmpdir(), "live-cf-src-"));
    storageDir = mkdtempSync(join(tmpdir(), "live-cf-store-"));
    registryDir = mkdtempSync(join(tmpdir(), "live-cf-reg-"));

    for (const doc of docs) {
      writeFileSync(join(sourceDir, doc.name), doc.content, "utf-8");
    }

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: "cf-test",
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
      sourcePaths: [sourceDir],
      akidb,
      collectionId: "cf-test",
      embedder,
      registryDbPath: join(registryDir, "registry.db"),
    });

    // Ingest all documents
    const metrics = await pipeline.run([sourceDir]);
    console.log(
      `[setup] Ingested ${metrics.filesSucceeded}/${metrics.filesScanned} files, ${metrics.recordsGenerated} records`,
    );
    expect(metrics.filesSucceeded).toBe(docs.length);
    expect(metrics.filesFailed).toBe(0);
  }, 120_000);

  afterAll(() => {
    pipeline?.close();
    akidb?.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  });

  async function searchScore(query: string): Promise<{ chunkId: string; score: number }[]> {
    const vecs = await embedder.embed([query]);
    const result = await akidb.search({
      collectionId: "cf-test",
      queryVector: new Float32Array(vecs[0]!),
      topK: 5,
    });
    return result.results.map((r) => ({ chunkId: r.chunkId, score: r.score }));
  }

  it(
    "ingests all 5 documents and produces records",
    async () => {
      // Already verified in beforeAll, but confirm search returns results
      const results = await searchScore("programming language");
      expect(results.length).toBeGreaterThan(0);
      console.log("  Generic query returned", results.length, "results");
    },
    30_000,
  );

  it(
    "returns high cosine similarity (> 0.5) for a strongly matching query",
    async () => {
      const results = await searchScore(
        "Rust ownership borrow checker memory safety systems programming",
      );
      console.log("  Rust query - top score:", results[0]?.score.toFixed(4));
      expect(results[0]!.score).toBeGreaterThan(0.5);
    },
    30_000,
  );

  it(
    "returns lower scores for unrelated queries",
    async () => {
      const results = await searchScore(
        "quantum physics string theory dark matter",
      );
      console.log("  Unrelated query - top score:", results[0]?.score.toFixed(4));
      // Even the best match should be relatively weak for an unrelated topic
      expect(results[0]!.score).toBeLessThan(0.6);
    },
    30_000,
  );

  it(
    "different queries produce different top results (semantic discrimination)",
    async () => {
      const rustResults = await searchScore(
        "memory safety ownership borrow checker systems programming",
      );
      const cookingResults = await searchScore(
        "béchamel sauce roux butter flour French cooking techniques",
      );

      // These should return different top chunks
      const rustTop = rustResults[0]!.chunkId;
      const cookingTop = cookingResults[0]!.chunkId;

      console.log("  Rust top chunkId:", rustTop.slice(0, 16) + "...");
      console.log("  Cooking top chunkId:", cookingTop.slice(0, 16) + "...");

      expect(rustTop).not.toBe(cookingTop);
    },
    60_000,
  );

  it(
    "all five topic queries produce distinct top results",
    async () => {
      const queries = [
        "Rust ownership borrow checker memory safety",
        "TypeScript static typing compiles to JavaScript",
        "Python data science machine learning AI",
        "French cooking béchamel sauce roux butter",
        "James Webb Space Telescope infrared galaxies Big Bang",
      ];

      const topChunks = new Set<string>();
      for (const q of queries) {
        const results = await searchScore(q);
        console.log(
          `  "${q.slice(0, 40)}..." → score=${results[0]?.score.toFixed(4)}`,
        );
        expect(results[0]!.score).toBeGreaterThan(0.3);
        topChunks.add(results[0]!.chunkId);
      }

      // Each query should match a different chunk (all 5 topics are distinct)
      console.log(`  Unique top chunks: ${topChunks.size}/${queries.length}`);
      expect(topChunks.size).toBe(queries.length);
    },
    120_000,
  );

  it(
    "embedding dimension matches configured 1024",
    async () => {
      const vecs = await embedder.embed(["test dimension check"]);
      expect(vecs[0]!.length).toBe(DIMENSION);
    },
    30_000,
  );
});
