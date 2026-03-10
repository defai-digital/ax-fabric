/**
 * Job Registry (Layer 2.8) — SQLite-backed tracking of ingested files
 * for idempotent re-runs and change detection.
 */

import { JobRegistryNative } from "@ax-fabric/akidb-native";

import { AxFabricError } from "@ax-fabric/contracts";

export interface FileRecord {
  sourcePath: string;
  fingerprint: string;
  sizeBytes: number;
  mtimeMs: number;
  docId: string;
  docVersion: string;
  chunkIds: string[];
  lastIngestAt: string;
  status: "success" | "error";
  errorMessage?: string;
}

export interface KnownFileState {
  fingerprint: string;
  sizeBytes: number;
  mtimeMs: number;
}

export class JobRegistry {
  private readonly native: JobRegistryNative;
  private closed = false;

  constructor(dbPath: string) {
    try {
      this.native = new JobRegistryNative(dbPath);
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        `Failed to open job registry at ${dbPath}`,
        err,
      );
    }
  }

  /** Retrieve a file record by source path, or null if not found. */
  getFile(sourcePath: string): FileRecord | null {
    try {
      const json = this.native.getFile(sourcePath);
      if (!json) {
        return null;
      }
      return normalizeRecord(JSON.parse(json) as FileRecord);
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        `Failed to load file record for ${sourcePath}`,
        err,
      );
    }
  }

  /** Insert or update a file record. */
  upsertFile(record: FileRecord): void {
    try {
      this.native.upsertFile(JSON.stringify(record));
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        `Failed to upsert file record for ${record.sourcePath}`,
        err,
      );
    }
  }

  /** Delete a file record by source path. */
  deleteFile(sourcePath: string): void {
    try {
      this.native.deleteFile(sourcePath);
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        `Failed to delete file record for ${sourcePath}`,
        err,
      );
    }
  }

  /** List all file records. */
  listFiles(): FileRecord[] {
    try {
      const json = this.native.listFiles();
      return (JSON.parse(json) as FileRecord[]).map(normalizeRecord);
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        "Failed to list file records",
        err,
      );
    }
  }

  /**
   * Return a Map of sourcePath -> fingerprint for all tracked files.
   * Used by the SourceScanner for efficient change detection.
   */
  getKnownFingerprints(): Map<string, string> {
    try {
      const json = this.native.getKnownFingerprints();
      const entries = Object.entries(JSON.parse(json) as Record<string, string>);
      return new Map<string, string>(entries);
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        "Failed to load known file fingerprints",
        err,
      );
    }
  }

  getKnownFileStates(): Map<string, KnownFileState> {
    const withKnownStates = this.native as JobRegistryNative & {
      getKnownFileStates?: () => string;
    };
    if (typeof withKnownStates.getKnownFileStates !== "function") {
      const fingerprints = this.getKnownFingerprints();
      const fallback = new Map<string, KnownFileState>();
      for (const [sourcePath, fingerprint] of fingerprints) {
        fallback.set(sourcePath, { fingerprint, sizeBytes: 0, mtimeMs: 0 });
      }
      return fallback;
    }
    try {
      const json = withKnownStates.getKnownFileStates();
      const raw = JSON.parse(json) as Record<string, KnownFileState>;
      return new Map<string, KnownFileState>(Object.entries(raw));
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        "Failed to load known file states",
        err,
      );
    }
  }

  /** Close the database, releasing all resources. Safe to call multiple times. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.native.close();
    } catch (err) {
      throw new AxFabricError(
        "STATE_ERROR",
        "Failed to close job registry",
        err,
      );
    }
  }
}

function normalizeRecord(record: FileRecord): FileRecord {
  const raw = record as FileRecord & { errorMessage?: string | null; sizeBytes?: number; mtimeMs?: number };
  const normalized: FileRecord = {
    ...record,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    mtimeMs: typeof raw.mtimeMs === "number" ? raw.mtimeMs : 0,
  };
  if (raw.errorMessage === null) {
    return { ...normalized, errorMessage: undefined };
  }
  return normalized;
}
