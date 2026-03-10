/**
 * Record Builder (Layer 2.6) — assembles Record objects from chunks +
 * embeddings, and generates Tombstone records for deletions.
 */

import { createHash } from "node:crypto";

import {
  RecordSchema,
  TombstoneSchema,
  AxFabricError,
} from "@ax-fabric/contracts";
import type {
  Record,
  RecordMetadata,
  Tombstone,
  TombstoneReason,
  PipelineVersions,
} from "@ax-fabric/contracts";

/** Content type derived from the contracts RecordMetadata schema. */
export type ContentType = RecordMetadata["content_type"];

/** A chunk that has already been embedded and is ready for record assembly. */
export interface ChunkWithEmbedding {
  chunkId: string;
  chunkHash: string;
  text: string;
  offset: number;
  vector: number[];
  sourcePath: string;
  contentType: ContentType;
  pageRange: string | null;
  tableRef: string | null;
}

export interface RecordBuilderOptions {
  embeddingModelId: string;
  pipelineSignature: string;
}

export class RecordBuilder {
  private readonly embeddingModelId: string;
  private readonly pipelineSignature: string;

  constructor(options: RecordBuilderOptions) {
    this.embeddingModelId = options.embeddingModelId;
    this.pipelineSignature = options.pipelineSignature;
  }

  /**
   * Assemble full Record objects from chunks that have been embedded.
   * Each record is validated against the RecordSchema before being returned.
   */
  buildRecords(
    docId: string,
    docVersion: string,
    chunks: ChunkWithEmbedding[],
  ): Record[] {
    return chunks.map((chunk) => {
      const record: Record = {
        chunk_id: chunk.chunkId,
        doc_id: docId,
        doc_version: docVersion,
        chunk_hash: chunk.chunkHash,
        pipeline_signature: this.pipelineSignature,
        embedding_model_id: this.embeddingModelId,
        vector: chunk.vector,
        metadata: {
          source_uri: chunk.sourcePath,
          content_type: chunk.contentType,
          page_range: chunk.pageRange,
          offset: chunk.offset,
          table_ref: chunk.tableRef,
          created_at: new Date().toISOString(),
        },
        chunk_text: chunk.text,
      };

      return this.validate(record);
    });
  }

  /**
   * Create tombstone records for the given chunk IDs.
   */
  buildTombstones(
    chunkIds: string[],
    reason: TombstoneReason,
  ): Tombstone[] {
    const deletedAt = new Date().toISOString();

    return chunkIds.map((chunkId) => {
      const tombstone: Tombstone = {
        chunk_id: chunkId,
        deleted_at: deletedAt,
        reason_code: reason,
      };

      const parsed = TombstoneSchema.safeParse(tombstone);
      if (!parsed.success) {
        throw new AxFabricError(
          "STATE_ERROR",
          `Invalid tombstone for chunk ${chunkId}: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
  }

  /**
   * Compute a deterministic pipeline signature from component versions.
   * `SHA-256(extractor_version + normalize_version + chunker_version)` (hex).
   */
  static computePipelineSignature(versions: PipelineVersions): string {
    const input =
      versions.extractor_version +
      versions.normalize_version +
      versions.chunker_version;
    return createHash("sha256").update(input, "utf8").digest("hex");
  }

  /**
   * Compute a deterministic document ID from source path and content hash.
   * `SHA-256(sourcePath + contentHash)` (hex).
   */
  static computeDocId(sourcePath: string, contentHash: string): string {
    return createHash("sha256")
      .update(sourcePath + contentHash, "utf8")
      .digest("hex");
  }

  /** Validate a record against the Zod schema. */
  private validate(record: Record): Record {
    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new AxFabricError(
        "STATE_ERROR",
        `Invalid record for chunk ${record.chunk_id}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}
