/**
 * Pipeline Orchestrator — composes all fabric-ingest layers into a single ingest flow.
 *
 * Flow: Scanner → Extractor → Normalizer → Chunker → Embedder → Builder → Publisher
 * With Job Registry for idempotent re-runs and per-file error isolation.
 */

import type { EmbedderProvider, Record, Tombstone } from "@ax-fabric/contracts";
import { AxFabricError } from "@ax-fabric/contracts";
import type { AkiDB } from "@ax-fabric/akidb";
import { EmbeddingScheduler } from "../embedder/scheduler.js";
import type { SchedulerOptions } from "../embedder/scheduler.js";
import type { EmbedStats, PipelineObserver } from "../observer/types.js";

import { SourceScanner } from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { createDefaultRegistry } from "../extractor/index.js";
import type { ExtractorRegistry } from "../extractor/index.js";
import { EXTRACTOR_VERSION } from "../extractor/index.js";
import { NORMALIZER_VERSION } from "../normalizer/index.js";
import { CHUNKER_VERSION } from "../chunker/index.js";
import type { ChunkerOptions } from "../chunker/index.js";
import { RecordBuilder } from "../builder/index.js";
import { BatchPublisher } from "../publisher/index.js";
import { JobRegistry } from "../registry/index.js";
import {
  stageExtract,
  stageNormalize,
  stageChunk,
  stageEmbed,
  stageBuild,
} from "./stages.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Root directories to scan for documents */
  sourcePaths: string[];
  /** AkiDB instance for storage */
  akidb: AkiDB;
  /** AkiDB collection ID */
  collectionId: string;
  /** Embedding provider */
  embedder: EmbedderProvider;
  /** Path to Job Registry SQLite database */
  registryDbPath: string;
  /** Chunker options */
  chunkerOptions?: ChunkerOptions;
  /** Max records per AkiDB batch (default 500) */
  maxBatchRecords?: number;
  /** Custom extractor registry (default: all 8 formats) */
  extractorRegistry?: ExtractorRegistry;
  /** Embedding scheduler options (overrides defaults) */
  schedulerOptions?: Omit<SchedulerOptions, "embedder">;
  /** Optional observer to receive typed pipeline events. */
  observer?: PipelineObserver;
}

export type { EmbedStats } from "../observer/types.js";

export interface PipelineMetrics {
  filesScanned: number;
  filesChanged: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesUnchanged: number;
  filesFailed: number;
  filesSucceeded: number;
  recordsGenerated: number;
  tombstonesGenerated: number;
  segmentsBuilt: number;
  manifestVersion: number | null;
  durationMs: number;
  errors: PipelineFileError[];
  /** Wall-clock time for each major phase. */
  scanDurationMs: number;
  processDurationMs: number;
  publishDurationMs: number;
  /** Embedding scheduler stats for this run. */
  embedStats: EmbedStats;
}

