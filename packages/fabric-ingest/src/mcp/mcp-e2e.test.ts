/**
 * E2E MCP client test — exercises tools end-to-end via InMemoryTransport.
 *
 * Spins up a full MCP server with AkiDB + mock embedder, connects a Client,
 * and exercises the create → upsert → publish → search → extract → chunk workflow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AkiDB } from "@ax-fabric/akidb";

import { registerAkiDbTools } from "./akidb-tools.js";
import { registerFabricTools } from "./fabric-tools.js";
import { registerResources } from "./resources.js";
import { MockEmbedder } from "../embedder/index.js";
import type { FabricConfig } from "../cli/config-loader.js";
import type { EmbedderProvider } from "@ax-fabric/contracts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createConfig(tmpDir: string): FabricConfig {
  return {
    fabric: { data_root: tmpDir, max_storage_gb: 50 },
    akidb: { root: tmpDir, collection: "e2e-test", metric: "cosine", dimension: 128 },
    retrieval: { default_layer: "auto", semantic_collection_suffix: "-semantic" },
    ingest: {
      sources: [{ path: join(tmpDir, "docs") }],
      scan: { mode: "incremental", fingerprint: "sha256" },
      chunking: { chunk_size: 2800, overlap: 0.15, strategy: "auto" },
    },
    embedder: { type: "local", model_id: "test-embed", dimension: 128, batch_size: 64 },
  };
}

async function setupE2e(embedderOverride?: EmbedderProvider) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
  const docsDir = join(tmpDir, "docs");
  rmSync(docsDir, { recursive: true, force: true });
  mkdtempSync(docsDir + "-"); // ensure parent exists
  // Actually create the docs dir
  const { mkdirSync } = await import("node:fs");
  mkdirSync(docsDir, { recursive: true });

  const config = createConfig(tmpDir);
  const registryDbPath = join(tmpDir, "registry.db");
  const db = new AkiDB({ storagePath: tmpDir });
  const embedder = embedderOverride ?? new MockEmbedder({ modelId: "test-embed", dimension: 128 });

  // Create MCP server
  const server = new McpServer(
    { name: "ax-fabric-e2e", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  registerAkiDbTools(server, db);
  registerFabricTools(server, { db, embedder, config, registryDbPath, memoryStorePath: join(tmpDir, "memory.json") });
  registerResources(server, { db, config, registryDbPath });

  // Create linked in-memory transports
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Create client
  const client = new Client({ name: "e2e-test-client", version: "2.0.0" });

  // Connect both sides
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { tmpDir, db, client, server, docsDir, clientTransport, serverTransport };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MCP E2E", () => {
  let tmpDir: string;
  let db: AkiDB;
  let client: Client;
  let docsDir: string;

  beforeEach(async () => {
    const setup = await setupE2e();
    tmpDir = setup.tmpDir;
    db = setup.db;
    client = setup.client;
    docsDir = setup.docsDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists available tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    // Should have all 28 tools (9 akidb + 15 fabric/workflow + 4 fabric_memory)
    expect(toolNames.length).toBe(28);
    expect(toolNames).toContain("akidb_create_collection");
    expect(toolNames).toContain("akidb_search");
    expect(toolNames).toContain("fabric_search");
    expect(toolNames).toContain("fabric_ingest_run");
    expect(toolNames).toContain("fabric_config_show");
    expect(toolNames).toContain("fabric_semantic_store_bundle");
    expect(toolNames).toContain("fabric_semantic_publish_bundle");
  });

  it("lists available resources", async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
  });

  it("create → upsert → publish → search full cycle", async () => {
    // 1. Create collection
    const createResult = await client.callTool({
      name: "akidb_create_collection",
      arguments: {
        collection_id: "mcp-e2e",
        dimension: 128,
        metric: "cosine",
        embedding_model_id: "test-embed",
      },
    });
    expect(createResult.isError).toBeFalsy();
    const createData = JSON.parse((createResult.content as Array<{ text: string }>)[0]!.text);
    expect(createData.collection_id).toBe("mcp-e2e");

    // 2. List collections — should contain our new one
    const listResult = await client.callTool({
      name: "akidb_list_collections",
      arguments: {},
    });
    const listData = JSON.parse((listResult.content as Array<{ text: string }>)[0]!.text) as Array<{ collection_id: string }>;
    expect(listData.map((c) => c.collection_id)).toContain("mcp-e2e");

    // 3. Embed some text
    const embedResult = await client.callTool({
      name: "fabric_embed",
      arguments: { texts: ["quantum physics", "machine learning", "cooking recipes"] },
    });
    expect(embedResult.isError).toBeFalsy();
    const embedData = JSON.parse((embedResult.content as Array<{ text: string }>)[0]!.text);
    expect(embedData.count).toBe(3);
    expect(embedData.dimension).toBe(128);

    // 4. Upsert records
    const upsertResult = await client.callTool({
      name: "akidb_upsert",
      arguments: {
        collection_id: "mcp-e2e",
        records: [
          { chunk_id: "c1", doc_id: "d1", vector: Array.from({ length: 128 }, () => Math.random()), metadata: { topic: "physics" }, chunk_text: "quantum physics" },
          { chunk_id: "c2", doc_id: "d2", vector: Array.from({ length: 128 }, () => Math.random()), metadata: { topic: "ml" }, chunk_text: "machine learning" },
          { chunk_id: "c3", doc_id: "d3", vector: Array.from({ length: 128 }, () => Math.random()), metadata: { topic: "food" }, chunk_text: "cooking recipes" },
        ],
      },
    });
    expect(upsertResult.isError).toBeFalsy();

    // 5. Publish
    const publishResult = await client.callTool({
      name: "akidb_publish",
      arguments: {
        collection_id: "mcp-e2e",
        embedding_model_id: "test-embed",
        pipeline_signature: "e2e-test-sig",
      },
    });
    expect(publishResult.isError).toBeFalsy();
    const publishData = JSON.parse((publishResult.content as Array<{ text: string }>)[0]!.text);
    expect(publishData.version).toBe(0);

    // 6. Search (via akidb_search)
    const searchResult = await client.callTool({
      name: "akidb_search",
      arguments: {
        collection_id: "mcp-e2e",
        query_vector: Array.from({ length: 128 }, () => Math.random()),
        top_k: 3,
      },
    });
    expect(searchResult.isError).toBeFalsy();
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0]!.text);
    expect(searchData.results.length).toBe(3);

    // 7. Collection status
    const statusResult = await client.callTool({
      name: "akidb_collection_status",
      arguments: { collection_id: "mcp-e2e" },
    });
    expect(statusResult.isError).toBeFalsy();
    const statusData = JSON.parse((statusResult.content as Array<{ text: string }>)[0]!.text);
    expect(statusData.collection.collection_id).toBe("mcp-e2e");
    expect(typeof statusData.storage_size_bytes).toBe("number");
  });

  it("fabric_chunk produces chunked output", async () => {
    // Default chunk_size is 2800; use text well above that to ensure multiple chunks
    const longText = "The quick brown fox jumps over the lazy dog. ".repeat(200);
    const result = await client.callTool({
      name: "fabric_chunk",
      arguments: { text: longText },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data.total_chunks).toBeGreaterThan(1);
    expect(data.chunks[0].text_length).toBeLessThanOrEqual(2800);
  });

  it("fabric_extract extracts a text file", async () => {
    const filePath = join(docsDir, "sample.txt");
    writeFileSync(filePath, "Hello from the MCP e2e test!\nSecond line.", "utf-8");

    const result = await client.callTool({
      name: "fabric_extract",
      arguments: { file_path: filePath },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data.text).toContain("Hello from the MCP e2e test!");
    expect(data.text_length).toBeGreaterThan(0);
  });

  it("fabric_config_show redacts api_key", async () => {
    const result = await client.callTool({
      name: "fabric_config_show",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data.akidb.collection).toBe("e2e-test");
    // Verify no raw api_key leaks
    if (data.embedder?.api_key) {
      expect(data.embedder.api_key).toBe("***REDACTED***");
    }
  });

  it("fabric_search keyword mode does not require embedding", async () => {
    const throwingEmbedder: EmbedderProvider = {
      modelId: "test-embed",
      dimension: 128,
      async embed(): Promise<number[][]> {
        throw new Error("embed should not be called for keyword mode");
      },
    };

    const setup = await setupE2e(throwingEmbedder);
    const keywordClient = setup.client;
    const keywordDb = setup.db;
    const keywordTmpDir = setup.tmpDir;

    try {
      keywordDb.createCollection({
        collectionId: "keyword-test",
        dimension: 128,
        metric: "cosine",
        embeddingModelId: "test-embed",
      });

      await keywordDb.upsertBatch("keyword-test", [{
        chunk_id: "keyword-chunk-1",
        doc_id: "keyword-doc-1",
        doc_version: "v1",
        chunk_hash: "keyword-hash-1",
        pipeline_signature: "keyword-sig",
        embedding_model_id: "test-embed",
        vector: Array.from({ length: 128 }, () => 0),
        metadata: {
          source_uri: "test://keyword-doc-1",
          content_type: "txt",
          page_range: null,
          offset: 0,
          table_ref: null,
          created_at: new Date().toISOString(),
        },
        chunk_text: "offline enterprise retrieval",
      }]);

      await keywordDb.publish("keyword-test", {
        embeddingModelId: "test-embed",
        pipelineSignature: "keyword-sig",
      });

      const result = await keywordClient.callTool({
        name: "fabric_search",
        arguments: {
          collection_id: "keyword-test",
          query: "enterprise",
          mode: "keyword",
          top_k: 3,
        },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(data.results).toHaveLength(1);
    } finally {
      keywordDb.close();
      rmSync(keywordTmpDir, { recursive: true, force: true });
    }
  });

  it("runs the semantic MCP workflow: store -> approve -> publish", async () => {
    const filePath = join(docsDir, "semantic-guide.txt");
    writeFileSync(
      filePath,
      "Semantic MCP workflow should create a reviewable bundle, approve it, and publish it into semantic retrieval.",
      "utf-8",
    );

    const storeResult = await client.callTool({
      name: "fabric_semantic_store_bundle",
      arguments: {
        file_path: filePath,
        low_quality_threshold: 0.5,
      },
    });
    expect(storeResult.isError).toBeFalsy();
    const stored = JSON.parse((storeResult.content as Array<{ text: string }>)[0]!.text) as {
      bundle_id: string;
      review_status: string;
    };
    expect(stored.review_status).toBe("pending");

    const approveResult = await client.callTool({
      name: "fabric_semantic_approve_bundle",
      arguments: {
        bundle_id: stored.bundle_id,
        reviewer: "mcp-tester",
        min_quality_score: 0.5,
        duplicate_policy: "warn",
      },
    });
    expect(approveResult.isError).toBeFalsy();
    const approved = JSON.parse((approveResult.content as Array<{ text: string }>)[0]!.text) as {
      review: { status: string };
    };
    expect(approved.review.status).toBe("approved");

    const publishResult = await client.callTool({
      name: "fabric_semantic_publish_bundle",
      arguments: {
        bundle_id: stored.bundle_id,
      },
    });
    expect(publishResult.isError).toBeFalsy();
    const published = JSON.parse((publishResult.content as Array<{ text: string }>)[0]!.text) as {
      collection_id: string;
      manifest_version: number;
    };
    expect(published.collection_id).toBe("e2e-test-semantic");
    expect(typeof published.manifest_version).toBe("number");

    const inspectResult = await client.callTool({
      name: "fabric_semantic_inspect_bundle",
      arguments: {
        bundle_id: stored.bundle_id,
      },
    });
    expect(inspectResult.isError).toBeFalsy();
    const inspected = JSON.parse((inspectResult.content as Array<{ text: string }>)[0]!.text) as {
      publication: { collectionId: string } | null;
    };
    expect(inspected.publication?.collectionId).toBe("e2e-test-semantic");
  });

  it("replaces a published semantic bundle with a single manifest advance through MCP", async () => {
    const filePath = join(docsDir, "semantic-replace.txt");
    writeFileSync(filePath, "Shared semantic document for MCP replace flow.");

    const firstStore = await client.callTool({
      name: "fabric_semantic_store_bundle",
      arguments: {
        file_path: filePath,
        low_quality_threshold: 0.5,
      },
    });
    const firstStored = JSON.parse((firstStore.content as Array<{ text: string }>)[0]!.text) as { bundle_id: string };
    await client.callTool({
      name: "fabric_semantic_approve_bundle",
      arguments: {
        bundle_id: firstStored.bundle_id,
        reviewer: "mcp-tester",
        min_quality_score: 0.5,
        duplicate_policy: "warn",
      },
    });
    const firstPublish = await client.callTool({
      name: "fabric_semantic_publish_bundle",
      arguments: {
        bundle_id: firstStored.bundle_id,
      },
    });
    const firstPublished = JSON.parse((firstPublish.content as Array<{ text: string }>)[0]!.text) as {
      manifest_version: number;
    };

    writeFileSync(filePath, "Shared semantic document for MCP replace flow with updated content.");

    const secondStore = await client.callTool({
      name: "fabric_semantic_store_bundle",
      arguments: {
        file_path: filePath,
        low_quality_threshold: 0.5,
      },
    });
    const secondStored = JSON.parse((secondStore.content as Array<{ text: string }>)[0]!.text) as { bundle_id: string };
    await client.callTool({
      name: "fabric_semantic_approve_bundle",
      arguments: {
        bundle_id: secondStored.bundle_id,
        reviewer: "mcp-tester",
        min_quality_score: 0.5,
        duplicate_policy: "warn",
      },
    });
    const secondPublish = await client.callTool({
      name: "fabric_semantic_publish_bundle",
      arguments: {
        bundle_id: secondStored.bundle_id,
        replace_existing: true,
      },
    });
    expect(secondPublish.isError).toBeFalsy();
    const secondPublished = JSON.parse((secondPublish.content as Array<{ text: string }>)[0]!.text) as {
      manifest_version: number;
    };

    expect(secondPublished.manifest_version).toBe(firstPublished.manifest_version + 1);
  });

  it("fabric_ingest_diff returns change detection results", async () => {
    // Write a test file to scan
    writeFileSync(join(docsDir, "test.txt"), "content for diff test", "utf-8");

    const result = await client.callTool({
      name: "fabric_ingest_diff",
      arguments: { source_paths: [docsDir] },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data.total_files).toBeGreaterThanOrEqual(1);
    expect(data.added).toBeGreaterThanOrEqual(1);
  });

  it("akidb_delete_chunks removes records", async () => {
    // Setup: create, upsert, publish
    await client.callTool({
      name: "akidb_create_collection",
      arguments: { collection_id: "del-test", dimension: 128, metric: "cosine", embedding_model_id: "test" },
    });
    await client.callTool({
      name: "akidb_upsert",
      arguments: {
        collection_id: "del-test",
        records: [
          { chunk_id: "del-c1", doc_id: "d1", vector: Array.from({ length: 128 }, () => Math.random()), metadata: {}, chunk_text: "text1" },
          { chunk_id: "del-c2", doc_id: "d2", vector: Array.from({ length: 128 }, () => Math.random()), metadata: {}, chunk_text: "text2" },
        ],
      },
    });
    await client.callTool({
      name: "akidb_publish",
      arguments: { collection_id: "del-test", embedding_model_id: "test", pipeline_signature: "sig" },
    });

    // Delete one chunk
    const deleteResult = await client.callTool({
      name: "akidb_delete_chunks",
      arguments: { collection_id: "del-test", chunk_ids: ["del-c1"] },
    });
    expect(deleteResult.isError).toBeFalsy();

    // Re-publish and search — should only find 1 result
    await client.callTool({
      name: "akidb_publish",
      arguments: { collection_id: "del-test", embedding_model_id: "test", pipeline_signature: "sig2" },
    });
    const searchResult = await client.callTool({
      name: "akidb_search",
      arguments: {
        collection_id: "del-test",
        query_vector: Array.from({ length: 128 }, () => Math.random()),
        top_k: 10,
      },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0]!.text);
    expect(searchData.results.length).toBe(1);
    expect(searchData.results[0].chunkId).toBe("del-c2");
  });

  it("akidb_rollback restores previous manifest", async () => {
    // Setup
    await client.callTool({
      name: "akidb_create_collection",
      arguments: { collection_id: "rb-test", dimension: 128, metric: "cosine", embedding_model_id: "test" },
    });

    // Upsert + publish v1 — capture manifest_id
    await client.callTool({
      name: "akidb_upsert",
      arguments: {
        collection_id: "rb-test",
        records: [{ chunk_id: "rb-c1", doc_id: "d1", vector: Array.from({ length: 128 }, () => Math.random()), metadata: {}, chunk_text: "v1" }],
      },
    });
    const v1PublishResult = await client.callTool({
      name: "akidb_publish",
      arguments: { collection_id: "rb-test", embedding_model_id: "test", pipeline_signature: "sig1" },
    });
    const v1Manifest = JSON.parse((v1PublishResult.content as Array<{ text: string }>)[0]!.text);
    const v1ManifestId = v1Manifest.manifest_id as string;

    // Upsert + publish v2
    await client.callTool({
      name: "akidb_upsert",
      arguments: {
        collection_id: "rb-test",
        records: [{ chunk_id: "rb-c2", doc_id: "d2", vector: Array.from({ length: 128 }, () => Math.random()), metadata: {}, chunk_text: "v2" }],
      },
    });
    await client.callTool({
      name: "akidb_publish",
      arguments: { collection_id: "rb-test", embedding_model_id: "test", pipeline_signature: "sig2" },
    });

    // Rollback to v1 manifest
    const rollbackResult = await client.callTool({
      name: "akidb_rollback",
      arguments: { collection_id: "rb-test", manifest_id: v1ManifestId },
    });
    expect(rollbackResult.isError).toBeFalsy();

    // Search should only find v1 record
    const searchResult = await client.callTool({
      name: "akidb_search",
      arguments: {
        collection_id: "rb-test",
        query_vector: Array.from({ length: 128 }, () => Math.random()),
        top_k: 10,
      },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0]!.text);
    expect(searchData.results.length).toBe(1);
    expect(searchData.results[0].chunkId).toBe("rb-c1");
  });
});
