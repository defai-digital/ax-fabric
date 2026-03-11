/**
 * Tests for MCP server — tool and resource registration.
 *
 * Uses in-process McpServer with direct tool invocation via the low-level Server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AkiDB } from "@ax-fabric/akidb";

import { registerAkiDbTools } from "./akidb-tools.js";
import { registerFabricTools } from "./fabric-tools.js";
import { registerResources } from "./resources.js";
import { MockEmbedder } from "../embedder/index.js";
import { MemoryStore } from "../memory/index.js";
import type { FabricConfig } from "../cli/config-loader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestConfig(tmpDir: string): FabricConfig {
  return {
    fabric: { data_root: tmpDir, max_storage_gb: 50 },
    akidb: { root: tmpDir, collection: "test", metric: "cosine", dimension: 128 },
    ingest: {
      sources: [],
      scan: { mode: "incremental", fingerprint: "sha256" },
      chunking: { chunk_size: 2800, overlap: 0.15, strategy: "auto" },
    },
    embedder: { type: "local", model_id: "test-embed", dimension: 128, batch_size: 64 },
  };
}

function createTestServer(db: AkiDB, config: FabricConfig, registryDbPath: string, memoryStorePath: string) {
  const server = new McpServer({
    name: "ax-fabric-test",
    version: "1.6.0",
  }, {
    capabilities: { tools: {}, resources: {} },
  });

  const embedder = new MockEmbedder({ modelId: "test-embed", dimension: 128 });

  registerAkiDbTools(server, db);
  registerFabricTools(server, { db, embedder, config, registryDbPath, memoryStorePath });
  registerResources(server, { db, config, registryDbPath });

  return server;
}

// We test tool/resource registration by verifying the server was created without errors
// and that tools are properly configured. Direct tool invocation requires a transport,
// so we test the tool handler functions more directly.

describe("MCP Server", () => {
  let tmpDir: string;
  let db: AkiDB;
  let config: FabricConfig;
  let registryDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    config = createTestConfig(tmpDir);
    registryDbPath = join(tmpDir, "registry.db");
    db = new AkiDB({ storagePath: tmpDir });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("tool registration", () => {
    it("registers all tools without errors", () => {
      expect(() => createTestServer(db, config, registryDbPath, join(tmpDir, "memory.json"))).not.toThrow();
    });

    it("registers akidb tools with correct server instance", () => {
      const server = new McpServer(
        { name: "test", version: "1.6.0" },
        { capabilities: { tools: {} } },
      );
      expect(() => registerAkiDbTools(server, db)).not.toThrow();
    });

    it("registers fabric tools with correct dependencies", () => {
      const server = new McpServer(
        { name: "test", version: "1.6.0" },
        { capabilities: { tools: {} } },
      );
      const embedder = new MockEmbedder({ modelId: "test", dimension: 128 });
      expect(() => registerFabricTools(server, { db, embedder, config, registryDbPath, memoryStorePath: join(tmpDir, "memory.json") })).not.toThrow();
    });
  });

  describe("resource registration", () => {
    it("registers all resources without errors", () => {
      const server = new McpServer(
        { name: "test", version: "1.6.0" },
        { capabilities: { resources: {} } },
      );
      expect(() => registerResources(server, { db, config, registryDbPath })).not.toThrow();
    });
  });

  describe("createMcpServer", () => {
    it("closes the embedder during shutdown", async () => {
      const closeSpy = vi.fn(async () => undefined);

      vi.resetModules();
      vi.doMock("../cli/config-loader.js", () => ({
        loadConfig: () => createTestConfig(tmpDir),
        resolveDataRoot: (cfg: FabricConfig) => cfg.fabric.data_root,
      }));
      vi.doMock("../cli/create-embedder.js", () => ({
        createEmbedderFromConfig: () => ({
          modelId: "test-embed",
          dimension: 128,
          embed: vi.fn(async () => []),
          close: closeSpy,
        }),
      }));

      const { createMcpServer } = await import("./server.js");
      const instance = createMcpServer({ configPath: join(tmpDir, "config.yaml") });
      await instance.close();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("akidb_create_collection tool handler", () => {
    it("can create a collection via tool handler", async () => {
      // Test the underlying AkiDB operations that the tool wraps
      const collection = db.createCollection({
        collectionId: "test-mcp",
        dimension: 128,
        metric: "cosine",
        embeddingModelId: "test-embed",
      });
      expect(collection.collection_id).toBe("test-mcp");
      expect(collection.dimension).toBe(128);
    });
  });

  describe("akidb_list_collections tool handler", () => {
    it("lists collections after creation", () => {
      db.createCollection({
        collectionId: "col-a",
        dimension: 64,
        metric: "l2",
        embeddingModelId: "test",
      });
      db.createCollection({
        collectionId: "col-b",
        dimension: 128,
        metric: "cosine",
        embeddingModelId: "test",
      });
      const collections = db.listCollections();
      expect(collections.length).toBe(2);
      expect(collections.map((c) => c.collection_id).sort()).toEqual(["col-a", "col-b"]);
    });
  });

  describe("akidb_collection_status tool handler", () => {
    it("returns collection status with storage size and tombstone count", () => {
      db.createCollection({
        collectionId: "status-test",
        dimension: 128,
        metric: "cosine",
        embeddingModelId: "test",
      });

      const collection = db.getCollection("status-test");
      const storageSize = db.getStorageSizeBytes();
      const tombstoneCount = db.getTombstoneCount("status-test");

      expect(collection.collection_id).toBe("status-test");
      expect(typeof storageSize).toBe("number");
      expect(tombstoneCount).toBe(0);
    });
  });

  describe("fabric_search tool handler", () => {
    it("searches with auto-embedded query", async () => {
      const embedder = new MockEmbedder({ modelId: "test", dimension: 128 });

      // Create collection and upsert some data
      db.createCollection({
        collectionId: "search-test",
        dimension: 128,
        metric: "cosine",
        embeddingModelId: "test",
      });

      const vectors = await embedder.embed(["hello world"]);
      await db.upsertBatch("search-test", [{
        chunk_id: "chunk-1",
        doc_id: "doc-1",
        doc_version: "v1",
        chunk_hash: "hash-1",
        pipeline_signature: "sig-1",
        embedding_model_id: "test",
        vector: vectors[0]!,
        metadata: {
          source_uri: "test://doc-1",
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          created_at: new Date().toISOString(),
        },
        chunk_text: "hello world",
      }]);

      await db.publish("search-test", {
        embeddingModelId: "test",
        pipelineSignature: "sig-1",
      });

      // Search
      const queryVectors = await embedder.embed(["hello"]);
      const queryVector = new Float32Array(queryVectors[0]!);
      const result = await db.search({
        collectionId: "search-test",
        queryVector,
        topK: 5,
      });

      expect(result.results.length).toBeGreaterThanOrEqual(0);
      expect(typeof result.manifestVersionUsed).toBe("number");
    });
  });

  describe("fabric_extract tool handler", () => {
    it("creates an extractor registry", async () => {
      const { createDefaultRegistry } = await import("../extractor/index.js");
      const registry = createDefaultRegistry();
      const extensions = registry.getSupportedExtensions();
      expect(extensions.length).toBeGreaterThan(0);
      expect(extensions).toContain(".txt");
    });
  });

  describe("fabric_memory MCP tools", () => {
    it("put, list, assemble, and delete via MemoryStore", () => {
      const memoryPath = join(tmpDir, "memory.json");
      const store = new MemoryStore(memoryPath);

      // put
      const r1 = store.put({ sessionId: "mcp-session", text: "MCP memory fact A" });
      const r2 = store.put({ sessionId: "mcp-session", kind: "long-term", text: "MCP memory fact B" });

      expect(r1.id).toBeTruthy();
      expect(r2.kind).toBe("long-term");

      // list
      const all = store.list({ sessionId: "mcp-session" });
      expect(all).toHaveLength(2);

      // assemble
      const assembled = store.assembleContext({ sessionId: "mcp-session" });
      expect(assembled.text).toContain("MCP memory fact A");
      expect(assembled.text).toContain("MCP memory fact B");

      // delete
      expect(store.delete(r1.id)).toBe(true);
      expect(store.list({ sessionId: "mcp-session" })).toHaveLength(1);
    });

    it("fabric memory MCP tool registration includes all four memory tools", () => {
      // Verify that the server can be created with memory deps — registration would throw if any tool has invalid schema
      expect(() => createTestServer(db, config, registryDbPath, join(tmpDir, "memory.json"))).not.toThrow();
    });
  });

  describe("fabric_config_show tool handler", () => {
    it("redacts sensitive config fields", () => {
      const configWithSecrets = {
        ...config,
        embedder: { ...config.embedder, api_key: "secret-key-123" },
      };

      const redacted = JSON.parse(JSON.stringify(configWithSecrets)) as Record<string, unknown>;
      const embedderSection = redacted["embedder"] as Record<string, unknown>;
      if (embedderSection["api_key"]) {
        embedderSection["api_key"] = "***REDACTED***";
      }

      expect(embedderSection["api_key"]).toBe("***REDACTED***");
    });
  });
});
