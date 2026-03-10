/**
 * Unit tests for processDeletedFiles and processModifiedFiles.
 *
 * Both AkiDB and JobRegistry are mocked — these tests verify the
 * lifecycle coordination logic without touching the database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AkiDB } from "@ax-fabric/akidb";
import type { JobRegistry } from "../registry/index.js";
import { processDeletedFiles, processModifiedFiles } from "./lifecycle.js";

/* ================================================================== */
/*  Mock helpers                                                      */
/* ================================================================== */

function makeAkiDB(): AkiDB {
  return {
    deleteChunks: vi.fn(),
  } as unknown as AkiDB;
}

function makeRegistry(
  files: Record<string, { chunkIds: string[] }>,
): JobRegistry {
  const store = new Map(Object.entries(files));

  return {
    getFile: vi.fn((path: string) => store.get(path) ?? null),
    deleteFile: vi.fn((path: string) => { store.delete(path); }),
  } as unknown as JobRegistry;
}

/* ================================================================== */
/*  processDeletedFiles                                               */
/* ================================================================== */

describe("processDeletedFiles", () => {
  let akidb: AkiDB;
  let registry: JobRegistry;

  beforeEach(() => {
    akidb = makeAkiDB();
  });

  it("tombstones chunks for each deleted file", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["chunk-1", "chunk-2"] },
      "/path/b.txt": { chunkIds: ["chunk-3"] },
    });

    const result = processDeletedFiles(akidb, "col1", registry, ["/path/a.txt", "/path/b.txt"]);

    expect(akidb.deleteChunks).toHaveBeenCalledTimes(2);
    expect(akidb.deleteChunks).toHaveBeenCalledWith("col1", ["chunk-1", "chunk-2"], "file_deleted");
    expect(akidb.deleteChunks).toHaveBeenCalledWith("col1", ["chunk-3"], "file_deleted");
    expect(result.tombstoned).toBe(3);
  });

  it("removes files from registry after tombstoning", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["chunk-1"] },
    });

    processDeletedFiles(akidb, "col1", registry, ["/path/a.txt"]);

    expect(registry.deleteFile).toHaveBeenCalledWith("/path/a.txt");
  });

  it("populates deletedFiles in result", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["chunk-1"] },
      "/path/b.txt": { chunkIds: ["chunk-2"] },
    });

    const result = processDeletedFiles(akidb, "col1", registry, ["/path/a.txt", "/path/b.txt"]);

    expect(result.deletedFiles).toContain("/path/a.txt");
    expect(result.deletedFiles).toContain("/path/b.txt");
  });

  it("skips files not found in registry", () => {
    registry = makeRegistry({});

    const result = processDeletedFiles(akidb, "col1", registry, ["/path/ghost.txt"]);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    expect(result.deletedFiles).toHaveLength(0);
  });

  it("skips deleteChunks call when file has no chunks", () => {
    registry = makeRegistry({
      "/path/empty.txt": { chunkIds: [] },
    });

    const result = processDeletedFiles(akidb, "col1", registry, ["/path/empty.txt"]);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    // File is still removed from registry
    expect(registry.deleteFile).toHaveBeenCalledWith("/path/empty.txt");
  });

  it("handles empty deletedPaths list", () => {
    registry = makeRegistry({ "/path/a.txt": { chunkIds: ["c1"] } });

    const result = processDeletedFiles(akidb, "col1", registry, []);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    expect(result.deletedFiles).toHaveLength(0);
  });

  it("returns empty modifiedFiles array", () => {
    registry = makeRegistry({ "/path/a.txt": { chunkIds: ["c1"] } });
    const result = processDeletedFiles(akidb, "col1", registry, ["/path/a.txt"]);
    expect(result.modifiedFiles).toEqual([]);
  });

  it("counts tombstones correctly across multiple files", () => {
    registry = makeRegistry({
      "/f1.txt": { chunkIds: ["a", "b", "c"] },
      "/f2.txt": { chunkIds: ["d", "e"] },
      "/f3.txt": { chunkIds: [] },
    });

    const result = processDeletedFiles(akidb, "col", registry, ["/f1.txt", "/f2.txt", "/f3.txt"]);

    expect(result.tombstoned).toBe(5);
  });

  it("uses the supplied collectionId for deleteChunks", () => {
    registry = makeRegistry({ "/f.txt": { chunkIds: ["c1"] } });

    processDeletedFiles(akidb, "my-collection", registry, ["/f.txt"]);

    expect(akidb.deleteChunks).toHaveBeenCalledWith("my-collection", ["c1"], "file_deleted");
  });
});

