import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";
import type { SemanticBundle } from "@ax-fabric/contracts";

import type { FabricConfig } from "./config-loader.js";
import { MockEmbedder } from "../embedder/index.js";
import { Pipeline } from "../pipeline/index.js";
import { JobRegistry } from "../registry/index.js";
import { executeSearch } from "../retrieval/index.js";
import {
  SemanticReviewEngine,
  SemanticStore,
  buildSemanticRecords,
  ensureSemanticCollection,
  semanticChunkIds,
  semanticPipelineSignature,
} from "../semantic/index.js";

type SearchMode = "vector" | "keyword" | "hybrid";

interface LatencySummary {
  runs: number;
  warmup: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  averageMs: number;
}

export function registerBenchmarkCommand(program: Command): void {
  const benchmark = program
    .command("benchmark")
    .description("Run local benchmark harnesses for search, semantic publish, and eval");

  benchmark
    .command("search")
    .description("Benchmark retrieval latency on a synthetic corpus")
    .option("--docs <number>", "Number of synthetic documents", "250")
    .option("--runs <number>", "Measured search runs", "20")
    .option("--warmup <number>", "Warmup runs before measurement", "5")
    .option("--top-k <number>", "Top-k for search", "10")
    .option("--mode <mode>", "Search mode: vector | keyword | hybrid", "hybrid")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: {
      docs: string;
      runs: string;
      warmup: string;
      topK: string;
      mode: SearchMode;
      json?: boolean;
    }) => {
      const result = await runSearchBenchmark({
        docs: parsePositiveInteger(opts.docs, "--docs"),
        runs: parsePositiveInteger(opts.runs, "--runs"),
        warmup: parsePositiveInteger(opts.warmup, "--warmup"),
        topK: parsePositiveInteger(opts.topK, "--top-k"),
        mode: parseSearchMode(opts.mode),
      });

      printResult(result, opts.json === true);
    });

  benchmark
    .command("semantic-publish")
    .description("Benchmark semantic publish or replace latency on a synthetic bundle")
    .option("--sections <number>", "Number of semantic sections to generate", "40")
    .option("--replace", "Benchmark replace instead of first publish")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { sections: string; replace?: boolean; json?: boolean }) => {
      const result = await runSemanticPublishBenchmark({
        sections: parsePositiveInteger(opts.sections, "--sections"),
        replace: opts.replace === true,
      });

      printResult(result, opts.json === true);
    });

  benchmark
    .command("eval")
    .description("Benchmark eval-style retrieval runtime on a synthetic corpus")
    .option("--docs <number>", "Number of synthetic documents", "250")
    .option("--cases <number>", "Number of benchmark cases", "25")
    .option("--top-k <number>", "Top-k per case", "5")
    .option("--compare-semantic", "Also benchmark semantic compare passes")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: {
      docs: string;
      cases: string;
      topK: string;
      compareSemantic?: boolean;
      json?: boolean;
    }) => {
      const result = await runEvalBenchmark({
        docs: parsePositiveInteger(opts.docs, "--docs"),
        cases: parsePositiveInteger(opts.cases, "--cases"),
        topK: parsePositiveInteger(opts.topK, "--top-k"),
        compareSemantic: opts.compareSemantic === true,
      });

      printResult(result, opts.json === true);
    });
}

