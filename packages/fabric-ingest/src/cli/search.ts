/**
 * `ax-fabric search "<query>"` — search for documents using vector similarity.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";
import type { ExplainInfo } from "@ax-fabric/akidb";

import { JobRegistry } from "../registry/index.js";
import { SemanticStore } from "../semantic/index.js";

import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";
import { createEmbedderFromConfig } from "./create-embedder.js";
import type { LlmProvider } from "@ax-fabric/contracts";
import { createLlmFromConfig } from "./create-llm.js";
import { MemoryStore } from "../memory/index.js";

/** Expand a leading `~` to the current user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search for documents with vector, keyword, or hybrid retrieval")
    .option("-k, --top-k <number>", "Number of results to return", "10")
    .option("--mode <mode>", "Search mode: vector | keyword | hybrid", "vector")
    .option("--explain", "Include per-result scoring breakdown and chunk previews")
    .option("--json", "Print machine-readable JSON output for evaluation workflows")
    .option("--session <id>", "Session ID for assembling stored memory context")
    .option("--workflow <id>", "Workflow ID for narrowing stored memory context")
    .option("--answer", "Generate an answer from retrieved chunks (requires LLM config)")
    .option("--semantic", "Search the <collection>-semantic AkiDB collection instead of raw chunks")
    .option("--fuse", "Client-side RRF fusion across raw and semantic collections")
    .action(async (query: string, opts: {
      topK: string;
      mode?: string;
      explain?: boolean;
      json?: boolean;
      session?: string;
      workflow?: string;
      answer?: boolean;
      semantic?: boolean;
      fuse?: boolean;
    }) => {
      try {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const dataRoot = resolveDataRoot(config);

      const topK = parseInt(opts.topK, 10);
      if (isNaN(topK) || topK <= 0) {
        console.error("Error: --top-k must be a positive integer");
        process.exit(1);
      }

      const mode = opts.mode ?? "vector";
      if (mode !== "vector" && mode !== "keyword" && mode !== "hybrid") {
        console.error("Error: --mode must be one of: vector, keyword, hybrid");
        process.exit(1);
      }

      // Create embedder and AkiDB — both need cleanup in finally
      const embedder = createEmbedderFromConfig(config);
      let llm: LlmProvider | null = null;
      const akidbRoot = expandTilde(config.akidb.root);
      const db = new AkiDB({ storagePath: akidbRoot });

      // When --answer is requested, enable explain to get chunk previews for RAG
      const needExplain = opts.answer === true || opts.explain === true;

      // Determine which collection(s) to query
      const rawCollectionId = config.akidb.collection;
      const semanticCollectionId = `${rawCollectionId}-semantic`;
      const resultMetadataByChunkId = loadSearchMetadata(dataRoot);

      try {
        let queryVector = new Float32Array(0);
        if (mode === "vector" || mode === "hybrid") {
          const vectors = await embedder.embed([query]);
          const vec0 = vectors[0];
          if (!vec0 || vec0.length === 0) {
            throw new Error("Embedder returned no vector for query");
          }
          queryVector = new Float32Array(vec0);
        }

        // Determine active collection for single-collection modes
        const activeCollectionId = opts.semantic === true ? semanticCollectionId : rawCollectionId;

        type RenderedResult = {
          chunkId: string;
          score: number;
          sourcePath: string | null;
          contentType: string | null;
          explain: ExplainInfo | null | undefined;
          collection?: string;
        };

        let renderedResults: RenderedResult[] = [];
        let manifestVersionUsed: number | undefined;

        if (opts.fuse === true) {
          // Client-side RRF fusion across raw and semantic collections
          const rawResult = await db.search({
            collectionId: rawCollectionId,
            queryVector,
            topK,
            mode,
            queryText: mode === "keyword" || mode === "hybrid" ? query : undefined,
            explain: needExplain,
          });

          let semanticResults: typeof rawResult.results = [];
          try {
            const semResult = await db.search({
              collectionId: semanticCollectionId,
              queryVector,
              topK,
              mode,
              queryText: mode === "keyword" || mode === "hybrid" ? query : undefined,
              explain: needExplain,
            });
            semanticResults = semResult.results;
          } catch {
            console.warn(`Warning: semantic collection "${semanticCollectionId}" not found — falling back to raw-only results`);
          }

          manifestVersionUsed = rawResult.manifestVersionUsed;

          // RRF fusion: score = 1/(60 + rank) per collection, sum scores, deduplicate by underlying provenance
          type ScoredEntry = {
            chunkId: string;
            rrfScore: number;
            collection: string;
            originalResult: typeof rawResult.results[number];
            dedupeKey: string;
          };
          const byDedupeKey = new Map<string, ScoredEntry>();

          const applyRrf = (results: typeof rawResult.results, collection: string): void => {
            results.forEach((result, idx) => {
              const rank = idx + 1;
              const rrfContrib = 1 / (60 + rank);
              const dedupeKey = resultMetadataByChunkId.get(result.chunkId)?.dedupeKey ?? result.chunkId;
              const existing = byDedupeKey.get(dedupeKey);
              if (existing) {
                existing.rrfScore += rrfContrib;
                if (existing.collection !== collection) {
                  existing.collection = "raw+semantic";
                }
              } else {
                byDedupeKey.set(dedupeKey, {
                  chunkId: result.chunkId,
                  rrfScore: rrfContrib,
                  collection,
                  originalResult: result,
                  dedupeKey,
                });
              }
            });
          };

          applyRrf(rawResult.results, "raw");
          applyRrf(semanticResults, "semantic");

          const fused = Array.from(byDedupeKey.values())
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, topK);

          renderedResults = fused.map((entry) => {
            const meta = resultMetadataByChunkId.get(entry.chunkId);
            return {
              chunkId: entry.chunkId,
              score: entry.rrfScore,
              sourcePath: meta?.sourcePath ?? null,
              contentType: meta?.contentType ?? null,
              explain: entry.originalResult.explain ?? null,
              collection: entry.collection,
            } as RenderedResult;
          });

        } else {
          const searchResult = await db.search({
            collectionId: activeCollectionId,
            queryVector,
            topK,
            mode,
            queryText: mode === "keyword" || mode === "hybrid" ? query : undefined,
            explain: needExplain,
          });

          manifestVersionUsed = searchResult.manifestVersionUsed;

          renderedResults = searchResult.results.map((result) => {
            const meta = resultMetadataByChunkId.get(result.chunkId);
            return {
              chunkId: result.chunkId,
              score: result.score,
              sourcePath: meta?.sourcePath ?? null,
              contentType: meta?.contentType ?? null,
              explain: result.explain ?? null,
            } as RenderedResult;
          });
        }

        if (renderedResults.length === 0) {
          console.log("No results found.");
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify({
            query,
            mode,
            topK,
            collection: opts.fuse === true ? "fused" : activeCollectionId,
            manifestVersion: manifestVersionUsed,
            results: renderedResults,
          }, null, 2));
        } else {
          console.log(`\nSearch results for: "${query}"\n`);
          console.log(`  Mode:             ${mode}`);
          if (opts.semantic === true) {
            console.log(`  Collection:       ${semanticCollectionId}`);
          } else if (opts.fuse === true) {
            console.log(`  Collection:       fused (${rawCollectionId} + ${semanticCollectionId})`);
          }
          console.log(`  Manifest version: ${String(manifestVersionUsed)}`);
          console.log(`  Results:          ${String(renderedResults.length)}\n`);

          for (let i = 0; i < renderedResults.length; i++) {
            const result = renderedResults[i]!;
            const rank = String(i + 1).padStart(2, " ");
            console.log(`  ${rank}. chunk_id: ${result.chunkId}`);
            console.log(`      score:    ${result.score.toFixed(6)}`);
            if (opts.fuse === true && result.collection) {
              console.log(`      collection: ${result.collection}`);
            }
            if (result.sourcePath) {
              console.log(`      source:   ${result.sourcePath}`);
            }
            if (result.contentType) {
              console.log(`      type:     ${result.contentType}`);
            }
            if (result.explain) {
              console.log("      explain:");
              if (result.explain.vectorScore !== undefined) {
                console.log(`        vector_score: ${result.explain.vectorScore.toFixed(6)}`);
              }
              if (result.explain.bm25Score !== undefined) {
                console.log(`        bm25_score:   ${result.explain.bm25Score.toFixed(6)}`);
              }
              if (result.explain.rrfScore !== undefined) {
                console.log(`        rrf_score:    ${result.explain.rrfScore.toFixed(6)}`);
              }
              if (result.explain.vectorRank !== undefined) {
                console.log(`        vector_rank:  ${String(result.explain.vectorRank)}`);
              }
              if (result.explain.bm25Rank !== undefined) {
                console.log(`        bm25_rank:    ${String(result.explain.bm25Rank)}`);
              }
              if (result.explain.matchedTerms.length > 0) {
                console.log(`        matched:      ${result.explain.matchedTerms.join(", ")}`);
              }
              if (result.explain.chunkPreview?.trim()) {
                console.log("        chunk preview:");
                for (const line of trimPreview(result.explain.chunkPreview).split("\n")) {
                  console.log(`          ${line}`);
                }
              }
            }
            console.log();
          }
        }

        // Handle --answer flag: RAG flow
        if (opts.answer) {
          if (!config.llm) {
            throw new Error(
              "--answer requires an `llm` section in your config.yaml.\n" +
              "Example:\n" +
              "  llm:\n" +
              "    type: http\n" +
              "    base_url: \"http://localhost:11434\"\n" +
              "    model_id: \"qwen3:0.6b\"",
            );
          }

          llm = createLlmFromConfig(config);
          if (!llm) {
            throw new Error("Failed to initialize LLM provider.");
          }

          // Collect chunk previews from explain info
          const chunks = renderedResults
            .map((r, i) => {
              const preview = r.explain?.chunkPreview?.trim();
              if (!preview) return null;
              const source = r.sourcePath ? ` [${r.sourcePath}]` : "";
              return `[${String(i + 1)}]${source}\n${preview}`;
            })
            .filter((c): c is string => c !== null);

          const memoryStore = new MemoryStore(join(dataRoot, "memory.json"));
          const assembledMemory = opts.session
            ? memoryStore.assembleContext({
              sessionId: opts.session,
              workflowId: opts.workflow,
              limit: 20,
            })
            : { entries: [], text: "" };

          if (chunks.length === 0 && assembledMemory.entries.length === 0) {
            console.log(
              "Note: No chunk text available for answer generation.\n" +
              "Ensure chunks were ingested with store_chunk_text: true in your config, or provide session memory.",
            );
          } else {
            const context = chunks.join("\n\n---\n\n");
            const memoryContext = assembledMemory.text.trim();
            const prompt =
              `You are a helpful assistant. Answer the question using only the provided context. ` +
              `If the answer cannot be found in the context, say so.\n\n` +
              (memoryContext
                ? `Memory context:\n\n${memoryContext}\n\n`
                : "") +
              `Retrieved context:\n\n${context}\n\n` +
              `Question: ${query}\n\n` +
              `Answer:`;

            console.log("Generating answer...\n");
            const answer = await llm.generate(prompt);
            console.log("Answer:\n");
            console.log(answer);
            console.log();
          }
        }
      } finally {
        db.close();
        await embedder.close?.();
        await llm?.close?.();
      }
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function trimPreview(text: string, maxChars = 220): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

/**
 * Build a lookup map from chunk_id -> file metadata using the Job Registry.
 */
