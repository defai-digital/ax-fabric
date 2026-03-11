import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { z } from "zod";
import { AkiDB } from "@ax-fabric/akidb";

import { JobRegistry } from "../registry/index.js";
import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";
import { createEmbedderFromConfig } from "./create-embedder.js";
import { SemanticStore } from "../semantic/index.js";

const EvalCaseSchema = z.object({
  query: z.string().min(1),
  expected_sources: z.array(z.string()).default([]),
  top_k: z.number().int().positive().optional(),
});

const EvalFixtureSchema = z.object({
  cases: z.array(EvalCaseSchema).min(1),
});

type EvalCase = z.infer<typeof EvalCaseSchema>;

interface ModeSummary {
  mode: "vector" | "keyword" | "hybrid";
  cases: number;
  hitAtK: number;
  missAtK: number;
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function buildChunkIndex(registry: JobRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of registry.listFiles()) {
    for (const chunkId of file.chunkIds) {
      map.set(chunkId, file.sourcePath);
    }
  }
  return map;
}

function normalizeSource(p: string): string {
  return p.trim();
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval <fixturePath>")
    .description("Evaluate retrieval quality across vector, keyword, and hybrid modes")
    .option("--json", "Print machine-readable evaluation output")
    .option("-k, --top-k <number>", "Override top-k for all cases", "5")
    .option("--compare", "Compare raw vs semantic collection retrieval quality")
    .action(async (fixturePath: string, opts: { json?: boolean; topK: string; compare?: boolean }) => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const topKOverride = Number.parseInt(opts.topK, 10);
      if (!Number.isInteger(topKOverride) || topKOverride <= 0) {
        console.error("Error: --top-k must be a positive integer");
        process.exit(1);
      }

      const fixtureRaw = readFileSync(fixturePath, "utf-8");
      const parsedFixture = EvalFixtureSchema.parse(JSON.parse(fixtureRaw));

      const dataRoot = resolveDataRoot(config);
      const registryDbPath = join(dataRoot, "registry.db");
      const registry = new JobRegistry(registryDbPath);
      const filesByChunkId = buildChunkIndex(registry);

      const embedder = createEmbedderFromConfig(config);
      const db = new AkiDB({ storagePath: expandTilde(config.akidb.root) });

      const rawCollectionId = config.akidb.collection;
      const semanticCollectionId = `${rawCollectionId}${config.retrieval.semantic_collection_suffix}`;

      const rawModeSummaries = new Map<ModeSummary["mode"], ModeSummary>([
        ["vector", { mode: "vector", cases: 0, hitAtK: 0, missAtK: 0 }],
        ["keyword", { mode: "keyword", cases: 0, hitAtK: 0, missAtK: 0 }],
        ["hybrid", { mode: "hybrid", cases: 0, hitAtK: 0, missAtK: 0 }],
      ]);

      const caseResults: Array<{
        query: string;
        expectedSources: string[];
        topK: number;
        modes: Array<{
          mode: ModeSummary["mode"];
          hitAtK: boolean;
          matchedSources: string[];
        }>;
      }> = [];

      try {
        for (const testCase of parsedFixture.cases) {
          const caseResult = await evaluateCase({
            testCase,
            topKOverride,
            db,
            embedder,
            collectionId: rawCollectionId,
            filesByChunkId,
          });

          for (const modeResult of caseResult.modes) {
            const summary = rawModeSummaries.get(modeResult.mode)!;
            summary.cases += 1;
            if (modeResult.hitAtK) {
              summary.hitAtK += 1;
            } else {
              summary.missAtK += 1;
            }
          }
          caseResults.push(caseResult);
        }

        if (opts.compare === true) {
          // Build semantic chunk id map from SemanticStore
          const semanticDbPath = join(dataRoot, "semantic.db");
          let semanticFilesByChunkId: Map<string, string> = new Map();
          let semanticAvailable = false;

          if (existsSync(semanticDbPath)) {
            let semanticStore: SemanticStore | null = null;
            try {
              semanticStore = new SemanticStore(semanticDbPath);
              const lookups = semanticStore.listPublishedUnitLookups(semanticCollectionId);
              if (lookups.length > 0) {
                for (const lookup of lookups) {
                  semanticFilesByChunkId.set(lookup.chunkId, lookup.sourcePath);
                }
                semanticAvailable = true;
              }
            } catch {
              // SemanticStore not available
            } finally {
              semanticStore?.close();
            }
          }

          if (!semanticAvailable) {
            console.warn(`Warning: semantic collection "${semanticCollectionId}" not available — skipping semantic eval`);
          } else {
            const semanticModeSummaries = new Map<ModeSummary["mode"], ModeSummary>([
              ["vector", { mode: "vector", cases: 0, hitAtK: 0, missAtK: 0 }],
              ["keyword", { mode: "keyword", cases: 0, hitAtK: 0, missAtK: 0 }],
              ["hybrid", { mode: "hybrid", cases: 0, hitAtK: 0, missAtK: 0 }],
            ]);

            for (const testCase of parsedFixture.cases) {
              let semResult;
              try {
                semResult = await evaluateCase({
                  testCase,
                  topKOverride,
                  db,
                  embedder,
                  collectionId: semanticCollectionId,
                  filesByChunkId: semanticFilesByChunkId,
                });
              } catch {
                console.warn(`Warning: could not evaluate against semantic collection "${semanticCollectionId}" — skipping`);
                break;
              }

              for (const modeResult of semResult.modes) {
                const summary = semanticModeSummaries.get(modeResult.mode)!;
                summary.cases += 1;
                if (modeResult.hitAtK) {
                  summary.hitAtK += 1;
                } else {
                  summary.missAtK += 1;
                }
              }
            }

            const rawTotals = Array.from(rawModeSummaries.values()).map((entry) => ({
              ...entry,
              hitRate: entry.cases > 0 ? entry.hitAtK / entry.cases : 0,
            }));
            const semanticTotals = Array.from(semanticModeSummaries.values()).map((entry) => ({
              ...entry,
              hitRate: entry.cases > 0 ? entry.hitAtK / entry.cases : 0,
            }));

            if (opts.json) {
              const delta = rawTotals.map((rawEntry) => {
                const semEntry = semanticTotals.find((s) => s.mode === rawEntry.mode)!;
                return {
                  mode: rawEntry.mode,
                  deltaHit: semEntry.hitAtK - rawEntry.hitAtK,
                  deltaRate: semEntry.hitRate - rawEntry.hitRate,
                };
              });

              console.log(JSON.stringify({
                fixturePath,
                raw: {
                  collectionId: rawCollectionId,
                  totals: rawTotals,
                  cases: caseResults,
                },
                semantic: {
                  collectionId: semanticCollectionId,
                  totals: semanticTotals,
                },
                delta,
              }, null, 2));
              return;
            }

            console.log(`\nEvaluation fixture: ${fixturePath}\n`);
            console.log(`Raw collection: ${rawCollectionId}`);
            for (const entry of rawTotals) {
              console.log(
                `  ${entry.mode.padEnd(7)} cases=${String(entry.cases).padStart(2, " ")} `
                + `hit@k=${String(entry.hitAtK).padStart(2, " ")} `
                + `miss=${String(entry.missAtK).padStart(2, " ")} `
                + `rate=${entry.hitRate.toFixed(2)}`,
              );
            }
            console.log();
            console.log(`Semantic collection: ${semanticCollectionId}`);
            for (const entry of semanticTotals) {
              console.log(
                `  ${entry.mode.padEnd(7)} cases=${String(entry.cases).padStart(2, " ")} `
                + `hit@k=${String(entry.hitAtK).padStart(2, " ")} `
                + `miss=${String(entry.missAtK).padStart(2, " ")} `
                + `rate=${entry.hitRate.toFixed(2)}`,
              );
            }
            console.log();
            console.log("Comparison (semantic − raw):");
            for (const rawEntry of rawTotals) {
              const semEntry = semanticTotals.find((s) => s.mode === rawEntry.mode)!;
              const deltaHit = semEntry.hitAtK - rawEntry.hitAtK;
              const deltaRate = semEntry.hitRate - rawEntry.hitRate;
              const deltaHitStr = deltaHit >= 0 ? `+${String(deltaHit)}` : String(deltaHit);
              const deltaRateStr = deltaRate >= 0 ? `+${deltaRate.toFixed(2)}` : deltaRate.toFixed(2);
              console.log(
                `  ${rawEntry.mode.padEnd(7)} Δhit=${deltaHitStr}  Δrate=${deltaRateStr}`,
              );
            }
            console.log();
            return;
          }
        }
      } finally {
        registry.close();
        db.close();
        await embedder.close?.();
      }

      const summary = {
        fixturePath,
        collectionId: rawCollectionId,
        totals: Array.from(rawModeSummaries.values()).map((entry) => ({
          ...entry,
          hitRate: entry.cases > 0 ? entry.hitAtK / entry.cases : 0,
        })),
        cases: caseResults,
      };

      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`\nEvaluation fixture: ${fixturePath}`);
      console.log(`Collection:        ${rawCollectionId}\n`);
      for (const entry of summary.totals) {
        console.log(
          `${entry.mode.padEnd(7)} cases=${String(entry.cases).padStart(2, " ")} `
          + `hit@k=${String(entry.hitAtK).padStart(2, " ")} `
          + `miss=${String(entry.missAtK).padStart(2, " ")} `
          + `rate=${entry.hitRate.toFixed(2)}`,
        );
      }
      console.log();
    });
}