export interface PipelineFileError {
  sourcePath: string;
  errorCode: string;
  message: string;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export class Pipeline {
  private readonly scanner: SourceScanner;
  private readonly registry: JobRegistry;
  private readonly extractorRegistry: ExtractorRegistry;
  private readonly scheduler: EmbeddingScheduler;
  private readonly akidb: AkiDB;
  private readonly collectionId: string;
  private readonly pipelineSignature: string;
  private readonly sourcePaths: string[];
  private readonly chunkerOptions: ChunkerOptions | undefined;
  private readonly maxBatchRecords: number;
  private readonly observer: PipelineObserver | undefined;

  constructor(options: PipelineOptions) {
    this.extractorRegistry = options.extractorRegistry ?? createDefaultRegistry();
    this.scanner = new SourceScanner({
      extensions: this.extractorRegistry.getSupportedExtensions(),
    });
    this.registry = new JobRegistry(options.registryDbPath);
    this.scheduler = new EmbeddingScheduler({
      embedder: options.embedder,
      ...options.schedulerOptions,
    });
    this.akidb = options.akidb;
    this.collectionId = options.collectionId;
    this.sourcePaths = options.sourcePaths;
    this.chunkerOptions = options.chunkerOptions;
    this.maxBatchRecords = options.maxBatchRecords ?? 500;
    this.observer = options.observer;

    this.pipelineSignature = RecordBuilder.computePipelineSignature({
      extractor_version: EXTRACTOR_VERSION,
      normalize_version: NORMALIZER_VERSION,
      chunker_version: CHUNKER_VERSION,
    });
  }

  /**
   * Execute the full ingestion pipeline.
   * Scans sources, detects changes, extracts/normalizes/chunks/embeds,
   * publishes to AkiDB, and updates the Job Registry.
   */
  async run(sourcePaths?: string[]): Promise<PipelineMetrics> {
    const startMs = Date.now();
    const paths = sourcePaths ?? this.sourcePaths;
    const metrics = createEmptyMetrics();
    const errors: PipelineFileError[] = [];
    // Snapshot scheduler counters before this run so we can compute a per-run delta.
    const schedBaseline = this.scheduler.snapshot();

    const cycleId = `cycle-${Date.now()}`;
    this.observer?.onEvent({
      type: "cycle_start",
      timestamp: new Date().toISOString(),
      cycleId,
      sourcePaths: paths,
    });

    // 1. Scan all source paths (async: concurrent stat + fingerprint per directory)
    const scanStart = Date.now();
    const knownFileStates = this.registry.getKnownFileStates();
    const scannedPerRoot = await runConcurrent(
      paths,
      (root) => this.scanner.scanAsync(root, knownFileStates),
      PIPELINE_CONCURRENCY,
    );
    const allResults: ScanResult[] = [];
    for (const results of scannedPerRoot) {
      allResults.push(...results);
    }
    metrics.filesScanned = allResults.length;
    metrics.scanDurationMs = Date.now() - scanStart;

    // 2. Detect changes against Job Registry
    const knownFingerprints = new Map<string, string>();
    for (const [path, state] of knownFileStates) {
      knownFingerprints.set(path, state.fingerprint);
    }
    const changes = this.scanner.detectChanges(allResults, knownFingerprints);
    metrics.filesAdded = changes.added.length;
    metrics.filesModified = changes.modified.length;
    metrics.filesDeleted = changes.deleted.length;
    metrics.filesUnchanged = changes.unchanged.length;
    metrics.filesChanged = changes.added.length + changes.modified.length + changes.deleted.length;

    // 3. Set up publisher
    const publisher = new BatchPublisher({
      collectionId: this.collectionId,
      akidb: this.akidb,
      maxRecords: this.maxBatchRecords,
      embeddingModelId: this.scheduler.modelId,
      pipelineSignature: this.pipelineSignature,
    });

    const builder = new RecordBuilder({
      embeddingModelId: this.scheduler.modelId,
      pipelineSignature: this.pipelineSignature,
    });

    // 4. Handle deleted files → tombstones
    const deleteTombstones = await this.processDeleted(changes.deleted, builder);
    if (deleteTombstones.length > 0) {
      publisher.addTombstones(deleteTombstones);
      metrics.tombstonesGenerated += deleteTombstones.length;
    }

    // 5. Process changed files concurrently through the scheduler.
    // The EmbeddingScheduler accumulates chunks from all in-flight files
    // and fires globally-full batches, improving throughput for small files.
    const processStart = Date.now();

    // 5a. Modified files → tombstone old chunks + ingest new content
    const modifiedResults = await runConcurrent(
      changes.modified,
      (file) => this.processModifiedFile(file, builder, publisher, cycleId),
      PIPELINE_CONCURRENCY,
    );
    for (const result of modifiedResults) {
      if (result.error) {
        errors.push(result.error);
        metrics.filesFailed++;
      } else {
        metrics.filesSucceeded++;
        metrics.recordsGenerated += result.recordCount;
        metrics.tombstonesGenerated += result.tombstoneCount;
      }
    }

    // 5b. Added files → new records
    const addedResults = await runConcurrent(
      changes.added,
      (file) => this.processNewFile(file, builder, publisher, cycleId),
      PIPELINE_CONCURRENCY,
    );
    for (const result of addedResults) {
      if (result.error) {
        errors.push(result.error);
        metrics.filesFailed++;
      } else {
        metrics.filesSucceeded++;
        metrics.recordsGenerated += result.recordCount;
      }
    }
    metrics.processDurationMs = Date.now() - processStart;

    // 6. Publish if we have any records or tombstones
    const publishStart = Date.now();
    if (metrics.recordsGenerated > 0 || metrics.tombstonesGenerated > 0) {
      const publishResult = await publisher.publish();
      metrics.manifestVersion = publishResult.manifestVersion;
      metrics.segmentsBuilt = publishResult.segmentCount;
    }
    metrics.publishDurationMs = Date.now() - publishStart;

    // 7. Collect per-run embed scheduler stats (delta since run start).
    const schedDelta = this.scheduler.metricsSince(schedBaseline);
    metrics.embedStats = {
      batchesFired: schedDelta.batchesFired,
      vectorsEmbedded: schedDelta.vectorsEmbedded,
      errorsEncountered: schedDelta.errorsEncountered,
      avgFillRatio: schedDelta.avgFillRatio,
      vectorsPerSec:
        metrics.processDurationMs > 0
          ? Math.round(schedDelta.vectorsEmbedded / (metrics.processDurationMs / 1_000))
          : 0,
    };

    metrics.errors = errors;
    metrics.durationMs = Date.now() - startMs;

    this.observer?.onEvent({
      type: "cycle_end",
      timestamp: new Date().toISOString(),
      cycleId,
      filesProcessed: metrics.filesSucceeded,
      filesFailed: metrics.filesFailed,
      filesSkipped: metrics.filesUnchanged,
      recordsGenerated: metrics.recordsGenerated,
      tombstonesGenerated: metrics.tombstonesGenerated,
      compacted: false,
      durationMs: metrics.durationMs,
      stageDurations: {
        scanMs: metrics.scanDurationMs,
        processDurationMs: metrics.processDurationMs,
        publishMs: metrics.publishDurationMs,
      },
      embedStats: metrics.embedStats,
    });

    return metrics;
  }

  /** Generate tombstones for all deleted files and remove from registry. */
  private async processDeleted(
    deletedPaths: string[],
    builder: RecordBuilder,
  ): Promise<Tombstone[]> {
    const tombstones: Tombstone[] = [];
    for (const sourcePath of deletedPaths) {
      const fileRecord = this.registry.getFile(sourcePath);
      if (fileRecord && fileRecord.chunkIds.length > 0) {
        const ts = builder.buildTombstones(fileRecord.chunkIds, "file_deleted");
        tombstones.push(...ts);
      }
      this.registry.deleteFile(sourcePath);
    }
    return tombstones;
  }

  /** Process a modified file: tombstone old chunks, ingest new content. */
  private async processModifiedFile(
    file: ScanResult,
    builder: RecordBuilder,
    publisher: BatchPublisher,
    cycleId: string,
  ): Promise<ProcessResult> {
    const oldRecord = this.registry.getFile(file.sourcePath);

    // Ingest new content first; only tombstone old chunks if ingestion succeeds.
    // Tombstoning before checking success would delete the old data even when
    // re-ingestion fails, leaving the file unsearchable.
    const result = await this.ingestFile(file, builder, publisher, cycleId);

    let tombstoneCount = 0;
    if (!result.error && oldRecord && oldRecord.chunkIds.length > 0) {
      const tombstones = builder.buildTombstones(oldRecord.chunkIds, "file_updated");
      publisher.addTombstones(tombstones);
      tombstoneCount = tombstones.length;
    }

    return { ...result, tombstoneCount };
  }

  /** Process a newly added file. */
  private async processNewFile(
    file: ScanResult,
    builder: RecordBuilder,
    publisher: BatchPublisher,
    cycleId: string,
  ): Promise<ProcessResult> {
    return this.ingestFile(file, builder, publisher, cycleId);
  }

  /**
   * Core file ingestion: extract → normalize → chunk → embed → build → publish.
   * Delegates each stage to a pure stage function; owns only side effects
   * (registry writes, publisher batching) and per-file error isolation.
   */
  private async ingestFile(
    file: ScanResult,
    builder: RecordBuilder,
    publisher: BatchPublisher,
    cycleId: string,
  ): Promise<ProcessResult> {
    const fileStart = Date.now();
    try {
      // Stage 1: Extract
      const extracted = await stageExtract(file, this.extractorRegistry);
      if (!extracted) {
        const result = makeSuccess(file, [], this.registry);
        this.observer?.onEvent({
          type: "file_processed",
          timestamp: new Date().toISOString(),
          cycleId,
          sourcePath: file.sourcePath,
          status: "skipped",
          chunksGenerated: 0,
          durationMs: Date.now() - fileStart,
        });
        return result;
      }

      // Stage 2: Normalize
      const normalized = stageNormalize(extracted);

      // Stage 3: Chunk
      const chunked = stageChunk(normalized, file, this.chunkerOptions);
      if (!chunked) {
        const result = makeSuccess(file, [], this.registry);
        this.observer?.onEvent({
          type: "file_processed",
          timestamp: new Date().toISOString(),
          cycleId,
          sourcePath: file.sourcePath,
          status: "skipped",
          chunksGenerated: 0,
          durationMs: Date.now() - fileStart,
        });
        return result;
      }

      // Stage 4: Embed (via cross-file scheduler for globally-full batches)
      const embedded = await stageEmbed(chunked, this.scheduler);

      // Stage 5: Build records
      const { records } = stageBuild(embedded, file, extracted, builder);

      // Publish to batch (side effect)
      await publisher.addRecords(records);

      // Update registry (side effect)
      const result = makeSuccess(file, records, this.registry);
      this.observer?.onEvent({
        type: "file_processed",
        timestamp: new Date().toISOString(),
        cycleId,
        sourcePath: file.sourcePath,
        status: "success",
        chunksGenerated: chunked.chunks.length,
        durationMs: Date.now() - fileStart,
      });
      return result;
    } catch (err) {
      const code = err instanceof AxFabricError ? err.code : "INGEST_ERROR";
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.upsertFile({
        sourcePath: file.sourcePath,
        fingerprint: file.fingerprint,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        docId: RecordBuilder.computeDocId(file.sourcePath, file.fingerprint),
        docVersion: file.fingerprint,
        chunkIds: [],
        lastIngestAt: new Date().toISOString(),
        status: "error",
        errorMessage: msg,
      });
      this.observer?.onEvent({
        type: "file_processed",
        timestamp: new Date().toISOString(),
        cycleId,
        sourcePath: file.sourcePath,
        status: "error",
        chunksGenerated: 0,
        durationMs: Date.now() - fileStart,
        errorMessage: msg,
      });
      return { recordCount: 0, tombstoneCount: 0, error: { sourcePath: file.sourcePath, errorCode: code, message: msg } };
    }
  }

  /** Close the Job Registry database connection and cancel any pending flush timer. */
  close(): void {
    this.registry.close();
    void this.scheduler.close(); // scheduler.close() is synchronous (timer cancel); void is intentional
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Max number of files processed concurrently in the pipeline.
 * Conservative default: enough to overlap embedder HTTP latency without
 * saturating the API rate limit or local memory for large embedding batches.
 */
const PIPELINE_CONCURRENCY = 4;

/**
 * Process `items` with at most `concurrency` Promises in-flight at once.
 * Preserves input order in the returned results array.
 */
async function runConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: Array<R | undefined> = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) {
      throw new Error(`runConcurrent produced incomplete results at index ${String(i)}`);
    }
  }
  return results as R[];
}