function buildChunkIndex(
  registry: JobRegistry,
): Map<string, SearchResultMetadata> {
  const map = new Map<string, SearchResultMetadata>();
  const files = registry.listFiles();

  for (const file of files) {
    for (const chunkId of file.chunkIds) {
      map.set(chunkId, {
        sourcePath: file.sourcePath,
        contentType: guessContentType(file.sourcePath),
        dedupeKey: chunkId,
      });
    }
  }

  return map;
}

interface SearchResultMetadata {
  sourcePath: string;
  contentType: string;
  dedupeKey: string;
}

function loadSearchMetadata(dataRoot: string): Map<string, SearchResultMetadata> {
  const metadata = new Map<string, SearchResultMetadata>();

  const registryDbPath = join(dataRoot, "registry.db");
  try {
    const registry = new JobRegistry(registryDbPath);
    try {
      for (const [chunkId, value] of buildChunkIndex(registry)) {
        metadata.set(chunkId, value);
      }
    } finally {
      registry.close();
    }
  } catch (err) {
    console.warn(`Warning: could not load registry (source paths will be missing): ${err instanceof Error ? err.message : String(err)}`);
  }

  const semanticDbPath = join(dataRoot, "semantic.db");
  if (!existsSync(semanticDbPath)) {
    return metadata;
  }

  try {
    const store = new SemanticStore(semanticDbPath);
    try {
      for (const summary of store.listBundles()) {
        const stored = store.getStoredBundle(summary.bundleId);
        if (!stored) continue;
        for (const unit of stored.bundle.units) {
          const span = unit.source_spans[0];
          if (!span) continue;
          metadata.set(`semantic:${unit.unit_id}`, {
            sourcePath: span.source_uri,
            contentType: span.content_type,
            dedupeKey: span.chunk_id,
          });
        }
      }
    } finally {
      store.close();
    }
  } catch (err) {
    console.warn(`Warning: could not load semantic store (semantic source paths will be missing): ${err instanceof Error ? err.message : String(err)}`);
  }

  return metadata;
}

function guessContentType(sourcePath: string): string {
  const ext = sourcePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "txt", pdf: "pdf", docx: "docx", pptx: "pptx",
    xlsx: "xlsx", csv: "csv", json: "json", yaml: "yaml", yml: "yaml",
  };
  return map[ext] ?? "unknown";
}
