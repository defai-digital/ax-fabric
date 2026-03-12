/**
 * EmbeddingScheduler — cross-file embedding batching with adaptive concurrency.
 *
 * Instead of embedding one file's chunks at a time, the scheduler accepts
 * chunks from all in-flight files and fires provider requests using globally-
 * full batches. This improves throughput for many-small-file workloads by
 * keeping embedding API requests near their maximum batch size.
 *
 * Implements EmbedderProvider so it drops in anywhere an embedder is used.
 *
 * Data flow:
 *   embed(texts) → queue + ticket → scheduleFlush → drainQueue
 *   → fireBatch → embedder.embed → ticket.resolve / ticket.reject
 *
 * AIMD concurrency:
 *   success  → currentConcurrency = min(current + 1, max)
 *   429/5xx  → currentConcurrency = max(floor(current / 2), 1) + 5s cooldown
 */

import type { EmbedderProvider } from "@ax-fabric/contracts";
import { AxFabricError } from "@ax-fabric/contracts";
import {
  DEFAULT_EMBED_BATCH_SIZE,
  AIMD_COOLDOWN_MS,
  DEFAULT_SCHEDULER_MAX_CONCURRENCY,
  DEFAULT_SCHEDULER_INITIAL_CONCURRENCY,
  DEFAULT_SCHEDULER_MAX_QUEUE_AGE_MS,
} from "../constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** Underlying embedding provider. */
  embedder: EmbedderProvider;
  /** Max texts per HTTP request. Default: 64. */
  batchSize?: number;
  /** Max concurrent in-flight requests (hard upper bound). Default: 8. */
  maxConcurrency?: number;
  /** Starting concurrency for AIMD. Default: 2. */
  initialConcurrency?: number;
  /** Max milliseconds a chunk waits before a partial flush fires. Default: 150. */
  maxQueueAgeMs?: number;
}

export interface SchedulerMetrics {
  /** Total embed requests fired. */
  batchesFired: number;
  /** Total vectors embedded successfully. */
  vectorsEmbedded: number;
  /** Total provider errors. */
  errorsEncountered: number;
  /** Aggregate queue wait time across all items (ms). */
  totalQueueWaitMs: number;
  /** Aggregate HTTP request time (ms). */
  totalRequestMs: number;
  /** Average fill ratio (0–1) across all batches. */
  avgFillRatio: number;
}

/**
 * Opaque snapshot of scheduler counters at a point in time.
 * Pass to `metricsSince()` to get per-run deltas.
 */
export interface SchedulerSnapshot {
  batchesFired: number;
  vectorsEmbedded: number;
  errorsEncountered: number;
  totalQueueWaitMs: number;
  totalRequestMs: number;
  totalFillRatioSum: number;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface QueuedItem {
  text: string;
  ticketId: string;
  localIndex: number;
  enqueuedMs: number;
}

interface Ticket {
  totalChunks: number;
  vectors: (number[] | undefined)[];
  filled: number;
  rejected: boolean;
  resolve: (v: number[][]) => void;
  reject: (e: unknown) => void;
}

const DEFAULT_BATCH_SIZE = DEFAULT_EMBED_BATCH_SIZE;

// ─── EmbeddingScheduler ───────────────────────────────────────────────────────

export class EmbeddingScheduler implements EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;

  private readonly embedder: EmbedderProvider;
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private readonly maxQueueAgeMs: number;

  private currentConcurrency: number;
  private inFlight = 0;
  private cooldownUntilMs = 0;

  private readonly queue: QueuedItem[] = [];
  private readonly tickets = new Map<string, Ticket>();
  private nextTicketId = 0;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // Metrics accumulators
  private batchesFired = 0;
  private vectorsEmbedded = 0;
  private errorsEncountered = 0;
  private totalQueueWaitMs = 0;
  private totalRequestMs = 0;
  private totalFillRatioSum = 0;

  constructor(options: SchedulerOptions) {
    this.embedder = options.embedder;
    this.modelId = options.embedder.modelId;
    this.dimension = options.embedder.dimension;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_SCHEDULER_MAX_CONCURRENCY;
    this.currentConcurrency = options.initialConcurrency ?? DEFAULT_SCHEDULER_INITIAL_CONCURRENCY;
    this.maxQueueAgeMs = options.maxQueueAgeMs ?? DEFAULT_SCHEDULER_MAX_QUEUE_AGE_MS;
  }

  /**
   * Enqueue texts for embedding. Returns vectors in the same order.
   * Texts from all concurrent callers are batched together globally.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const ticketId = String(this.nextTicketId++);
    const nowMs = Date.now();

    return new Promise<number[][]>((resolve, reject) => {
      this.tickets.set(ticketId, {
        totalChunks: texts.length,
        vectors: new Array(texts.length).fill(undefined) as (number[] | undefined)[],
        filled: 0,
        rejected: false,
        resolve,
        reject,
      });

      for (let i = 0; i < texts.length; i++) {
        this.queue.push({
          text: texts[i]!,
          ticketId,
          localIndex: i,
          enqueuedMs: nowMs,
        });
      }

      this.scheduleFlush();
    });
  }

  /** Return a snapshot of all accumulated counters since construction. */
  getMetrics(): SchedulerMetrics {
    return {
      batchesFired: this.batchesFired,
      vectorsEmbedded: this.vectorsEmbedded,
      errorsEncountered: this.errorsEncountered,
      totalQueueWaitMs: this.totalQueueWaitMs,
      totalRequestMs: this.totalRequestMs,
      avgFillRatio:
        this.batchesFired > 0 ? this.totalFillRatioSum / this.batchesFired : 0,
    };
  }