async function evaluateCase(args: {
  testCase: EvalCase;
  topKOverride: number;
  db: AkiDB;
  embedder: ReturnType<typeof createEmbedderFromConfig>;
  collectionId: string;
  filesByChunkId: Map<string, string>;
}): Promise<{
  query: string;
  expectedSources: string[];
  topK: number;
  modes: Array<{
    mode: ModeSummary["mode"];
    hitAtK: boolean;
    matchedSources: string[];
  }>;
}> {
  const { testCase, topKOverride, db, embedder, collectionId, filesByChunkId } = args;
  const expectedSources = testCase.expected_sources.map(normalizeSource);
  const topK = testCase.top_k ?? topKOverride;

  const vector = await embedder.embed([testCase.query]);
  const queryVector = new Float32Array(vector[0] ?? []);

  const modes: ModeSummary["mode"][] = ["vector", "keyword", "hybrid"];
  const modeResults: Array<{
    mode: ModeSummary["mode"];
    hitAtK: boolean;
    matchedSources: string[];
  }> = [];

  for (const mode of modes) {
    const result = await db.search({
      collectionId,
      topK,
      mode,
      queryVector: mode === "keyword" ? new Float32Array(0) : queryVector,
      queryText: mode === "vector" ? undefined : testCase.query,
    });

    const matchedSources = result.results
      .map((entry) => filesByChunkId.get(entry.chunkId))
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeSource);

    const hitAtK = expectedSources.length === 0
      ? matchedSources.length > 0
      : expectedSources.some((expected) => matchedSources.includes(expected));

    modeResults.push({
      mode,
      hitAtK,
      matchedSources,
    });
  }

  return {
    query: testCase.query,
    expectedSources,
    topK,
    modes: modeResults,
  };
}
