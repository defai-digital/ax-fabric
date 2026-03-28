import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider } from "@ax-fabric/contracts";

import type { FabricConfig } from "../cli/config-loader.js";
import { RecordBuilder } from "../builder/index.js";
import { CHUNKER_VERSION } from "../chunker/index.js";
import { createDefaultRegistry, EXTRACTOR_VERSION } from "../extractor/index.js";
import { NORMALIZER_VERSION } from "../normalizer/index.js";
import { Pipeline } from "../pipeline/index.js";
import { JobRegistry } from "../registry/index.js";
import { SourceScanner } from "../scanner/index.js";

export interface IngestToolsDeps {
  db: AkiDB;
  embedder: EmbedderProvider;
  config: FabricConfig;
  registryDbPath: string;
}

export function registerIngestTools(server: McpServer, deps: IngestToolsDeps): void {
  const { db, embedder, config, registryDbPath } = deps;

  server.tool(
    "fabric_ingest_run",
    "Run the full ingestion pipeline on configured source paths",
    {
      source_paths: z.array(z.string()).optional().describe("Override source paths (default: from config)"),
      collection_id: z.string().optional().describe("Override collection ID (default: from config)"),
    },
    async (args) => {
      try {
        const collectionId = args.collection_id ?? config.akidb.collection;
        const sourcePaths = args.source_paths ?? config.ingest.sources.map((s) => s.path);

        if (sourcePaths.length === 0) {
          return { content: [{ type: "text" as const, text: "Error: No source paths configured or provided" }], isError: true };
        }

        const pipeline = new Pipeline({
          sourcePaths,
          akidb: db,
          collectionId,
          embedder,
          registryDbPath,
          chunkerOptions: {
            chunkSize: config.ingest.chunking.chunk_size,
            overlapRatio: config.ingest.chunking.overlap,
            strategy: config.ingest.chunking.strategy,
          },
        });

        try {
          const metrics = await pipeline.run(sourcePaths);
          return { content: [{ type: "text" as const, text: JSON.stringify(metrics, null, 2) }] };
        } finally {
          pipeline.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_ingest_add_source",
    "Add a source directory path for ingestion scanning",
    {
      path: z.string().describe("Directory path to add as an ingestion source"),
    },
    async (args) => {
      try {
        const scanner = new SourceScanner({ extensions: createDefaultRegistry().getSupportedExtensions() });
        const results = scanner.scan(args.path);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              added_path: args.path,
              files_found: results.length,
              message: `Source path added. Found ${String(results.length)} files. Run fabric_ingest_run to ingest.`,
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_ingest_diff",
    "Show what would change if ingestion ran now (dry-run)",
    {
      source_paths: z.array(z.string()).optional().describe("Override source paths (default: from config)"),
    },
    async (args) => {
      try {
        const sourcePaths = args.source_paths ?? config.ingest.sources.map((s) => s.path);

        if (sourcePaths.length === 0) {
          return { content: [{ type: "text" as const, text: "Error: No source paths configured or provided" }], isError: true };
        }

        const scanner = new SourceScanner({ extensions: createDefaultRegistry().getSupportedExtensions() });
        const allResults = [];
        for (const root of sourcePaths) {
          allResults.push(...scanner.scan(root));
        }

        let registry: JobRegistry | null = null;
        try {
          registry = new JobRegistry(registryDbPath);
          const knownStates = registry.getKnownFileStates();
          const files = registry.listFiles();
          const chunkerSignature = [
            CHUNKER_VERSION,
            `size=${String(config.ingest.chunking.chunk_size)}`,
            `overlap=${String(config.ingest.chunking.overlap)}`,
            `strategy=${config.ingest.chunking.strategy}`,
          ].join("|");
          const currentPipelineSignature = RecordBuilder.computePipelineSignature({
            extractor_version: EXTRACTOR_VERSION,
            normalize_version: NORMALIZER_VERSION,
            chunker_version: chunkerSignature,
          });
          const known = new Map<string, string>();
          for (const file of files) {
            const state = knownStates.get(file.sourcePath);
            if (!state) continue;
            known.set(
              file.sourcePath,
              file.pipelineSignature === currentPipelineSignature
                ? state.fingerprint
                : `${state.fingerprint}::stale-pipeline`,
            );
          }
          const changes = scanner.detectChanges(allResults, known);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                total_files: allResults.length,
                added: changes.added.length,
                modified: changes.modified.length,
                deleted: changes.deleted.length,
                unchanged: changes.unchanged.length,
                added_files: changes.added.map((f) => f.sourcePath),
                modified_files: changes.modified.map((f) => f.sourcePath),
                deleted_files: changes.deleted,
              }, null, 2),
            }],
          };
        } finally {
          registry?.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_ingest_status",
    "Show ingestion status for tracked files",
    {},
    async () => {
      try {
        const registry = new JobRegistry(registryDbPath);
        try {
          const files = registry.listFiles();
          const summary = {
            total_files: files.length,
            success: files.filter((f) => f.status === "success").length,
            error: files.filter((f) => f.status === "error").length,
            total_chunks: files.reduce((acc, f) => acc + f.chunkIds.length, 0),
            files: files.map((f) => ({
              path: f.sourcePath,
              status: f.status,
              chunks: f.chunkIds.length,
              last_ingest: f.lastIngestAt,
              error: f.errorMessage ?? undefined,
            })),
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        } finally {
          registry.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