async function runSearchBenchmark(args: {
  docs: number;
  runs: number;
  warmup: number;
  topK: number;
  mode: SearchMode;
}) {
  return withBenchmarkWorkspace("search", async (ctx) => {
    createSyntheticCorpus(ctx.docsDir, args.docs);
    const pipeline = createPipeline(ctx, [ctx.docsDir]);

    try {
      await pipeline.run([ctx.docsDir]);
    } finally {
      pipeline.close();
    }

    const query = "token rotation policy benchmark";
    const queryVector = await embedQueryVector(ctx.embedder, query, args.mode);

    for (let i = 0; i < args.warmup; i += 1) {
      await executeSearch({
        db: ctx.db,
        dataRoot: ctx.dataRoot,
        rawCollectionId: ctx.config.akidb.collection,
        semanticCollectionId: `${ctx.config.akidb.collection}${ctx.config.retrieval.semantic_collection_suffix}`,
        requestedLayer: "raw",
        defaultLayer: "raw",
        queryVector,
        topK: args.topK,
        mode: args.mode,
        queryText: args.mode === "vector" ? undefined : query,
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < args.runs; i += 1) {
      const start = performance.now();
      await executeSearch({
        db: ctx.db,
        dataRoot: ctx.dataRoot,
        rawCollectionId: ctx.config.akidb.collection,
        semanticCollectionId: `${ctx.config.akidb.collection}${ctx.config.retrieval.semantic_collection_suffix}`,
        requestedLayer: "raw",
        defaultLayer: "raw",
        queryVector,
        topK: args.topK,
        mode: args.mode,
        queryText: args.mode === "vector" ? undefined : query,
      });
      samples.push(performance.now() - start);
    }

    return {
      benchmark: "search",
      corpusDocs: args.docs,
      query,
      mode: args.mode,
      topK: args.topK,
      latency: summarizeLatencies(samples, args.warmup),
    };
  });
}

async function runSemanticPublishBenchmark(args: {
  sections: number;
  replace: boolean;
}) {
  return withBenchmarkWorkspace("semantic-publish", async (ctx) => {
    const semanticCollectionId = `${ctx.config.akidb.collection}${ctx.config.retrieval.semantic_collection_suffix}`;
    const sourcePath = join(ctx.docsDir, "semantic-benchmark.md");
    writeFileSync(sourcePath, buildSemanticMarkdown(args.sections), "utf8");

    const reviewEngine = new SemanticReviewEngine();
    const firstBundle = approveBundle(await reviewEngine.createBundle(sourcePath, {
      strategy: "markdown",
      chunkSize: 768,
      overlapRatio: 0.1,
      lowQualityThreshold: 0.4,
    }));

    const store = new SemanticStore(join(ctx.dataRoot, "semantic.db"));
    try {
      if (args.replace) {
        store.upsertBundle(firstBundle);
        await publishBundle({
          bundle: firstBundle,
          store,
          ctx,
          collectionId: semanticCollectionId,
          replaceExisting: false,
        });

        writeFileSync(sourcePath, buildSemanticMarkdown(args.sections + 5), "utf8");
      }

      const bundle = approveBundle(await reviewEngine.createBundle(sourcePath, {
        strategy: "markdown",
        chunkSize: 768,
        overlapRatio: 0.1,
        lowQualityThreshold: 0.4,
      }));
      store.upsertBundle(bundle);

      const start = performance.now();
      const manifest = await publishBundle({
        bundle,
        store,
        ctx,
        collectionId: semanticCollectionId,
        replaceExisting: args.replace,
      });
      const elapsedMs = performance.now() - start;

      return {
        benchmark: "semantic-publish",
        sections: args.sections,
        replace: args.replace,
        units: bundle.units.length,
        manifestVersion: manifest.version,
        latencyMs: roundMs(elapsedMs),
      };
    } finally {
      store.close();
    }
  });
}

async function runEvalBenchmark(args: {
  docs: number;
  cases: number;
  topK: number;
  compareSemantic: boolean;
}) {
  return withBenchmarkWorkspace("eval", async (ctx) => {
    createSyntheticCorpus(ctx.docsDir, args.docs);
    const pipeline = createPipeline(ctx, [ctx.docsDir]);
    try {
      await pipeline.run([ctx.docsDir]);
    } finally {
      pipeline.close();
    }

    const semanticCollectionId = `${ctx.config.akidb.collection}${ctx.config.retrieval.semantic_collection_suffix}`;
    let semanticAvailable = false;
    if (args.compareSemantic) {
      semanticAvailable = await publishSemanticCorpus(ctx, semanticCollectionId, Math.min(args.cases, args.docs));
    }

    const registry = new JobRegistry(join(ctx.dataRoot, "registry.db"));
    try {
      const files = registry.listFiles();
      const chunkSources = registry.getChunkSources(files.flatMap((file) => file.chunkIds));
      const filesByChunkId = new Map<string, string>();
      for (const [chunkId, record] of chunkSources) {
        filesByChunkId.set(chunkId, record.sourcePath);
      }

      const evalCases = createEvalCases(ctx.docsDir, Math.min(args.cases, args.docs));
      const rawStart = performance.now();
      const rawSummary = await runEvalPass({
        db: ctx.db,
        embedder: ctx.embedder,
        collectionId: ctx.config.akidb.collection,
        filesByChunkId,
        cases: evalCases,
        topK: args.topK,
      });
      const rawElapsed = performance.now() - rawStart;

      let semanticSummary: EvalPassSummary | null = null;
      let semanticElapsed: number | null = null;
      if (semanticAvailable) {
        const store = new SemanticStore(join(ctx.dataRoot, "semantic.db"));
        try {
          const semanticFilesByChunkId = new Map<string, string>();
          for (const lookup of store.listPublishedUnitLookups(semanticCollectionId)) {
            semanticFilesByChunkId.set(lookup.chunkId, lookup.sourcePath);
          }

          const start = performance.now();
          semanticSummary = await runEvalPass({
            db: ctx.db,
            embedder: ctx.embedder,
            collectionId: semanticCollectionId,
            filesByChunkId: semanticFilesByChunkId,
            cases: evalCases,
            topK: args.topK,
          });
          semanticElapsed = performance.now() - start;
        } finally {
          store.close();
        }
      }

      const raw = {
        latencyMs: roundMs(rawElapsed),
        summary: rawSummary,
      };
      const semantic = semanticSummary && semanticElapsed !== null
        ? {
          latencyMs: roundMs(semanticElapsed),
          summary: semanticSummary,
        }
        : null;

      return {
        benchmark: "eval",
        corpusDocs: args.docs,
        cases: evalCases.length,
        topK: args.topK,
        compareSemantic: semanticAvailable,
        raw,
        semantic,
        passes: {
          raw,
          ...(semantic ? { compare: semantic, semantic } : {}),
        },
      };
    } finally {
      registry.close();
    }
  });
}

async function withBenchmarkWorkspace<T>(name: string, fn: (ctx: BenchmarkContext) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `ax-fabric-bench-${name}-`));
  const docsDir = join(root, "docs");
  const dataRoot = join(root, "data");
  const akidbRoot = join(dataRoot, "akidb");
  const registryDbPath = join(dataRoot, "registry.db");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(akidbRoot, { recursive: true });

  const config = createBenchmarkConfig(dataRoot, akidbRoot);
  const db = new AkiDB({ storagePath: akidbRoot });
  db.createCollection({
    collectionId: config.akidb.collection,
    dimension: config.akidb.dimension,
    metric: config.akidb.metric,
    embeddingModelId: config.embedder.model_id,
  });
  const embedder = new MockEmbedder({
    modelId: config.embedder.model_id,
    dimension: config.embedder.dimension,
  });

  try {
    return await fn({ root, docsDir, dataRoot, akidbRoot, registryDbPath, config, db, embedder });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function createPipeline(ctx: BenchmarkContext, sourcePaths: string[]): Pipeline {
  return new Pipeline({
    sourcePaths,
    akidb: ctx.db,
    collectionId: ctx.config.akidb.collection,
    embedder: ctx.embedder,
    registryDbPath: ctx.registryDbPath,
    chunkerOptions: {
      chunkSize: 768,
      overlapRatio: 0.1,
      strategy: "markdown",
    },
  });
}

function createBenchmarkConfig(dataRoot: string, akidbRoot: string): FabricConfig {
  return {
    fabric: {
      data_root: dataRoot,
      max_storage_gb: 10,
    },
    akidb: {
      root: akidbRoot,
      collection: "bench-col",
      metric: "cosine",
      dimension: 128,
    },
    retrieval: {
      default_layer: "raw",
      semantic_collection_suffix: "-semantic",
    },
    ingest: {
      sources: [],
      scan: { mode: "incremental", fingerprint: "sha256" },
      chunking: { chunk_size: 768, overlap: 0.1, strategy: "markdown" },
    },
    embedder: {
      type: "local",
      model_id: "mock-embed-v1",
      dimension: 128,
      batch_size: 64,
    },
  };
}

function createSyntheticCorpus(dir: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const topic = i % 5;
    const body = [
      `# Benchmark Document ${String(i)}`,
      "",
      `This benchmark document covers token rotation policy topic-${String(topic)} and operational guidance.`,
      `Authentication token expiry, service credentials, and rotation windows are discussed in document ${String(i)}.`,
      `Operators should review token rotation policy benchmark guidance before deployment to production topic-${String(topic)} systems.`,
      "",
      `## Notes`,
      `This section adds repeated searchable context for query routing and retrieval benchmarking.`,
    ].join("\n");
    writeFileSync(join(dir, `doc-${String(i).padStart(4, "0")}.md`), body, "utf8");
  }
}

function buildSemanticMarkdown(sectionCount: number): string {
  const sections: string[] = ["# Semantic Publish Benchmark", ""];
  for (let i = 0; i < sectionCount; i += 1) {
    sections.push(`## Section ${String(i + 1)}`);
    sections.push(`This section documents token rotation policy and approval workflow guidance for benchmark unit ${String(i + 1)}.`);
    sections.push(`Reviewers should validate semantic provenance, duplicate handling, and publication correctness for section ${String(i + 1)}.`);
    sections.push("");
  }
  return sections.join("\n");
}

function createEvalCases(dir: string, count: number): Array<{ query: string; expectedSource: string }> {
  return Array.from({ length: count }, (_, index) => ({
    query: `token rotation policy topic-${String(index % 5)}`,
    expectedSource: join(dir, `doc-${String(index).padStart(4, "0")}.md`),
  }));
}

async function publishSemanticCorpus(
  ctx: BenchmarkContext,
  collectionId: string,
  docCount: number,
): Promise<boolean> {
  const store = new SemanticStore(join(ctx.dataRoot, "semantic.db"));
  const reviewEngine = new SemanticReviewEngine();
  try {
    for (let i = 0; i < docCount; i += 1) {
      const filePath = join(ctx.docsDir, `doc-${String(i).padStart(4, "0")}.md`);
      const bundle = approveBundle(await reviewEngine.createBundle(filePath, {
        strategy: "markdown",
        chunkSize: 768,
        overlapRatio: 0.1,
        lowQualityThreshold: 0.4,
      }));
      store.upsertBundle(bundle);
      await publishBundle({
        bundle,
        store,
        ctx,
        collectionId,
        replaceExisting: false,
      });
    }
    return true;
  } finally {
    store.close();
  }
}

async function publishBundle(args: {
  bundle: SemanticBundle;
  store: SemanticStore;
  ctx: BenchmarkContext;
  collectionId: string;
  replaceExisting: boolean;
}) {
  const existingPublication = args.store.findPublishedBundleForDoc(args.bundle.doc_id, args.collectionId);
  if (existingPublication && existingPublication.bundleId !== args.bundle.bundle_id) {
    if (!args.replaceExisting) {
      throw new Error(`Active publication already exists for doc_id "${args.bundle.doc_id}"`);
    }
    const existingBundle = args.store.getBundle(existingPublication.bundleId);
    if (existingBundle) {
      const oldChunkIds = semanticChunkIds(existingBundle);
      if (oldChunkIds.length > 0) {
        args.ctx.db.deleteChunks(args.collectionId, oldChunkIds, "manual_revoke");
      }
    }
  }

  ensureSemanticCollection(args.ctx.db, args.ctx.config, args.collectionId);
  const records = await buildSemanticRecords(args.bundle, args.ctx.config, args.ctx.embedder);
  await args.ctx.db.upsertBatch(args.collectionId, records);
  const manifest = await args.ctx.db.publish(args.collectionId, {
    embeddingModelId: args.ctx.config.embedder.model_id,
    pipelineSignature: semanticPipelineSignature(args.bundle),
  });

  args.store.markPublished(args.bundle.bundle_id, {
    collectionId: args.collectionId,
    manifestVersion: manifest.version,
    publishedAt: new Date().toISOString(),
  });
  if (existingPublication && existingPublication.bundleId !== args.bundle.bundle_id) {
    args.store.clearPublished(existingPublication.bundleId);
  }
  return manifest;
}

async function runEvalPass(args: {
  db: AkiDB;
  embedder: MockEmbedder;
  collectionId: string;
  filesByChunkId: Map<string, string>;
  cases: Array<{ query: string; expectedSource: string }>;
  topK: number;
}): Promise<EvalPassSummary> {
  const modes: SearchMode[] = ["vector", "keyword", "hybrid"];
  const totals = new Map<SearchMode, { cases: number; hits: number }>(
    modes.map((mode) => [mode, { cases: 0, hits: 0 }]),
  );

  for (const testCase of args.cases) {
    const vectors = await args.embedder.embed([testCase.query]);
    const queryVector = new Float32Array(vectors[0] ?? []);

    for (const mode of modes) {
      const result = await args.db.search({
        collectionId: args.collectionId,
        topK: args.topK,
        mode,
        queryVector: mode === "keyword" ? new Float32Array(0) : queryVector,
        queryText: mode === "vector" ? undefined : testCase.query,
      });
      const matched = result.results
        .map((entry) => args.filesByChunkId.get(entry.chunkId))
        .filter((entry): entry is string => typeof entry === "string");

      const total = totals.get(mode)!;
      total.cases += 1;
      if (matched.includes(testCase.expectedSource)) {
        total.hits += 1;
      }
    }
  }

  return {
    vector: toEvalSummaryEntry(totals.get("vector")!),
    keyword: toEvalSummaryEntry(totals.get("keyword")!),
    hybrid: toEvalSummaryEntry(totals.get("hybrid")!),
  };
}

function approveBundle(bundle: SemanticBundle): SemanticBundle {
  const engine = new SemanticReviewEngine();
  return engine.approveBundle(bundle, {
    reviewer: "benchmark",
    minQualityScore: 0.4,
    duplicatePolicy: "warn",
  });
}

async function embedQueryVector(embedder: MockEmbedder, query: string, mode: SearchMode): Promise<Float32Array> {
  if (mode === "keyword") {
    return new Float32Array(0);
  }
  const vectors = await embedder.embed([query]);
  return new Float32Array(vectors[0] ?? []);
}

function summarizeLatencies(samples: number[], warmup: number): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    runs: samples.length,
    warmup,
    minMs: roundMs(sorted[0] ?? 0),
    medianMs: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    maxMs: roundMs(sorted[sorted.length - 1] ?? 0),
    averageMs: roundMs(sorted.length > 0 ? total / sorted.length : 0),
  };
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1));
  return sorted[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function printResult(result: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function parsePositiveInteger(raw: string, flagName: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return value;
}

function parseSearchMode(raw: string): SearchMode {
  if (raw === "vector" || raw === "keyword" || raw === "hybrid") {
    return raw;
  }
  throw new Error("--mode must be one of: vector, keyword, hybrid");
}

interface BenchmarkContext {
  root: string;
  docsDir: string;
  dataRoot: string;
  akidbRoot: string;
  registryDbPath: string;
  config: FabricConfig;
  db: AkiDB;
  embedder: MockEmbedder;
}

interface EvalPassSummary {
  vector: { cases: number; hitAtK: number; hitRate: number };
  keyword: { cases: number; hitAtK: number; hitRate: number };
  hybrid: { cases: number; hitAtK: number; hitRate: number };
}

function toEvalSummaryEntry(total: { cases: number; hits: number }) {
  return {
    cases: total.cases,
    hitAtK: total.hits,
    hitRate: total.cases > 0 ? total.hits / total.cases : 0,
  };
}
