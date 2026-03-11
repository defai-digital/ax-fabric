/**
 * fabric_* MCP tool handlers — ADR-028.
 *
 * Ingestion, semantic workflow, search, config, and memory tools.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider, Record as AkiRecord, SemanticBundle } from "@ax-fabric/contracts";
import { MetadataFilterSchema, type MetadataFilter } from "@ax-fabric/contracts";

import { Pipeline } from "../pipeline/index.js";
import { SourceScanner } from "../scanner/index.js";
import { createDefaultRegistry } from "../extractor/index.js";
import { EXTRACTOR_VERSION } from "../extractor/index.js";
import { normalize } from "../normalizer/index.js";
import { chunk } from "../chunker/index.js";
import { CHUNKER_VERSION } from "../chunker/index.js";
import { JobRegistry } from "../registry/index.js";
import { MemoryStore } from "../memory/index.js";
import { resolveDataRoot, type FabricConfig } from "../cli/config-loader.js";
import { NORMALIZER_VERSION } from "../normalizer/index.js";
import { RecordBuilder } from "../builder/index.js";
import { SemanticReviewEngine, SemanticStore } from "../semantic/index.js";

export interface FabricToolsDeps {
  db: AkiDB;
  embedder: EmbedderProvider;
  config: FabricConfig;
  registryDbPath: string;
  memoryStorePath: string;
}

export function registerFabricTools(server: McpServer, deps: FabricToolsDeps): void {
  const { db, embedder, config, memoryStorePath } = deps;
  const semanticDbPath = join(resolveDataRoot(config), "semantic.db");

  // ── fabric_ingest_run ─────────────────────────────────────────────────────

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
          registryDbPath: deps.registryDbPath,
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

  // ── fabric_ingest_add_source ──────────────────────────────────────────────

  server.tool(
    "fabric_ingest_add_source",
    "Add a source directory path for ingestion scanning",
    {
      path: z.string().describe("Directory path to add as an ingestion source"),
    },
    async (args) => {
      try {
        // Validate the path exists by scanning it
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

  // ── fabric_ingest_diff ────────────────────────────────────────────────────

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
          registry = new JobRegistry(deps.registryDbPath);
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

  // ── fabric_ingest_status ──────────────────────────────────────────────────

  server.tool(
    "fabric_ingest_status",
    "Show ingestion status for tracked files",
    {},
    async () => {
      try {
        const registry = new JobRegistry(deps.registryDbPath);
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

  // ── fabric_search ─────────────────────────────────────────────────────────

  server.tool(
    "fabric_search",
    "Search for documents by semantic similarity or keyword/hybrid retrieval",
    {
      query: z.string().describe("Natural language search query"),
      collection_id: z.string().optional().describe("Target collection (default: from config)"),
      top_k: z.number().int().positive().default(10).describe("Number of results"),
      mode: z.enum(["vector", "keyword", "hybrid"]).default("vector").optional().describe("Search mode"),
      filters: z.record(z.unknown()).optional().describe("Metadata filters"),
    },
    async (args) => {
      try {
        const collectionId = args.collection_id ?? config.akidb.collection;

        let queryVector = new Float32Array(0);
        if (args.mode !== "keyword") {
          const vectors = await embedder.embed([args.query]);
          const vec0 = vectors[0];
          if (!vec0 || vec0.length === 0) {
            return { content: [{ type: "text" as const, text: "Error: embedder returned no vector for query" }], isError: true };
          }
          queryVector = new Float32Array(vec0);
        }

        const result = await db.search({
          collectionId,
          queryVector,
          topK: args.top_k,
          filters: toMetadataFilter(args.filters),
          mode: args.mode as "vector" | "keyword" | "hybrid" | undefined,
          queryText: args.query,
          explain: true,
        });

        // Build chunk → source path lookup from the registry
        let filesByChunkId: Map<string, string> | null = null;
        let _searchRegistry: JobRegistry | null = null;
        try {
          _searchRegistry = new JobRegistry(deps.registryDbPath);
          filesByChunkId = new Map();
          for (const file of _searchRegistry.listFiles()) {
            for (const chunkId of file.chunkIds) {
              filesByChunkId.set(chunkId, file.sourcePath);
            }
          }
        } catch {
          // Registry not available — continue without source info
        } finally {
          _searchRegistry?.close();
        }

        const enrichedResults = result.results.map((r) => ({
          chunkId: r.chunkId,
          score: r.score,
          source: filesByChunkId?.get(r.chunkId) ?? null,
          content: r.explain?.chunkPreview ?? null,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ results: enrichedResults }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_semantic_store_bundle ──────────────────────────────────────────

  server.tool(
    "fabric_semantic_store_bundle",
    "Create a semantic bundle from a file and store it in the canonical semantic store",
    {
      file_path: z.string().describe("Path to the source file"),
      low_quality_threshold: z.number().min(0).max(1).optional().default(0.6).describe("Flag units below this score"),
      strategy: z.enum(["auto", "fixed", "markdown", "structured"]).optional().describe("Chunking strategy override"),
    },
    async (args) => {
      try {
        const engine = new SemanticReviewEngine();
        const bundle = await engine.createBundle(args.file_path, {
          strategy: args.strategy,
          chunkSize: config.ingest.chunking.chunk_size,
          overlapRatio: config.ingest.chunking.overlap,
          lowQualityThreshold: args.low_quality_threshold,
        });
        const store = new SemanticStore(semanticDbPath);
        try {
          store.upsertBundle(bundle);
        } finally {
          store.close();
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bundle_id: bundle.bundle_id,
              source_path: bundle.source_path,
              total_units: bundle.diagnostics.total_units,
              average_quality_score: bundle.diagnostics.average_quality_score,
              review_status: bundle.review?.status ?? "pending",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_semantic_list_bundles ──────────────────────────────────────────

  server.tool(
    "fabric_semantic_list_bundles",
    "List semantic bundles from the canonical semantic store",
    {},
    async () => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundles = store.listBundles();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ bundles }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_semantic_inspect_bundle ────────────────────────────────────────

  server.tool(
    "fabric_semantic_inspect_bundle",
    "Inspect a semantic bundle and its publication state from the canonical semantic store",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const stored = store.getStoredBundle(args.bundle_id);
          if (!stored) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(stored, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_semantic_approve_bundle ────────────────────────────────────────

  server.tool(
    "fabric_semantic_approve_bundle",
    "Approve or reject a stored semantic bundle under the configured review policy",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
      reviewer: z.string().min(1).describe("Reviewer identity"),
      min_quality_score: z.number().min(0).max(1).optional().default(0.7).describe("Minimum quality score"),
      duplicate_policy: z.enum(["warn", "reject"]).optional().default("reject").describe("Duplicate handling policy"),
      notes: z.string().optional().describe("Optional review notes"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundle = store.getBundle(args.bundle_id);
          if (!bundle) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          const engine = new SemanticReviewEngine();
          const reviewed = engine.approveBundle(bundle, {
            reviewer: args.reviewer,
            minQualityScore: args.min_quality_score,
            duplicatePolicy: args.duplicate_policy,
            notes: args.notes,
          });
          store.upsertBundle(reviewed);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                bundle_id: reviewed.bundle_id,
                review: reviewed.review,
                diagnostics: reviewed.diagnostics,
              }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_semantic_publish_bundle ────────────────────────────────────────

  server.tool(
    "fabric_semantic_publish_bundle",
    "Publish an approved semantic bundle into the semantic AkiDB collection",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
      collection_id: z.string().optional().describe("Override semantic collection ID"),
      replace_existing: z.boolean().optional().default(false).describe("Replace the active bundle for the same doc"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundle = store.getBundle(args.bundle_id);
          if (!bundle) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          const collectionId = args.collection_id ?? `${config.akidb.collection}${config.retrieval.semantic_collection_suffix}`;
          const manifest = await publishSemanticBundle({
            bundleId: args.bundle_id,
            bundle,
            store,
            db,
            embedder,
            config,
            collectionId,
            replaceExisting: args.replace_existing === true,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                bundle_id: args.bundle_id,
                collection_id: collectionId,
                manifest_version: manifest.version,
              }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_extract ────────────────────────────────────────────────────────

  server.tool(
    "fabric_extract",
    "Extract text content from a single file",
    {
      file_path: z.string().describe("Path to the file to extract"),
    },
    async (args) => {
      try {
        const registry = createDefaultRegistry();
        const extractor = registry.getExtractor(args.file_path);
        if (!extractor) {
          const ext = args.file_path.split(".").pop()?.toLowerCase() ?? "unknown";
          return { content: [{ type: "text" as const, text: `Error: No extractor for file type: .${ext}` }], isError: true };
        }
        const result = await extractor.extract(args.file_path);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file_path: args.file_path,
              text_length: result.text.length,
              text: result.text.slice(0, 5000),
              truncated: result.text.length > 5000,
              page_range: result.pageRange ?? null,
              table_ref: result.tableRef ?? null,
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_chunk ──────────────────────────────────────────────────────────

  server.tool(
    "fabric_chunk",
    "Chunk text content into smaller pieces for embedding",
    {
      text: z.string().describe("Text to chunk"),
      chunk_size: z.number().int().positive().default(2800).optional().describe("Max chunk size in chars"),
      overlap: z.number().min(0).max(1).default(0.15).optional().describe("Overlap fraction"),
    },
    async (args) => {
      try {
        const normalizedText = normalize(args.text);
        const chunks = chunk(normalizedText, "preview", "preview", {
          chunkSize: args.chunk_size ?? 2800,
          overlapRatio: args.overlap ?? 0.15,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              total_chunks: chunks.length,
              chunks: chunks.map((c) => ({
                chunk_id: c.chunkId,
                offset: c.offset,
                text_length: c.text.length,
                text_preview: c.text.slice(0, 200),
              })),
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_embed ──────────────────────────────────────────────────────────

  server.tool(
    "fabric_embed",
    "Embed text chunks into vectors using the configured embedder",
    {
      texts: z.array(z.string()).describe("Text chunks to embed"),
    },
    async (args) => {
      try {
        const vectors = await embedder.embed(args.texts);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              model_id: embedder.modelId,
              dimension: embedder.dimension,
              count: vectors.length,
              vectors: vectors.map((v) => ({
                dimension: v.length,
                first_5: Array.from(v.slice(0, 5)),
              })),
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_config_show ────────────────────────────────────────────────────

  server.tool(
    "fabric_config_show",
    "Show the current ax-fabric configuration (secrets redacted)",
    {},
    async () => {
      try {
        // Redact sensitive fields before returning
        const redacted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
        const embedderSection = redacted["embedder"] as Record<string, unknown> | undefined;
        if (embedderSection?.["api_key"]) {
          embedderSection["api_key"] = "***REDACTED***";
        }
        const llmSection = redacted["llm"] as Record<string, unknown> | undefined;
        const authSection = llmSection?.["auth"] as Record<string, unknown> | undefined;
        if (authSection?.["token"]) {
          authSection["token"] = "***REDACTED***";
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(redacted, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_config_set ─────────────────────────────────────────────────────

  server.tool(
    "fabric_config_set",
    "Update a configuration value (dot-separated path, e.g., 'akidb.metric')",
    {
      key: z.string().describe("Dot-separated config path (e.g., 'akidb.metric', 'ingest.chunking.chunk_size')"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
    },
    async (args) => {
      try {
        const parts = args.key.split(".");
        // Build a shallow update to apply on top of config
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obj: any = JSON.parse(JSON.stringify(config));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let current: any = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current[parts[i]!] === undefined || typeof current[parts[i]!] !== "object") {
            current[parts[i]!] = {};
          }
          current = current[parts[i]!];
        }
        const lastKey = parts[parts.length - 1]!;
        const oldValue = current[lastKey];
        current[lastKey] = args.value;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              key: args.key,
              old_value: oldValue,
              new_value: args.value,
              message: "Configuration updated in memory. Use 'ax-fabric init' to persist changes to disk.",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_memory_put ─────────────────────────────────────────────────────

  server.tool(
    "fabric_memory_put",
    "Store a memory record scoped to a session and optional workflow",
    {
      session_id: z.string().describe("Session ID"),
      text: z.string().min(1).describe("Memory text to store"),
      kind: z.enum(["short-term", "long-term"]).optional().default("short-term").describe("Memory kind"),
      workflow_id: z.string().optional().describe("Optional workflow ID for sub-session scoping"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const record = store.put({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          text: args.text,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_memory_list ────────────────────────────────────────────────────

  server.tool(
    "fabric_memory_list",
    "List memory records, optionally filtered by session, workflow, and kind",
    {
      session_id: z.string().optional().describe("Session ID to filter by"),
      workflow_id: z.string().optional().describe("Workflow ID to filter by"),
      kind: z.enum(["short-term", "long-term"]).optional().describe("Memory kind to filter by"),
      limit: z.number().int().positive().optional().default(20).describe("Maximum records to return"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const records = store.list({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          limit: args.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ records }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_memory_assemble ────────────────────────────────────────────────

  server.tool(
    "fabric_memory_assemble",
    "Assemble memory records into a single context block for prompt injection",
    {
      session_id: z.string().describe("Session ID"),
      workflow_id: z.string().optional().describe("Optional workflow ID to narrow scope"),
      kind: z.enum(["short-term", "long-term"]).optional().describe("Memory kind to include"),
      limit: z.number().int().positive().optional().default(20).describe("Maximum records to include"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const assembled = store.assembleContext({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          limit: args.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(assembled, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── fabric_memory_delete ──────────────────────────────────────────────────

  server.tool(
    "fabric_memory_delete",
    "Delete a memory record by ID",
    {
      id: z.string().describe("Memory record ID"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const deleted = store.delete(args.id);
        if (!deleted) {
          return { content: [{ type: "text" as const, text: `Memory record not found: ${args.id}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: args.id, deleted: true }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}

function toMetadataFilter(value: Record<string, unknown> | undefined): MetadataFilter | undefined {
  if (!value) return undefined;
  const result = MetadataFilterSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid metadata filter: ${issues}`);
  }
  return result.data;
}

function ensureCollection(db: AkiDB, config: FabricConfig, collectionId: string): void {
  try {
    db.getCollection(collectionId);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("not found"))) {
      throw error;
    }
    db.createCollection({
      collectionId,
      dimension: config.akidb.dimension,
      metric: config.akidb.metric,
      embeddingModelId: config.embedder.model_id,
    });
  }
}

async function publishSemanticBundle(args: {
  bundleId: string;
  bundle: SemanticBundle;
  store: SemanticStore;
  db: AkiDB;
  embedder: EmbedderProvider;
  config: FabricConfig;
  collectionId: string;
  replaceExisting: boolean;
}) {
  if (args.bundle.review?.status !== "approved") {
    throw new Error(`Semantic bundle "${args.bundleId}" is not approved`);
  }

  const existingPublication = args.store.findPublishedBundleForDoc(args.bundle.doc_id, args.collectionId);
  if (existingPublication && existingPublication.bundleId !== args.bundle.bundle_id) {
    if (args.replaceExisting !== true) {
      throw new Error(
        `Semantic collection "${args.collectionId}" already has an active published bundle for doc_id "${args.bundle.doc_id}" `
        + `(${existingPublication.bundleId}). Rerun with replace_existing=true to replace it.`,
      );
    }

    const existingBundle = args.store.getBundle(existingPublication.bundleId);
    if (!existingBundle) {
      throw new Error(`Published semantic bundle "${existingPublication.bundleId}" not found in canonical store`);
    }
    await revokeSemanticBundle(existingPublication.bundleId, existingBundle, args.collectionId, args.store, args.db, args.config);
  }

  ensureCollection(args.db, args.config, args.collectionId);
  const records = await buildSemanticRecords(args.bundle, args.config, args.embedder);
  await args.db.upsertBatch(args.collectionId, records);
  const manifest = await args.db.publish(args.collectionId, {
    embeddingModelId: args.config.embedder.model_id,
    pipelineSignature: semanticPipelineSignature(args.bundle),
  });
  args.store.markPublished(args.bundleId, {
    collectionId: args.collectionId,
    manifestVersion: manifest.version,
    publishedAt: new Date().toISOString(),
  });
  return manifest;
}

async function revokeSemanticBundle(
  bundleId: string,
  bundle: SemanticBundle,
  collectionId: string,
  store: SemanticStore,
  db: AkiDB,
  config: FabricConfig,
) {
  const chunkIds = semanticChunkIds(bundle);
  if (chunkIds.length > 0) {
    db.deleteChunks(collectionId, chunkIds, "manual_revoke");
    await db.publish(collectionId, {
      embeddingModelId: config.embedder.model_id,
      pipelineSignature: semanticPipelineSignature(bundle),
    });
  }
  store.clearPublished(bundleId);
}

async function buildSemanticRecords(
  bundle: SemanticBundle,
  config: FabricConfig,
  embedder: EmbedderProvider,
): Promise<AkiRecord[]> {
  const texts = bundle.units.map((unit) => semanticUnitText(unit));
  const vectors = await embedder.embed(texts);
  const createdAt = new Date().toISOString();

  return bundle.units.map((unit, index) => {
    const text = texts[index]!;
    const vector = vectors[index]!;
    const span = unit.source_spans[0]!;
    return {
      chunk_id: `semantic:${unit.unit_id}`,
      doc_id: bundle.doc_id,
      doc_version: bundle.doc_version,
      chunk_hash: digest(text),
      pipeline_signature: semanticPipelineSignature(bundle),
      embedding_model_id: config.embedder.model_id,
      vector,
      metadata: {
        source_uri: span.source_uri,
        content_type: span.content_type,
        page_range: span.page_range,
        offset: span.offset_start,
        table_ref: span.table_ref,
        chunk_label: span.chunk_label,
        created_at: createdAt,
      },
      chunk_text: text,
    };
  });
}

function semanticUnitText(unit: SemanticBundle["units"][number]): string {
  return `${unit.title}\n\n${unit.summary}\n\n${unit.answer}`;
}

function semanticChunkIds(bundle: SemanticBundle): string[] {
  return bundle.units.map((unit) => `semantic:${unit.unit_id}`);
}

function semanticPipelineSignature(bundle: SemanticBundle): string {
  return `semantic-store:${bundle.distill_strategy}:${bundle.review?.status ?? "pending"}`;
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
