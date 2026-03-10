/**
 * File lifecycle manager — handles file modifications and deletions.
 *
 * Integrates with SourceScanner's ChangeSet output to:
 * - Tombstone chunks from deleted files
 * - Tombstone old chunks and re-ingest modified files
 */

import type { AkiDB } from "@ax-fabric/akidb";
import type { JobRegistry } from "../registry/index.js";

export interface LifecycleResult {
  tombstoned: number;
  deletedFiles: string[];
  modifiedFiles: string[];
}

/**
 * Process deleted files: tombstone all their chunks.
 */
export function processDeletedFiles(
  akidb: AkiDB,
  collectionId: string,
  registry: JobRegistry,
  deletedPaths: string[],
): LifecycleResult {
  let tombstoned = 0;
  const deletedFiles: string[] = [];

  for (const path of deletedPaths) {
    const record = registry.getFile(path);
    if (!record) continue;

    if (record.chunkIds.length > 0) {
      akidb.deleteChunks(collectionId, record.chunkIds, "file_deleted");
      tombstoned += record.chunkIds.length;
    }

    registry.deleteFile(path);
    deletedFiles.push(path);
  }

  return { tombstoned, deletedFiles, modifiedFiles: [] };
}

/**
 * Process modified files: tombstone old chunks (re-ingestion handled by pipeline).
 *
 * Returns the paths that were successfully tombstoned and are ready for re-ingestion.
 */
export function processModifiedFiles(
  akidb: AkiDB,
  collectionId: string,
  registry: JobRegistry,
  modifiedPaths: string[],
): LifecycleResult {
  let tombstoned = 0;
  const modifiedFiles: string[] = [];

  for (const path of modifiedPaths) {
    const record = registry.getFile(path);
    if (!record) {
      modifiedFiles.push(path);
      continue;
    }

    if (record.chunkIds.length > 0) {
      akidb.deleteChunks(collectionId, record.chunkIds, "file_updated");
      tombstoned += record.chunkIds.length;
    }

    // Delete old record — pipeline will re-create on successful re-ingest.
    registry.deleteFile(path);
    modifiedFiles.push(path);
  }

  return { tombstoned, deletedFiles: [], modifiedFiles };
}