  /**
   * Capture raw counters at a point in time.
   * Pass the result to `metricsSince()` at the end of a run to get
   * per-run stats rather than lifetime totals.
   */
  snapshot(): SchedulerSnapshot {
    return {
      batchesFired: this.batchesFired,
      vectorsEmbedded: this.vectorsEmbedded,
      errorsEncountered: this.errorsEncountered,
      totalQueueWaitMs: this.totalQueueWaitMs,
      totalRequestMs: this.totalRequestMs,
      totalFillRatioSum: this.totalFillRatioSum,
    };
  }

  /** Compute metrics representing only activity since `baseline` was taken. */
  metricsSince(baseline: SchedulerSnapshot): SchedulerMetrics {
    const deltaFired = this.batchesFired - baseline.batchesFired;
    const deltaFillSum = this.totalFillRatioSum - baseline.totalFillRatioSum;
    return {
      batchesFired: deltaFired,
      vectorsEmbedded: this.vectorsEmbedded - baseline.vectorsEmbedded,
      errorsEncountered: this.errorsEncountered - baseline.errorsEncountered,
      totalQueueWaitMs: this.totalQueueWaitMs - baseline.totalQueueWaitMs,
      totalRequestMs: this.totalRequestMs - baseline.totalRequestMs,
      avgFillRatio: deltaFired > 0 ? deltaFillSum / deltaFired : 0,
    };
  }

  /** Cancel any pending flush timer and reject all pending callers. Call when the pipeline is closing. */
  close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    const err = new AxFabricError(
      "EMBED_ERROR",
      "EmbeddingScheduler closed before queued embeddings were processed",
    );

    while (this.queue.length > 0) {
      this.queue.shift();
    }

    for (const [ticketId, ticket] of this.tickets.entries()) {
      if (!ticket.rejected) {
        ticket.rejected = true;
        ticket.reject(err);
      }
      this.tickets.delete(ticketId);
    }

    return Promise.resolve();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    // Full batch ready: fire immediately.
    if (this.queue.length >= this.batchSize) {
      this.drainQueue();
      return;
    }
    // Otherwise arm a timer so partial batches don't stall indefinitely.
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.drainQueue();
      }, this.maxQueueAgeMs);
    }
  }

  private drainQueue(): void {
    this.cancelTimer();
    while (this.queue.length > 0 && this.inFlight < this.currentConcurrency) {
      void this.fireBatch();
    }
    // Rearm timer if items remain but all concurrency slots are busy.
    if (this.queue.length > 0 && this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.drainQueue();
      }, this.maxQueueAgeMs);
    }
  }

  private cancelTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async fireBatch(): Promise<void> {
    const items = this.queue.splice(0, this.batchSize);
    if (items.length === 0) return;

    const nowMs = Date.now();
    for (const item of items) {
      this.totalQueueWaitMs += nowMs - item.enqueuedMs;
    }

    this.inFlight++;
    this.batchesFired++;
    this.totalFillRatioSum += items.length / this.batchSize;

    const requestStart = Date.now();
    try {
      const vectors = await this.embedder.embed(items.map((i) => i.text));
      this.totalRequestMs += Date.now() - requestStart;

      // Guard: a misbehaving embedder returning fewer vectors than requested
      // would silently corrupt tickets with undefined values. Reject the batch.
      if (vectors.length !== items.length) {
        throw new AxFabricError(
          "EMBED_ERROR",
          `Embedder returned ${String(vectors.length)} vectors for ${String(items.length)} inputs`,
        );
      }
      this.vectorsEmbedded += vectors.length;

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const ticket = this.tickets.get(item.ticketId);
        if (!ticket || ticket.rejected) continue;
        ticket.vectors[item.localIndex] = vectors[i]!;
        ticket.filled++;
        if (ticket.filled === ticket.totalChunks) {
          this.tickets.delete(item.ticketId);
          ticket.resolve(ticket.vectors as number[][]);
        }
      }

      // AIMD: increase concurrency on success (outside cooldown).
      if (Date.now() > this.cooldownUntilMs) {
        this.currentConcurrency = Math.min(
          this.currentConcurrency + 1,
          this.maxConcurrency,
        );
      }
    } catch (err) {
      this.totalRequestMs += Date.now() - requestStart;
      this.errorsEncountered++;

      if (isRetryableError(err)) {
        this.currentConcurrency = Math.max(
          Math.floor(this.currentConcurrency / 2),
          1,
        );
        this.cooldownUntilMs = Date.now() + AIMD_COOLDOWN_MS;
      }

      // Reject every ticket affected by this batch.
      // Safe for split-ticket scenarios: the `rejected` flag prevents a
      // later successful batch from resolving an already-rejected ticket.
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.ticketId)) continue;
        seen.add(item.ticketId);
        const ticket = this.tickets.get(item.ticketId);
        if (ticket && !ticket.rejected) {
          ticket.rejected = true;
          this.tickets.delete(item.ticketId);
          ticket.reject(err);
        }
      }
    } finally {
      this.inFlight--;
      if (!this.closed) this.drainQueue();
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (err instanceof AxFabricError) {
    const msg = err.message;
    return (
      msg.includes("HTTP 429") ||
      msg.includes("HTTP 5") ||
      msg.includes("timeout")
    );
  }
  return false;
}
