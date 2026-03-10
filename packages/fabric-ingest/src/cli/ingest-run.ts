/**
 * `ax-fabric ingest run` — execute the full ingestion pipeline.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";

import { Pipeline } from "../pipeline/index.js";

import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";
import { createEmbedderFromConfig } from "./create-embedder.js";

/** Expand a leading `~` to the current user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function registerIngestRunCommand(ingest: Command): void {
  ingest
    .command("run")
    .description("Execute the full ingestion pipeline")
    .action(async () => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const dataRoot = resolveDataRoot(config);

      if (config.ingest.sources.length === 0) {
        console.error("No sources configured. Use `ax-fabric ingest add <path>` to add sources.");
        process.exit(1);
      }

      // Create embedder from config
      const embedder = createEmbedderFromConfig(config);

      // Create AkiDB instance — expand tilde in configured root
      const akidbRoot = expandTilde(config.akidb.root);
      const db = new AkiDB({ storagePath: akidbRoot });

      // Ensure collection exists
      ensureCollection(db, config);

      const registryDbPath = join(dataRoot, "registry.db");
      const sourcePaths = config.ingest.sources.map((s) => s.path);

      const pipeline = new Pipeline({
        sourcePaths,
        akidb: db,
        collectionId: config.akidb.collection,
        embedder,
        registryDbPath,
        chunkerOptions: {
          chunkSize: config.ingest.chunking.chunk_size,
          overlapRatio: config.ingest.chunking.overlap,
        },
      });

      try {
        console.log("Starting ingestion pipeline...\n");
        const metrics = await pipeline.run(sourcePaths);


        // Print metrics
        console.log("Pipeline completed.\n");
        console.log(`  Files scanned:     ${String(metrics.filesScanned)}`);
        console.log(`  Files changed:     ${String(metrics.filesChanged)}`);
        console.log(`    Added:           ${String(metrics.filesAdded)}`);
        console.log(`    Modified:        ${String(metrics.filesModified)}`);
        console.log(`    Deleted:         ${String(metrics.filesDeleted)}`);
        console.log(`  Files unchanged:   ${String(metrics.filesUnchanged)}`);
        console.log(`  Files failed:      ${String(metrics.filesFailed)}`);
        console.log(`  Records generated: ${String(metrics.recordsGenerated)}`);
        console.log(`  Manifest version:  ${metrics.manifestVersion !== null ? String(metrics.manifestVersion) : "n/a"}`);
        console.log(`  Duration:          ${String(metrics.durationMs)}ms`);
        console.log("");
        console.log("  Stage breakdown:");
        console.log(`    Scan:            ${String(metrics.scanDurationMs)}ms`);
        console.log(`    Process:         ${String(metrics.processDurationMs)}ms`);
        console.log(`    Publish:         ${String(metrics.publishDurationMs)}ms`);
        if (metrics.embedStats.batchesFired > 0) {
          console.log("");
          console.log("  Embedding:");
          console.log(`    Batches fired:   ${String(metrics.embedStats.batchesFired)}`);
          console.log(`    Vectors/sec:     ${String(metrics.embedStats.vectorsPerSec)}`);
          console.log(`    Avg fill ratio:  ${(metrics.embedStats.avgFillRatio * 100).toFixed(1)}%`);
          if (metrics.embedStats.errorsEncountered > 0) {
            console.log(`    Errors:          ${String(metrics.embedStats.errorsEncountered)}`);
          }
        }

        // Print errors if any
        if (metrics.errors.length > 0) {
          console.log(`\n  Errors (${String(metrics.errors.length)}):`);
          for (const err of metrics.errors) {
            console.log(`    [${err.errorCode}] ${err.sourcePath}: ${err.message}`);
          }
        }

        console.log();
      } finally {
        pipeline.close();
        db.close();
        await embedder.close?.();
      }
    });
}

function ensureCollection(db: AkiDB, config: { akidb: { collection: string; metric: string; dimension: number }; embedder: { model_id: string } }): void {
  try {
    db.getCollection(config.akidb.collection);
  } catch {
    // Collection doesn't exist — create it
    db.createCollection({
      collectionId: config.akidb.collection,
      dimension: config.akidb.dimension,
      metric: config.akidb.metric as "cosine" | "l2" | "dot",
      embeddingModelId: config.embedder.model_id,
    });
  }
}
