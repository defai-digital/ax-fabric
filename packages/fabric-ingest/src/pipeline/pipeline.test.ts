import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AkiDB } from "@ax-fabric/akidb";
import { MockEmbedder } from "../embedder/index.js";
import { Pipeline } from "./pipeline.js";
import type { PipelineMetrics } from "./pipeline.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-test-"));
}

function createTestFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("Pipeline", () => {
  let sourceDir: string;
  let storageDir: string;
  let akidb: AkiDB;
  let embedder: MockEmbedder;
  let registryDbPath: string;

  beforeEach(() => {
    sourceDir = makeTmpDir();
    storageDir = makeTmpDir();
    const dbDir = makeTmpDir();
    registryDbPath = join(dbDir, "registry.db");

    akidb = new AkiDB({
      storagePath: storageDir,
    });

    akidb.createCollection({
      collectionId: "test-col",
      dimension: 128,
      metric: "cosine",
      embeddingModelId: "mock-embed-v1",
    });

    embedder = new MockEmbedder({ modelId: "mock-embed-v1", dimension: 128 });
  });

  afterEach(() => {
    akidb.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  function createPipeline(): Pipeline {
    return new Pipeline({
      sourcePaths: [sourceDir],
      akidb,
      collectionId: "test-col",
      embedder,
      registryDbPath,
    });
  }

  it("ingests new text files end-to-end", async () => {
    createTestFile(sourceDir, "hello.txt", "Hello world. This is a test document with enough content to be indexed.");
    createTestFile(sourceDir, "notes.txt", "Important notes about the project architecture and design decisions.");

    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesScanned).toBe(2);
    expect(metrics.filesAdded).toBe(2);
    expect(metrics.filesModified).toBe(0);
    expect(metrics.filesDeleted).toBe(0);
    expect(metrics.filesSucceeded).toBe(2);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
    expect(metrics.manifestVersion).toBe(0);
    expect(metrics.errors).toHaveLength(0);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent on unchanged files", async () => {
    createTestFile(sourceDir, "stable.txt", "This content will not change between runs.");

    const pipeline = createPipeline();
    const first = await pipeline.run([sourceDir]);
    expect(first.filesAdded).toBe(1);
    expect(first.recordsGenerated).toBeGreaterThan(0);

    // Second run with same content
    const second = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(second.filesScanned).toBe(1);
    expect(second.filesUnchanged).toBe(1);
    expect(second.filesAdded).toBe(0);
    expect(second.filesModified).toBe(0);
    expect(second.recordsGenerated).toBe(0);
    expect(second.manifestVersion).toBeNull(); // no publish needed
  });

  it("detects modified files and generates tombstones", async () => {
    const filePath = createTestFile(sourceDir, "mutable.txt", "Original content for this document.");

    const pipeline = createPipeline();
    const first = await pipeline.run([sourceDir]);
    expect(first.filesAdded).toBe(1);
    const firstRecords = first.recordsGenerated;

    // Modify the file
    writeFileSync(filePath, "Updated content that is completely different from the original text.");

    const second = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(second.filesModified).toBe(1);
    expect(second.filesAdded).toBe(0);
    expect(second.tombstonesGenerated).toBe(firstRecords); // tombstones for old chunks
    expect(second.recordsGenerated).toBeGreaterThan(0);
    expect(second.manifestVersion).toBeGreaterThan(0);
  });

  it("detects deleted files and generates tombstones", async () => {
    const filePath = createTestFile(sourceDir, "ephemeral.txt", "This file will be deleted after the first ingest.");

    const pipeline = createPipeline();
    const first = await pipeline.run([sourceDir]);
    expect(first.filesAdded).toBe(1);
    const firstRecords = first.recordsGenerated;

    // Delete the file
    unlinkSync(filePath);

    const second = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(second.filesScanned).toBe(0);
    expect(second.filesDeleted).toBe(1);
    expect(second.tombstonesGenerated).toBe(firstRecords);
    expect(second.recordsGenerated).toBe(0);
    expect(second.manifestVersion).toBeGreaterThan(0);
  });

  it("handles mixed adds, modifies, and deletes", async () => {
    const file1 = createTestFile(sourceDir, "keep.txt", "This file stays the same throughout the test.");
    const file2 = createTestFile(sourceDir, "change.txt", "This file will be modified in the second run.");
    const file3 = createTestFile(sourceDir, "remove.txt", "This file will be deleted before the second run.");

    const pipeline = createPipeline();
    const first = await pipeline.run([sourceDir]);
    expect(first.filesAdded).toBe(3);

    // Modify file2, delete file3, add file4
    writeFileSync(file2, "Modified content that replaces the original version of this file.");
    unlinkSync(file3);
    createTestFile(sourceDir, "new.txt", "A brand new file added in the second run of the pipeline.");

    const second = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(second.filesScanned).toBe(3); // keep, change, new
    expect(second.filesUnchanged).toBe(1); // keep
    expect(second.filesModified).toBe(1); // change
    expect(second.filesAdded).toBe(1); // new
    expect(second.filesDeleted).toBe(1); // remove
    expect(second.recordsGenerated).toBeGreaterThan(0);
    expect(second.tombstonesGenerated).toBeGreaterThan(0);
  });

  it("isolates per-file errors without blocking the batch", async () => {
    createTestFile(sourceDir, "good.txt", "This file will be ingested successfully without any issues.");
    // Create a file with an extension that maps to an extractor but has bad content
    // Use a subdirectory to simulate an unreadable file — create a .json with invalid JSON
    createTestFile(sourceDir, "bad.json", "this is not valid json {{{");

    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesScanned).toBe(2);
    expect(metrics.filesSucceeded).toBe(1); // good.txt
    expect(metrics.filesFailed).toBe(1); // bad.json
    expect(metrics.errors).toHaveLength(1);
    expect(metrics.errors[0]!.sourcePath).toContain("bad.json");
    expect(metrics.recordsGenerated).toBeGreaterThan(0); // from good.txt
  });

  it("handles empty source directories", async () => {
    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesScanned).toBe(0);
    expect(metrics.filesChanged).toBe(0);
    expect(metrics.recordsGenerated).toBe(0);
    expect(metrics.manifestVersion).toBeNull();
  });

  it("skips unsupported file extensions", async () => {
    createTestFile(sourceDir, "readme.md", "# Markdown file");
    createTestFile(sourceDir, "photo.png", "fake png bytes");
    createTestFile(sourceDir, "good.txt", "This text file should be processed by the pipeline.");

    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesScanned).toBe(1); // only .txt
    expect(metrics.filesAdded).toBe(1);
  });

  it("handles nested directory structures", async () => {
    mkdirSync(join(sourceDir, "subdir", "deep"), { recursive: true });
    createTestFile(sourceDir, "top.txt", "Top-level document with some content.");
    createTestFile(join(sourceDir, "subdir"), "mid.txt", "Mid-level document in a subdirectory.");
    createTestFile(join(sourceDir, "subdir", "deep"), "bottom.txt", "Deep-nested document for testing recursion.");

    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesScanned).toBe(3);
    expect(metrics.filesAdded).toBe(3);
    expect(metrics.filesSucceeded).toBe(3);
  });

  it("scans multiple source roots in a single run", async () => {
    const extraSourceDir = makeTmpDir();
    try {
      createTestFile(sourceDir, "root-a.txt", "Document from root A.");
      createTestFile(extraSourceDir, "root-b.txt", "Document from root B.");

      const pipeline = new Pipeline({
        sourcePaths: [sourceDir, extraSourceDir],
        akidb,
        collectionId: "test-col",
        embedder,
        registryDbPath,
      });
      const metrics = await pipeline.run();
      pipeline.close();

      expect(metrics.filesScanned).toBe(2);
      expect(metrics.filesAdded).toBe(2);
      expect(metrics.filesSucceeded).toBe(2);
    } finally {
      rmSync(extraSourceDir, { recursive: true, force: true });
    }
  });

  it("handles CSV files with row-to-text extraction", async () => {
    createTestFile(sourceDir, "data.csv", "name,age,city\nAlice,30,NYC\nBob,25,LA\n");

    const pipeline = createPipeline();
    const metrics = await pipeline.run([sourceDir]);
    pipeline.close();

    expect(metrics.filesAdded).toBe(1);
    expect(metrics.filesSucceeded).toBe(1);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
  });

  it("search returns results after ingestion", async () => {
    createTestFile(sourceDir, "searchable.txt", "The quick brown fox jumps over the lazy dog. This is a well-known pangram used for testing.");

    const pipeline = createPipeline();
    await pipeline.run([sourceDir]);
    pipeline.close();

    // Embed a query and search
    const queryVectors = await embedder.embed(["quick brown fox"]);
    const queryVector = new Float32Array(queryVectors[0]!);

    const searchResult = await akidb.search({
      collectionId: "test-col",
      queryVector,
      topK: 5,
    });

    expect(searchResult.results.length).toBeGreaterThan(0);
    expect(searchResult.manifestVersionUsed).toBe(0);
  });
});
