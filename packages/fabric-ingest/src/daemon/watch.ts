/**
 * Daemon watch loop — long-running process that polls source folders,
 * detects changes, and orchestrates ingestion/tombstoning/compaction.
 *
 * Lifecycle:
 * 1. Load config
 * 2. Acquire lock
 * 3. Open AkiDB engine
 * 4. Loop:
 *    a. Check storage budget
 *    b. Scan source folders
 *    c. Handle deleted/modified files (lifecycle)
 *    d. Run pipeline for new/modified files
 *    e. Compact if tombstone count exceeds threshold
 *    f. Sleep(interval)
 * 5. SIGINT/SIGTERM → finish current cycle, close engine
 * 6. SIGHUP → reload config
 */

import type { EmbedderProvider } from "@ax-fabric/contracts";
import type { AkiDB } from "@ax-fabric/akidb";

import type { FabricConfig } from "../cli/config-loader.js";
import { loadConfig, resolveDataRoot } from "../cli/config-loader.js";
import { acquireLock, releaseLock } from "./lock.js";
import { checkBudget } from "./budget.js";
import type { BudgetResult } from "./budget.js";
import type { LifecycleResult } from "./lifecycle.js";
import { Pipeline } from "../pipeline/pipeline.js";
import type { PipelineMetrics } from "../pipeline/pipeline.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WatchOptions {
  configPath?: string;
  once?: boolean;
  akidb: AkiDB;
  embedder: EmbedderProvider;
  collectionId: string;
  /** Called immediately before each cycle starts. */
  onCycleStart?: () => void;
  /** Called after each successful cycle with the cycle result. */
  onCycleEnd?: (result: CycleResult) => void;
  /** Called when a cycle throws an error. */
  onCycleError?: (err: unknown) => void;
}

export interface CycleResult {
  budget: BudgetResult;
  deletions: LifecycleResult;
  modifications: LifecycleResult;
  pipeline: PipelineMetrics | null;
  compacted: boolean;
  skipped: boolean;
}

export interface WatchResult {
  cycles: number;
  stopped: boolean;
  reason: string;
}

// ─── Daemon ───────────────────────────────────────────────────────────────────

export class Daemon {
  private config: FabricConfig;
  private readonly akidb: AkiDB;
  private readonly embedder: EmbedderProvider;
  private readonly collectionId: string;
  private readonly configPath?: string;
  private readonly onCycleStart?: () => void;
  private readonly onCycleEnd?: (result: CycleResult) => void;
  private readonly onCycleError?: (err: unknown) => void;
  private running = false;
  private cycleCount = 0;

  constructor(opts: WatchOptions) {
    this.configPath = opts.configPath;
    this.config = loadConfig(opts.configPath);
    this.akidb = opts.akidb;
    this.embedder = opts.embedder;
    this.collectionId = opts.collectionId;
    this.onCycleStart = opts.onCycleStart;
    this.onCycleEnd = opts.onCycleEnd;
    this.onCycleError = opts.onCycleError;
  }

  /**
   * Run the daemon loop. Blocks until stopped or `once` is set.
   */
  async run(opts?: { once?: boolean }): Promise<WatchResult> {
    const once = opts?.once ?? false;
    const dataRoot = resolveDataRoot(this.config);
    const lockPath = `${dataRoot}/daemon.lock`;

    const lock = acquireLock(lockPath);
    if (!lock.acquired) {
      return { cycles: 0, stopped: false, reason: lock.reason ?? "Lock acquisition failed" };
    }

    this.running = true;

    // Reload config on SIGHUP.
    const sighupHandler = () => {
      try {
        this.config = loadConfig(this.configPath);
      } catch {
        // Continue with old config.
      }
    };
    process.on("SIGHUP", sighupHandler);

    // Graceful stop on SIGINT/SIGTERM.
    const stopHandler = () => {
      this.running = false;
    };
    process.on("SIGINT", stopHandler);
    process.on("SIGTERM", stopHandler);

    try {
      do {
        this.onCycleStart?.();
        let cycleResult: CycleResult | undefined;
        try {
          cycleResult = await this.runCycle();
          this.onCycleEnd?.(cycleResult);
        } catch (err) {
          console.error(`[daemon] cycle error: ${err instanceof Error ? err.message : String(err)}`);
          this.onCycleError?.(err);
        }
        this.cycleCount++;

        if (!once && this.running) {
          const intervalMs = (this.config.schedule?.interval_minutes ?? 10) * 60_000;
          await sleep(intervalMs);
        }
      } while (!once && this.running);
    } finally {
      process.removeListener("SIGHUP", sighupHandler);
      process.removeListener("SIGINT", stopHandler);
      process.removeListener("SIGTERM", stopHandler);
      releaseLock(lockPath);
    }

    return {
      cycles: this.cycleCount,
      stopped: true,
      reason: once ? "Single cycle completed" : "Daemon stopped",
    };
  }

  /**
   * Run a single ingest cycle.
   */
  async runCycle(): Promise<CycleResult> {
    const maxStorageGb = this.config.fabric.max_storage_gb;
    const compactThreshold = this.config.lifecycle?.compact_threshold ?? 50;

    // 1. Check storage budget.
    const usedBytes = this.akidb.getStorageSizeBytes();
    const budget = checkBudget(usedBytes, maxStorageGb);

    if (budget.action === "skip") {
      // Over budget — only compact, skip ingestion.
      await this.akidb.compact(this.collectionId);
      return {
        budget,
        deletions: { tombstoned: 0, deletedFiles: [], modifiedFiles: [] },
        modifications: { tombstoned: 0, deletedFiles: [], modifiedFiles: [] },
        pipeline: null,
        compacted: true,
        skipped: true,
      };
    }

    // 2. Run the pipeline (handles scanning, extraction, chunking, embedding, publishing).
    const dataRoot = resolveDataRoot(this.config);
    const registryPath = `${dataRoot}/registry.db`;

    const sourcePaths = this.config.ingest.sources.map((s) => s.path);

    // Placeholder deletion/modification results — the Pipeline tracks these
    // internally (filesDeleted / filesModified in PipelineMetrics).
    const emptyLifecycle: LifecycleResult = { tombstoned: 0, deletedFiles: [], modifiedFiles: [] };
    let pipelineMetrics: PipelineMetrics | null = null;

    // Pipeline manages its own JobRegistry connection internally via registryDbPath.
    // Do NOT open a separate registry here — that causes duplicate writers on the
    // same SQLite file (SQLITE_BUSY) and leaks connections.
    const pipeline = new Pipeline({
      sourcePaths,
      akidb: this.akidb,
      collectionId: this.collectionId,
      embedder: this.embedder,
      registryDbPath: registryPath,
      chunkerOptions: {
        chunkSize: this.config.ingest.chunking.chunk_size,
        overlapRatio: this.config.ingest.chunking.overlap,
      },
    });

    try {
      pipelineMetrics = await pipeline.run(sourcePaths);
    } finally {
      pipeline.close();
    }

    // 3. Check if compaction is needed.
    let compacted = false;
    const tombstoneCount = this.akidb.getTombstoneCount(this.collectionId);
    if (tombstoneCount >= compactThreshold || budget.action === "compact") {
      await this.akidb.compact(this.collectionId);
      compacted = true;
    }

    return {
      budget,
      deletions: emptyLifecycle,
      modifications: emptyLifecycle,
      pipeline: pipelineMetrics,
      compacted,
      skipped: false,
    };
  }

  stop(): void {
    this.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