/* ================================================================== */
/*  processModifiedFiles                                              */
/* ================================================================== */

describe("processModifiedFiles", () => {
  let akidb: AkiDB;
  let registry: JobRegistry;

  beforeEach(() => {
    akidb = makeAkiDB();
  });

  it("tombstones old chunks for each known modified file", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["old-chunk-1", "old-chunk-2"] },
    });

    processModifiedFiles(akidb, "col1", registry, ["/path/a.txt"]);

    expect(akidb.deleteChunks).toHaveBeenCalledWith("col1", ["old-chunk-1", "old-chunk-2"], "file_updated");
  });

  it("removes file from registry to allow re-ingest", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["c1"] },
    });

    processModifiedFiles(akidb, "col1", registry, ["/path/a.txt"]);

    expect(registry.deleteFile).toHaveBeenCalledWith("/path/a.txt");
  });

  it("populates modifiedFiles in result for known files", () => {
    registry = makeRegistry({
      "/path/a.txt": { chunkIds: ["c1"] },
    });

    const result = processModifiedFiles(akidb, "col1", registry, ["/path/a.txt"]);

    expect(result.modifiedFiles).toContain("/path/a.txt");
  });

  it("includes unknown files (not in registry) in modifiedFiles without tombstoning", () => {
    registry = makeRegistry({});

    const result = processModifiedFiles(akidb, "col1", registry, ["/path/new.txt"]);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.modifiedFiles).toContain("/path/new.txt");
  });

  it("skips deleteChunks when file has no chunks", () => {
    registry = makeRegistry({
      "/path/empty.txt": { chunkIds: [] },
    });

    const result = processModifiedFiles(akidb, "col1", registry, ["/path/empty.txt"]);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    // File is still deleted from registry and added to modifiedFiles
    expect(registry.deleteFile).toHaveBeenCalledWith("/path/empty.txt");
    expect(result.modifiedFiles).toContain("/path/empty.txt");
  });

  it("handles empty modifiedPaths list", () => {
    registry = makeRegistry({ "/path/a.txt": { chunkIds: ["c1"] } });

    const result = processModifiedFiles(akidb, "col1", registry, []);

    expect(akidb.deleteChunks).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    expect(result.modifiedFiles).toHaveLength(0);
  });

  it("returns empty deletedFiles array", () => {
    registry = makeRegistry({ "/path/a.txt": { chunkIds: ["c1"] } });
    const result = processModifiedFiles(akidb, "col1", registry, ["/path/a.txt"]);
    expect(result.deletedFiles).toEqual([]);
  });

  it("counts tombstones correctly across multiple modified files", () => {
    registry = makeRegistry({
      "/f1.txt": { chunkIds: ["a", "b"] },
      "/f2.txt": { chunkIds: ["c"] },
    });

    const result = processModifiedFiles(akidb, "col", registry, ["/f1.txt", "/f2.txt"]);

    expect(result.tombstoned).toBe(3);
  });

  it("mixes known and unknown files in one call", () => {
    registry = makeRegistry({
      "/known.txt": { chunkIds: ["c1", "c2"] },
    });

    const result = processModifiedFiles(akidb, "col", registry, [
      "/known.txt",
      "/unknown.txt",
    ]);

    expect(akidb.deleteChunks).toHaveBeenCalledOnce();
    expect(result.tombstoned).toBe(2);
    expect(result.modifiedFiles).toContain("/known.txt");
    expect(result.modifiedFiles).toContain("/unknown.txt");
  });

  it("uses the supplied collectionId for deleteChunks", () => {
    registry = makeRegistry({ "/f.txt": { chunkIds: ["c1"] } });

    processModifiedFiles(akidb, "my-collection", registry, ["/f.txt"]);

    expect(akidb.deleteChunks).toHaveBeenCalledWith("my-collection", ["c1"], "file_updated");
  });
});
