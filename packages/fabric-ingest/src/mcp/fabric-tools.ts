/**
 * fabric_* MCP tool handlers — ADR-028.
 *
 * Ingestion, semantic workflow, search, config, and memory tools.
 */

import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider } from "@ax-fabric/contracts";
import { MetadataFilterSchema, type MetadataFilter } from "@ax-fabric/contracts";
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERLAP_RATIO,
  DEFAULT_SEARCH_TOP_K,
  DEFAULT_SEARCH_MODE,
} from "../constants.js";

import { createDefaultRegistry } from "../extractor/index.js";
import { normalize } from "../normalizer/index.js";
import { chunk } from "../chunker/index.js";
import { JobRegistry } from "../registry/index.js";
import { MemoryStore } from "../memory/index.js";
import { resolveDataRoot, type FabricConfig } from "../cli/config-loader.js";
import { registerIngestTools } from "./ingest-tools.js";
import { registerSemanticTools } from "./semantic-tools.js";

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

  registerIngestTools(server, { db, embedder, config, registryDbPath: deps.registryDbPath });
  registerSemanticTools(server, { db, embedder, config, semanticDbPath });

  // ── fabric_search ─────────────────────────────────────────────────────────

  server.tool(
    "fabric_search",
    "Search for documents by semantic similarity or keyword/hybrid retrieval",
    {
      query: z.string().describe("Natural language search query"),
      collection_id: z.string().optional().describe("Target collection (default: from config)"),
      top_k: z.number().int().positive().default(DEFAULT_SEARCH_TOP_K).describe("Number of results"),
      mode: z.enum(["vector", "keyword", "hybrid"]).default(DEFAULT_SEARCH_MODE).optional().describe("Search mode"),
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
      chunk_size: z.number().int().positive().default(DEFAULT_CHUNK_SIZE).optional().describe("Max chunk size in chars"),
      overlap: z.number().min(0).max(1).default(DEFAULT_OVERLAP_RATIO).optional().describe("Overlap fraction"),
    },
    async (args) => {
      try {
        const normalizedText = normalize(args.text);
        const chunks = chunk(normalizedText, "preview", "preview", {
          chunkSize: args.chunk_size ?? DEFAULT_CHUNK_SIZE,
          overlapRatio: args.overlap ?? DEFAULT_OVERLAP_RATIO,
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
