/**
 * MCP resource handlers — ADR-028.
 *
 * 5 read-only resources exposing AkiDB and pipeline state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";

import { JobRegistry } from "../registry/index.js";
import { createDefaultRegistry } from "../extractor/index.js";
import type { FabricConfig } from "../cli/config-loader.js";

export interface ResourceDeps {
  db: AkiDB;
  config: FabricConfig;
  registryDbPath: string;
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const { db, config } = deps;

  // ── axfabric://collections ──────────────────────────────────────────────

  server.resource(
    "collections-list",
    "axfabric://collections",
    { description: "List all AkiDB collections", mimeType: "application/json" },
    async () => {
      const collections = db.listCollections();
      return {
        contents: [{
          uri: "axfabric://collections",
          mimeType: "application/json",
          text: JSON.stringify(collections, null, 2),
        }],
      };
    },
  );

  // ── axfabric://collections/{id}/status ──────────────────────────────────

  server.resource(
    "collection-status",
    "axfabric://collections/{collection_id}/status",
    { description: "Get collection status including storage size and tombstone count", mimeType: "application/json" },
    async (uri) => {
      const collectionId = uri.pathname.split("/")[2] ?? "";
      const collection = db.getCollection(collectionId);
      const storageSizeBytes = db.getStorageSizeBytes();
      const tombstoneCount = db.getTombstoneCount(collectionId);

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            collection,
            storage_size_bytes: storageSizeBytes,
            tombstone_count: tombstoneCount,
          }, null, 2),
        }],
      };
    },
  );

  // ── axfabric://config ───────────────────────────────────────────────────

  server.resource(
    "config",
    "axfabric://config",
    { description: "Current ax-fabric configuration (secrets redacted)", mimeType: "application/json" },
    async () => {
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

      return {
        contents: [{
          uri: "axfabric://config",
          mimeType: "application/json",
          text: JSON.stringify(redacted, null, 2),
        }],
      };
    },
  );

  // ── axfabric://jobs ─────────────────────────────────────────────────────

  server.resource(
    "jobs",
    "axfabric://jobs",
    { description: "Ingestion job registry — tracked files and their status", mimeType: "application/json" },
    async () => {
      let registry: JobRegistry | null = null;
      try {
        registry = new JobRegistry(deps.registryDbPath);
        const files = registry.listFiles();
        const summary = {
          total_files: files.length,
          success: files.filter((f) => f.status === "success").length,
          error: files.filter((f) => f.status === "error").length,
          total_chunks: files.reduce((acc, f) => acc + f.chunkIds.length, 0),
        };

        return {
          contents: [{
            uri: "axfabric://jobs",
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          }],
        };
      } finally {
        registry?.close();
      }
    },
  );

  // ── axfabric://formats ──────────────────────────────────────────────────

  server.resource(
    "formats",
    "axfabric://formats",
    { description: "Supported file formats for document extraction", mimeType: "application/json" },
    async () => {
      const registry = createDefaultRegistry();
      const extensions = registry.getSupportedExtensions();

      return {
        contents: [{
          uri: "axfabric://formats",
          mimeType: "application/json",
          text: JSON.stringify({
            supported_extensions: extensions,
            extractor_count: extensions.length,
          }, null, 2),
        }],
      };
    },
  );
}
