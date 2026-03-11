/**
 * Tests for Layer 2.8 — Job Registry.
 *
 * Uses SQLite :memory: database for isolation and speed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxFabricError } from "@ax-fabric/contracts";

import type { FileRecord } from "./job-registry.js";
import { JobRegistry } from "./job-registry.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFileRecord(overrides?: Partial<FileRecord>): FileRecord {
  return {
    sourcePath: "/docs/test.txt",
    fingerprint: "abc123hash",
    sizeBytes: 128,
    mtimeMs: 1_700_000_000_000,
    docId: "doc-001",
    docVersion: "v1",
    chunkIds: ["chunk-001", "chunk-002"],
    lastIngestAt: "2026-01-15T10:00:00.000Z",
    status: "success",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("JobRegistry", () => {
  let registry: JobRegistry;

  beforeEach(() => {
    registry = new JobRegistry(":memory:");
  });

  afterEach(() => {
    registry?.close();
  });

  // ─── getFile / upsertFile ───────────────────────────────────────────────

  it("returns null for unknown source path", () => {
    const result = registry.getFile("/nonexistent.txt");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a file record", () => {
    const record = makeFileRecord({ pipelineSignature: "sig-1" });
    registry.upsertFile(record);

    const retrieved = registry.getFile("/docs/test.txt");
    expect(retrieved).toEqual(record);
  });

  it("stores and retrieves chunkIds as a JSON array", () => {
    const record = makeFileRecord({
      chunkIds: ["a", "b", "c"],
    });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.chunkIds).toEqual(["a", "b", "c"]);
  });

  it("upserts (updates) an existing record", () => {
    const original = makeFileRecord();
    registry.upsertFile(original);

    const updated = makeFileRecord({
      fingerprint: "newhash",
      docVersion: "v2",
      pipelineSignature: "sig-2",
      chunkIds: ["chunk-003"],
      lastIngestAt: "2026-02-01T10:00:00.000Z",
    });
    registry.upsertFile(updated);

    const retrieved = registry.getFile("/docs/test.txt");
    expect(retrieved!.fingerprint).toBe("newhash");
    expect(retrieved!.docVersion).toBe("v2");
    expect(retrieved!.pipelineSignature).toBe("sig-2");
    expect(retrieved!.chunkIds).toEqual(["chunk-003"]);
  });

  it("stores error records with error messages", () => {
    const record = makeFileRecord({
      status: "error",
      errorMessage: "extraction failed: corrupt PDF",
    });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.status).toBe("error");
    expect(retrieved!.errorMessage).toBe("extraction failed: corrupt PDF");
  });

  it("stores success records without error messages", () => {
    const record = makeFileRecord({ status: "success" });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.errorMessage).toBeUndefined();
  });

  // ─── deleteFile ─────────────────────────────────────────────────────────

  it("deletes a file record", () => {
    registry.upsertFile(makeFileRecord());

    registry.deleteFile("/docs/test.txt");
    expect(registry.getFile("/docs/test.txt")).toBeNull();
  });

  it("silently ignores deletion of non-existent file", () => {
    // Should not throw.
    registry.deleteFile("/nonexistent.txt");
  });

  // ─── listFiles ────────────────────────────────────────────────────────

  it("lists all file records sorted by source path", () => {
    registry.upsertFile(makeFileRecord({ sourcePath: "/z/file.txt" }));
    registry.upsertFile(makeFileRecord({ sourcePath: "/a/file.txt" }));
    registry.upsertFile(makeFileRecord({ sourcePath: "/m/file.txt" }));

    const files = registry.listFiles();
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.sourcePath)).toEqual([
      "/a/file.txt",
      "/m/file.txt",
      "/z/file.txt",
    ]);
  });

  it("returns empty list when no files are registered", () => {
    expect(registry.listFiles()).toEqual([]);
  });

  // ─── getKnownFingerprints ──────────────────────────────────────────────

  it("returns a map of sourcePath -> fingerprint", () => {
    registry.upsertFile(
      makeFileRecord({ sourcePath: "/a.txt", fingerprint: "hash-a" }),
    );
    registry.upsertFile(
      makeFileRecord({ sourcePath: "/b.txt", fingerprint: "hash-b" }),
    );

    const map = registry.getKnownFingerprints();
    expect(map.size).toBe(2);
    expect(map.get("/a.txt")).toBe("hash-a");
    expect(map.get("/b.txt")).toBe("hash-b");
  });

  it("returns empty map when registry is empty", () => {
    const map = registry.getKnownFingerprints();
    expect(map.size).toBe(0);
  });

  it("returns known file states including size and mtime", () => {
    registry.upsertFile(
      makeFileRecord({
        sourcePath: "/state.txt",
        fingerprint: "state-hash",
        sizeBytes: 42,
        mtimeMs: 1234,
      }),
    );
    const map = registry.getKnownFileStates();
    expect(map.size).toBe(1);
    expect(map.get("/state.txt")).toEqual({
      fingerprint: "state-hash",
      sizeBytes: 42,
      mtimeMs: 1234,
    });
  });

  it("falls back to fingerprint map when native lacks known-file-state API", () => {
    const shim = {
      getKnownFingerprints: () => JSON.stringify({ "/legacy.txt": "legacy-hash" }),
      close: () => undefined,
    };
    (registry as unknown as { native: unknown }).native = shim;

    const map = registry.getKnownFileStates();
    expect(map.get("/legacy.txt")).toEqual({
      fingerprint: "legacy-hash",
      sizeBytes: 0,
      mtimeMs: 0,
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it("handles empty chunkIds array", () => {
    const record = makeFileRecord({ chunkIds: [] });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.chunkIds).toEqual([]);
  });

  it("handles special characters in source paths", () => {
    const record = makeFileRecord({
      sourcePath: "/docs/file with spaces & (parens).txt",
    });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.sourcePath).toBe("/docs/file with spaces & (parens).txt");
  });

  it("handles many chunk IDs in the JSON column", () => {
    const chunkIds = Array.from({ length: 1000 }, (_, i) => `chunk-${String(i)}`);
    const record = makeFileRecord({ chunkIds });
    registry.upsertFile(record);

    const retrieved = registry.getFile(record.sourcePath);
    expect(retrieved!.chunkIds).toHaveLength(1000);
    expect(retrieved!.chunkIds[999]).toBe("chunk-999");
  });

  it("supports concurrent registries on the same :memory: database", () => {
    // Each :memory: database is independent, so two registries should not
    // interfere with each other.
    const reg2 = new JobRegistry(":memory:");

    registry.upsertFile(makeFileRecord({ sourcePath: "/a.txt" }));
    expect(reg2.getFile("/a.txt")).toBeNull();

    reg2.close();
  });

  it("wraps listFiles native and JSON failures as STATE_ERROR", () => {
    (registry as unknown as { native: unknown }).native = {
      listFiles: () => "{not-json",
      close: () => undefined,
    };

    let thrown: unknown;
    try {
      registry.listFiles();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AxFabricError);
    expect((thrown as Error).message).toContain("Failed to list file records");
  });

  it("wraps known fingerprint/state failures as STATE_ERROR", () => {
    (registry as unknown as { native: unknown }).native = {
      getKnownFingerprints: () => {
        throw new Error("sqlite busy");
      },
      getKnownFileStates: () => "{bad-json",
      close: () => undefined,
    };

    let fingerprintError: unknown;
    try {
      registry.getKnownFingerprints();
    } catch (error) {
      fingerprintError = error;
    }
    expect(fingerprintError).toBeInstanceOf(AxFabricError);
    expect((fingerprintError as Error).message).toContain("Failed to load known file fingerprints");

    let stateError: unknown;
    try {
      registry.getKnownFileStates();
    } catch (error) {
      stateError = error;
    }
    expect(stateError).toBeInstanceOf(AxFabricError);
    expect((stateError as Error).message).toContain("Failed to load known file states");
  });

  it("wraps delete and close failures as STATE_ERROR", () => {
    (registry as unknown as { native: unknown }).native = {
      deleteFile: () => {
        throw new Error("disk io");
      },
      close: () => undefined,
    };

    let deleteError: unknown;
    try {
      registry.deleteFile("/docs/test.txt");
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError).toBeInstanceOf(AxFabricError);
    expect((deleteError as Error).message).toContain("Failed to delete file record");

    const closable = new JobRegistry(":memory:");
    (closable as unknown as { native: unknown }).native = {
      close: () => {
        throw new Error("close failed");
      },
    };

    let closeError: unknown;
    try {
      closable.close();
    } catch (error) {
      closeError = error;
    }
    expect(closeError).toBeInstanceOf(AxFabricError);
    expect((closeError as Error).message).toContain("Failed to close job registry");
  });
});
