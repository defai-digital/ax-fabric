/**
 * Batch Publisher (Layer 2.7) — accumulates Record objects and publishes
 * them to AkiDB in batches.
 *
 * Handles buffering, auto-flushing at a configurable threshold, tombstone
 * accumulation, and manifest publishing.
 */

import type { AkiDB } from "@ax-fabric/akidb";
import { AxFabricError } from "@ax-fabric/contracts";
import type { Record, Tombstone, TombstoneReason } from "@ax-fabric/contracts";

const DEFAULT_MAX_RECORDS = 500;

export interface BatchPublisherOptions {
  collectionId: string;
  akidb: AkiDB;
  maxRecords?: number;
  embeddingModelId: string;
  pipelineSignature: string;
}

export class BatchPublisher {
  private readonly collectionId: string;
  private readonly akidb: AkiDB;
  private readonly maxRecords: number;
  private readonly embeddingModelId: string;
  private readonly pipelineSignature: string;

  private pendingRecords: Record[] = [];
  private pendingStart = 0;
  private pendingTombstones: Tombstone[] = [];
  private flushedSegmentIds: string[] = [];

  constructor(options: BatchPublisherOptions) {
    this.collectionId = options.collectionId;
    this.akidb = options.akidb;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.embeddingModelId = options.embeddingModelId;
    this.pipelineSignature = options.pipelineSignature;
  }

  /**
   * Add records to the pending buffer.
   * Automatically flushes to AkiDB when the buffer reaches `maxRecords`.
   */
  async addRecords(records: Record[]): Promise<void> {
    this.pendingRecords.push(...records);

    while (this.getPendingCount() >= this.maxRecords) {
      await this.flushOneBatch();
    }
  }

  /**
   * Accumulate tombstones for the next publish cycle.
   * Tombstones are applied when `publish()` is called.
   */
  addTombstones(tombstones: Tombstone[]): void {
    this.pendingTombstones.push(...tombstones);
  }

  /**
   * Force-flush all pending records to AkiDB.
   * Returns the segment IDs produced by the flush operations.
   */
  async flush(): Promise<{ segmentIds: string[] }> {
    while (this.getPendingCount() > 0) {
      await this.flushOneBatch();
    }

    // Force-flush any records still in the Rust write buffer (below auto-flush threshold).
    // Called once here rather than after every batch to halve FFI round-trips during large ingests.
    const extraIds = await this.akidb.flushWrites(this.collectionId);
    if (extraIds.length > 0) {
      this.flushedSegmentIds.push(...extraIds);
    }

    return { segmentIds: [...this.flushedSegmentIds] };
  }

  /**
   * Flush all pending records and publish a new manifest version.
   *
   * Applies accumulated tombstones via `AkiDB.deleteChunks`, then
   * calls `AkiDB.publish` to create the manifest snapshot.
   */
  async publish(): Promise<{ manifestVersion: number; segmentCount: number }> {
    try {
      // Flush any remaining records first.
      const { segmentIds } = await this.flush();

      // Apply tombstones grouped by reason code so each chunk gets the correct tag.
      if (this.pendingTombstones.length > 0) {
        try {
          const byReason = new Map<TombstoneReason, Tombstone[]>();
          for (const tombstone of this.pendingTombstones) {
            const group = byReason.get(tombstone.reason_code);
            if (group) {
              group.push(tombstone);
            } else {
              byReason.set(tombstone.reason_code, [tombstone]);
            }
          }

          for (const [reason, group] of byReason) {
            this.akidb.deleteChunks(this.collectionId, group.map((t) => t.chunk_id), reason);
          }
          // NOTE: pendingTombstones is cleared only after publish() succeeds below,
          // so a publish failure doesn't silently lose tombstone requests.
        } catch (err) {
          throw new AxFabricError(
            "PUBLISH_ERROR",
            `Failed to delete chunks from collection ${this.collectionId}`,
            err,
          );
        }
      }

      // Publish manifest.
      const manifest = await this.akidb.publish(this.collectionId, {
        embeddingModelId: this.embeddingModelId,
        pipelineSignature: this.pipelineSignature,
      });

      // Reset state only after a fully successful publish.
      this.pendingTombstones = [];
      this.flushedSegmentIds = [];

      return { manifestVersion: manifest.version, segmentCount: segmentIds.length };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "PUBLISH_ERROR",
        `Failed to publish collection ${this.collectionId}`,
        err,
      );
    }
  }

  /** Return the number of records currently buffered (not yet flushed). */
  getPendingCount(): number {
    return this.pendingRecords.length - this.pendingStart;
  }

  /**
   * Flush up to `maxRecords` from the front of the pending buffer.
   * Returns segment IDs from the upsert.
   */
  private async flushOneBatch(): Promise<string[]> {
    const end = Math.min(this.pendingStart + this.maxRecords, this.pendingRecords.length);
    const batch = this.pendingRecords.slice(this.pendingStart, end);
    this.pendingStart = end;
    if (batch.length === 0) return [];

    try {
      const result = await this.akidb.upsertBatch(this.collectionId, batch);
      // Collect any segment IDs produced by the Rust write-buffer auto-flush
      // (triggered when the buffer hits its internal threshold).
      this.flushedSegmentIds.push(...result.segmentIds);
      this.compactPendingRecords();
      return result.segmentIds;
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "PUBLISH_ERROR",
        `Failed to upsert batch to collection ${this.collectionId}`,
        err,
      );
    }
  }

  private compactPendingRecords(): void {
    if (this.pendingStart === 0) return;
    if (this.pendingStart >= this.pendingRecords.length) {
      this.pendingRecords = [];
      this.pendingStart = 0;
      return;
    }
    if (this.pendingStart >= 1024 || this.pendingStart >= Math.floor(this.pendingRecords.length / 2)) {
      this.pendingRecords = this.pendingRecords.slice(this.pendingStart);
      this.pendingStart = 0;
    }
  }
}
