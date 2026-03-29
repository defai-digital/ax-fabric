import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider, MetadataFilter } from "@ax-fabric/contracts";
import { MetadataFilterSchema } from "@ax-fabric/contracts";

import type { FabricConfig } from "../cli/config-loader.js";
import { resolveDataRoot } from "../cli/config-loader.js";
import {
  DEFAULT_SEARCH_MODE,
  DEFAULT_SEARCH_TOP_K,
} from "../constants.js";
import { executeSearch } from "../retrieval/index.js";

export interface SearchToolsDeps {
  db: AkiDB;
  embedder: EmbedderProvider;
  config: FabricConfig;
}

export function registerSearchTools(server: McpServer, deps: SearchToolsDeps): void {
  const { db, embedder, config } = deps;

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
        const dataRoot = resolveDataRoot(config);

        let queryVector = new Float32Array(0);
        if (args.mode !== "keyword") {
          const vectors = await embedder.embed([args.query]);
          const vec0 = vectors[0];
          if (!vec0 || vec0.length === 0) {
            return { content: [{ type: "text" as const, text: "Error: embedder returned no vector for query" }], isError: true };
          }
          queryVector = new Float32Array(vec0);
        }

        const result = await executeSearch({
          db,
          dataRoot,
          rawCollectionId: collectionId,
          semanticCollectionId: `${collectionId}${config.retrieval.semantic_collection_suffix}`,
          requestedLayer: "raw",
          defaultLayer: "raw",
          queryVector,
          topK: args.top_k,
          filters: toMetadataFilter(args.filters),
          mode: args.mode as "vector" | "keyword" | "hybrid",
          queryText: args.query,
          explain: true,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              results: result.results.map((entry) => ({
                chunkId: entry.chunkId,
                score: entry.score,
                source: entry.sourcePath,
                content: entry.explain?.chunkPreview ?? null,
              })),
            }, null, 2),
          }],
        };
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
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    throw new Error(`Invalid metadata filter: ${issues}`);
  }
  return result.data;
}
