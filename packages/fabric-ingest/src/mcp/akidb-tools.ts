/**
 * akidb_* MCP tool handlers — ADR-028.
 *
 * 9 tools mapping directly to AkiDB operations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import { MetadataFilterSchema, type MetadataFilter, type RecordMetadata } from "@ax-fabric/contracts";
import {
  DEFAULT_SEARCH_TOP_K,
  DEFAULT_SEARCH_MODE,
  MCP_PIPELINE_SIGNATURE,
  MCP_CHUNK_ID_PREFIX,
} from "../constants.js";

export function registerAkiDbTools(server: McpServer, db: AkiDB): void {
  // ── akidb_create_collection ───────────────────────────────────────────────

  server.tool(
    "akidb_create_collection",
    "Create a new vector collection in AkiDB",
    {
      collection_id: z.string().describe("Unique collection identifier"),
      dimension: z.number().int().positive().describe("Vector dimension"),
      metric: z.enum(["cosine", "l2", "dot"]).default("cosine").describe("Distance metric"),
      embedding_model_id: z.string().describe("Embedding model identifier"),
      quantization: z.enum(["fp16", "sq8"]).default("fp16").optional().describe("Vector quantization"),
      hnsw_m: z.number().int().min(4).max(64).default(16).optional().describe("HNSW M parameter"),
      hnsw_ef_construction: z.number().int().min(50).max(800).default(200).optional().describe("HNSW efConstruction"),
      hnsw_ef_search: z.number().int().min(10).max(500).default(100).optional().describe("HNSW efSearch"),
    },
    async (args) => {
      try {
        const collection = db.createCollection({
          collectionId: args.collection_id,
          dimension: args.dimension,
          metric: args.metric,
          embeddingModelId: args.embedding_model_id,
          quantization: args.quantization as "fp16" | "sq8" | undefined,
          hnswM: args.hnsw_m,
          hnswEfConstruction: args.hnsw_ef_construction,
          hnswEfSearch: args.hnsw_ef_search,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(collection, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_list_collections ────────────────────────────────────────────────

  server.tool(
    "akidb_list_collections",
    "List all active vector collections",
    {},
    async () => {
      try {
        const collections = db.listCollections();
        return { content: [{ type: "text" as const, text: JSON.stringify(collections, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_upsert ──────────────────────────────────────────────────────────

  server.tool(
    "akidb_upsert",
    "Upsert records into a collection",
    {
      collection_id: z.string().describe("Target collection"),
      records: z.array(z.object({
        chunk_id: z.string(),
        doc_id: z.string(),
        doc_version: z.string().optional(),
        chunk_hash: z.string().optional(),
        pipeline_signature: z.string().optional(),
        embedding_model_id: z.string().optional(),
        vector: z.array(z.number()),
        metadata: z.record(z.unknown()).optional(),
        chunk_text: z.string().optional(),
      })).describe("Records to upsert"),
    },
    async (args) => {
      try {
        const records = args.records.map((r) => ({
          chunk_id: r.chunk_id,
          doc_id: r.doc_id,
          doc_version: r.doc_version ?? "v1",
          chunk_hash: r.chunk_hash ?? `${MCP_CHUNK_ID_PREFIX}${r.chunk_id}`,
          pipeline_signature: r.pipeline_signature ?? MCP_PIPELINE_SIGNATURE,
          embedding_model_id: r.embedding_model_id ?? MCP_PIPELINE_SIGNATURE,
          vector: r.vector,
          metadata: toRecordMetadata(r.metadata),
          chunk_text: r.chunk_text,
        }));
        const result = await db.upsertBatch(args.collection_id, records);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_search ──────────────────────────────────────────────────────────

  server.tool(
    "akidb_search",
    "Search a collection with a query vector",
    {
      collection_id: z.string().describe("Target collection"),
      query_vector: z.array(z.number()).describe("Query vector (Float32)"),
      top_k: z.number().int().positive().default(DEFAULT_SEARCH_TOP_K).describe("Number of results"),
      filters: z.record(z.unknown()).optional().describe("Metadata filters"),
      mode: z.enum(["vector", "keyword", "hybrid"]).default(DEFAULT_SEARCH_MODE).optional().describe("Search mode"),
      query_text: z.string().optional().describe("Query text for keyword/hybrid search"),
      explain: z.boolean().default(false).optional().describe("Include scoring breakdown"),
      ef_search: z.number().int().min(10).max(500).optional().describe("Per-query efSearch override"),
    },
    async (args) => {
      try {
        const result = await db.search({
          collectionId: args.collection_id,
          queryVector: new Float32Array(args.query_vector),
          topK: args.top_k,
          filters: toMetadataFilter(args.filters),
          mode: args.mode as "vector" | "keyword" | "hybrid" | undefined,
          queryText: args.query_text,
          explain: args.explain,
          efSearch: args.ef_search,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_publish ─────────────────────────────────────────────────────────

  server.tool(
    "akidb_publish",
    "Flush pending writes and publish a new manifest",
    {
      collection_id: z.string().describe("Target collection"),
      embedding_model_id: z.string().describe("Embedding model identifier"),
      pipeline_signature: z.string().describe("Pipeline version signature"),
    },
    async (args) => {
      try {
        const manifest = await db.publish(args.collection_id, {
          embeddingModelId: args.embedding_model_id,
          pipelineSignature: args.pipeline_signature,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(manifest, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_rollback ────────────────────────────────────────────────────────

  server.tool(
    "akidb_rollback",
    "Rollback to a previous manifest version",
    {
      collection_id: z.string().describe("Target collection"),
      manifest_id: z.string().describe("Manifest ID to rollback to"),
    },
    async (args) => {
      try {
        const manifest = db.rollback(args.collection_id, args.manifest_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(manifest, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_delete_chunks ───────────────────────────────────────────────────

  server.tool(
    "akidb_delete_chunks",
    "Tombstone specific chunks for deletion",
    {
      collection_id: z.string().describe("Target collection"),
      chunk_ids: z.array(z.string()).describe("Chunk IDs to delete"),
      reason: z.enum(["file_deleted", "file_updated", "manual_revoke"]).default("manual_revoke").describe("Deletion reason"),
    },
    async (args) => {
      try {
        db.deleteChunks(args.collection_id, args.chunk_ids, args.reason);
        return { content: [{ type: "text" as const, text: `Deleted ${String(args.chunk_ids.length)} chunks` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_compact ─────────────────────────────────────────────────────────

  server.tool(
    "akidb_compact",
    "Merge segments and reclaim space from tombstoned records",
    {
      collection_id: z.string().describe("Target collection"),
    },
    async (args) => {
      try {
        const manifest = await db.compact(args.collection_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(manifest, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── akidb_collection_status ───────────────────────────────────────────────

  server.tool(
    "akidb_collection_status",
    "Get collection statistics: storage size, tombstone count",
    {
      collection_id: z.string().describe("Target collection"),
    },
    async (args) => {
      try {
        const collection = db.getCollection(args.collection_id);
        const storageSizeBytes = db.getStorageSizeBytes();
        const tombstoneCount = db.getTombstoneCount(args.collection_id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              collection,
              storage_size_bytes: storageSizeBytes,
              tombstone_count: tombstoneCount,
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}

function toRecordMetadata(value: Record<string, unknown> | undefined): RecordMetadata {
  const now = new Date().toISOString();
  const meta = value ?? {};
  return {
    source_uri: typeof meta["source_uri"] === "string" ? meta["source_uri"] : "mcp://unknown",
    content_type: "txt",
    page_range: null,
    offset: typeof meta["offset"] === "number" ? Math.max(0, Math.floor(meta["offset"])) : 0,
    table_ref: null,
    created_at: now,
  };
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
