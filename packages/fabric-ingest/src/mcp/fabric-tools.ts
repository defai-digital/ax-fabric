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
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERLAP_RATIO,
} from "../constants.js";

import { createDefaultRegistry } from "../extractor/index.js";
import { normalize } from "../normalizer/index.js";
import { chunk } from "../chunker/index.js";
import { resolveDataRoot, type FabricConfig } from "../cli/config-loader.js";
import { registerConfigTools } from "./config-tools.js";
import { registerIngestTools } from "./ingest-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerSearchTools } from "./search-tools.js";
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
  registerSearchTools(server, { db, embedder, config });

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

  registerConfigTools(server, { config });
  registerMemoryTools(server, { memoryStorePath });
}