interface ProcessResult {
  recordCount: number;
  tombstoneCount: number;
  error?: PipelineFileError;
}

function createEmptyMetrics(): PipelineMetrics {
  return {
    filesScanned: 0,
    filesChanged: 0,
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    filesUnchanged: 0,
    filesFailed: 0,
    filesSucceeded: 0,
    recordsGenerated: 0,
    tombstonesGenerated: 0,
    segmentsBuilt: 0,
    manifestVersion: null,
    durationMs: 0,
    errors: [],
    scanDurationMs: 0,
    processDurationMs: 0,
    publishDurationMs: 0,
    embedStats: {
      batchesFired: 0,
      vectorsEmbedded: 0,
      errorsEncountered: 0,
      avgFillRatio: 0,
      vectorsPerSec: 0,
    },
  };
}


function makeSuccess(
  file: ScanResult,
  records: Record[],
  registry: JobRegistry,
): ProcessResult {
  const chunkIds = records.map((r) => r.chunk_id);
  registry.upsertFile({
    sourcePath: file.sourcePath,
    fingerprint: file.fingerprint,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    docId: records.length > 0 ? records[0]!.doc_id : RecordBuilder.computeDocId(file.sourcePath, file.fingerprint),
    docVersion: file.fingerprint,
    chunkIds,
    lastIngestAt: new Date().toISOString(),
    status: "success",
  });
  return { recordCount: records.length, tombstoneCount: 0 };
}
