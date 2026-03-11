/**
 * Tests for Layer 2.7 — Batch Publisher.
 *
 * Uses a real AkiDB instance with :memory: SQLite and a temp directory
 * for segment storage.
 */

import { AkiDB } from "@ax-fabric/akidb";
import type { Record as AkiRecord, RecordMetadata, Tombstone } from "@ax-fabric/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BatchPublisher } from "./batch-publisher.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DIM = 4;
const COL_ID = "publisher-test";
const EMBEDDING_MODEL = "test-embed-v1";
const PIPELINE_SIG = "sha256:test-pipe-v1";

function makeMetadata(index: number): RecordMetadata {
  return {
    source_uri: `file://doc-${String(index)}.txt`,
    content_type: "txt",
    page_range: null,
    offset: index,
    table_ref: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeRecord(index: number): AkiRecord {
  return {
    chunk_id: `chunk-${String(index).padStart(3, "0")}`,
    doc_id: `doc-${String(index)}`,
    doc_version: "1.0.0",
    chunk_hash: `hash-${String(index)}`,
    pipeline_signature: PIPELINE_SIG,
    embedding_model_id: EMBEDDING_MODEL,
    vector: Array.from({ length: DIM }, (_, d) => (index + 1) * 0.1 + d * 0.01),
    metadata: makeMetadata(index),
  };
}

function makeTombstone(chunkId: string): Tombstone {
  return {
    chunk_id: chunkId,
    deleted_at: new Date().toISOString(),
    reason_code: "file_updated",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("BatchPublisher", () => {
  let tmpDir: string;
  let db: AkiDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "batch-publisher-"));
    db = new AkiDB({
      storagePath: join(tmpDir, "storage"),
    });

    db.createCollection({
      collectionId: COL_ID,
      dimension: DIM,
      metric: "cosine",
      embeddingModelId: EMBEDDING_MODEL,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePublisher(overrides?: { maxRecords?: number }): BatchPublisher {
    return new BatchPublisher({
      collectionId: COL_ID,
      akidb: db,
      maxRecords: overrides?.maxRecords,
      embeddingModelId: EMBEDDING_MODEL,
      pipelineSignature: PIPELINE_SIG,
    });
  }

  it("accumulates records and reports pending count", async () => {
    const publisher = makePublisher();
    const records = Array.from({ length: 5 }, (_, i) => makeRecord(i));

    await publisher.addRecords(records);
    expect(publisher.getPendingCount()).toBe(5);
  });

  it("auto-flushes when buffer reaches maxRecords", async () => {
    const publisher = makePublisher({ maxRecords: 3 });

    await publisher.addRecords(Array.from({ length: 5 }, (_, i) => makeRecord(i)));

    // 3 flushed, 2 remaining
    expect(publisher.getPendingCount()).toBe(2);
  });

  it("flush empties the buffer and returns segment IDs", async () => {
    const publisher = makePublisher();
    await publisher.addRecords(Array.from({ length: 3 }, (_, i) => makeRecord(i)));

    const result = await publisher.flush();
    expect(publisher.getPendingCount()).toBe(0);
    expect(result.segmentIds.length).toBeGreaterThan(0);
  });

  it("flush on empty buffer returns empty segment IDs", async () => {
    const publisher = makePublisher();
    const result = await publisher.flush();
    expect(result.segmentIds).toEqual([]);
  });

  it("publish flushes records and creates a manifest", async () => {
    const publisher = makePublisher();
    const records = Array.from({ length: 5 }, (_, i) => makeRecord(i));

    await publisher.addRecords(records);
    const result = await publisher.publish();

    expect(result.manifestVersion).toBe(0);
    expect(publisher.getPendingCount()).toBe(0);
  });

  it("publish applies tombstones", async () => {
    const publisher = makePublisher();

    // First publish: ingest records.
    await publisher.addRecords(Array.from({ length: 5 }, (_, i) => makeRecord(i)));
    await publisher.publish();

    // Second publish: add new records + tombstones.
    const pub2 = makePublisher();
    await pub2.addRecords(Array.from({ length: 2 }, (_, i) => makeRecord(i + 10)));
    pub2.addTombstones([makeTombstone("chunk-001"), makeTombstone("chunk-002")]);

    const result = await pub2.publish();
    expect(result.manifestVersion).toBe(1);

    // Search should exclude tombstoned chunks.
    const searchResult = await db.search({
      collectionId: COL_ID,
      queryVector: new Float32Array(Array.from({ length: DIM }, () => 0.5)),
      topK: 20,
    });

    const returnedIds = searchResult.results.map((r) => r.chunkId);
    expect(returnedIds).not.toContain("chunk-001");
    expect(returnedIds).not.toContain("chunk-002");
  });

  it("supports multiple publish cycles", async () => {
    const publisher = makePublisher();

    // Cycle 1
    await publisher.addRecords(Array.from({ length: 3 }, (_, i) => makeRecord(i)));
    const r1 = await publisher.publish();
    expect(r1.manifestVersion).toBe(0);

    // Cycle 2 — new publisher instance for fresh state
    const pub2 = makePublisher();
    await pub2.addRecords(Array.from({ length: 2 }, (_, i) => makeRecord(i + 10)));
    const r2 = await pub2.publish();
    expect(r2.manifestVersion).toBe(1);
  });

  it("handles large batches with auto-flush", async () => {
    const publisher = makePublisher({ maxRecords: 4 });
    const records = Array.from({ length: 10 }, (_, i) => makeRecord(i));

    await publisher.addRecords(records);
    // 10 records with maxRecords=4: should have flushed 2 batches (8), leaving 2
    expect(publisher.getPendingCount()).toBe(2);

    const result = await publisher.publish();
    expect(result.manifestVersion).toBe(0);
    expect(publisher.getPendingCount()).toBe(0);
  });

  it("maintains correct pending count across repeated flush cycles", async () => {
    const publisher = makePublisher({ maxRecords: 2 });
    const records = Array.from({ length: 12 }, (_, i) => makeRecord(i));

    for (const record of records) {
      await publisher.addRecords([record]);
      expect(publisher.getPendingCount()).toBeLessThan(2);
    }

    expect(publisher.getPendingCount()).toBe(0);
    const result = await publisher.publish();
    expect(result.manifestVersion).toBe(0);
    expect(publisher.getPendingCount()).toBe(0);
  });

  it("groups tombstones by reason code and issues separate deleteChunks calls", async () => {
    // First publish: ingest records to create chunks.
    const setup = makePublisher();
    await setup.addRecords(Array.from({ length: 4 }, (_, i) => makeRecord(i)));
    await setup.publish();

    // Second publish: mix file_deleted and file_updated tombstones.
    const publisher = makePublisher();
    publisher.addTombstones([
      { chunk_id: "chunk-000", deleted_at: new Date().toISOString(), reason_code: "file_deleted" },
      { chunk_id: "chunk-001", deleted_at: new Date().toISOString(), reason_code: "file_updated" },
      { chunk_id: "chunk-002", deleted_at: new Date().toISOString(), reason_code: "file_deleted" },
    ]);

    // publish should succeed — both reason groups are applied.
    const result = await publisher.publish();
    expect(result.manifestVersion).toBe(1);

    // Tombstoned chunks must not appear in search results.
    const searchResult = await db.search({
      collectionId: COL_ID,
      queryVector: new Float32Array(Array.from({ length: DIM }, () => 0.5)),
      topK: 20,
    });
    const returnedIds = searchResult.results.map((r) => r.chunkId);
    expect(returnedIds).not.toContain("chunk-000");
    expect(returnedIds).not.toContain("chunk-001");
    expect(returnedIds).not.toContain("chunk-002");
  });

  it("accumulates tombstones across multiple addTombstones calls", async () => {
    // Ingest some records first.
    const setup = makePublisher();
    await setup.addRecords(Array.from({ length: 3 }, (_, i) => makeRecord(i)));
    await setup.publish();

    const publisher = makePublisher();
    // Two separate addTombstones calls should both be applied on publish.
    publisher.addTombstones([makeTombstone("chunk-000")]);
    publisher.addTombstones([makeTombstone("chunk-001")]);

    const result = await publisher.publish();
    expect(result.manifestVersion).toBe(1);

    const searchResult = await db.search({
      collectionId: COL_ID,
      queryVector: new Float32Array(Array.from({ length: DIM }, () => 0.5)),
      topK: 20,
    });
    const ids = searchResult.results.map((r) => r.chunkId);
    expect(ids).not.toContain("chunk-000");
    expect(ids).not.toContain("chunk-001");
  });

  it("publish with zero records but pending tombstones still publishes a manifest", async () => {
    // Ingest records so there is something to tombstone.
    const setup = makePublisher();
    await setup.addRecords(Array.from({ length: 2 }, (_, i) => makeRecord(i)));
    await setup.publish();

    // New publisher: no records, but tombstones.
    const publisher = makePublisher();
    publisher.addTombstones([makeTombstone("chunk-000")]);

    const result = await publisher.publish();
    // manifest version increments regardless of record count.
    expect(result.manifestVersion).toBe(1);
    expect(result.segmentCount).toBe(0);
  });

  it("clears pending tombstones after a successful publish", async () => {
    const setup = makePublisher();
    await setup.addRecords(Array.from({ length: 2 }, (_, i) => makeRecord(i)));
    await setup.publish();

    const publisher = makePublisher();
    publisher.addTombstones([makeTombstone("chunk-000")]);
    await publisher.publish(); // first publish clears tombstones

    // Second publish should produce manifest version 2 with no extra tombstone error.
    const result = await publisher.publish();
    expect(result.manifestVersion).toBe(2);
  });
});
