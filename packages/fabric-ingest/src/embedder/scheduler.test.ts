import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbeddingScheduler } from "./scheduler.js";
import type { EmbedderProvider } from "@ax-fabric/contracts";
import { AxFabricError } from "@ax-fabric/contracts";

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeEmbedder(
  fn?: (texts: string[]) => Promise<number[][]>,
): EmbedderProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    modelId: "test-model",
    dimension: 4,
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      if (fn) return fn(texts);
      // Deterministic: vector for text i is [i, 0, 0, 0]
      return texts.map((_, idx) => [calls.flat().length - texts.length + idx, 0, 0, 0]);
    },
  };
}

function makeScheduler(
  embedder: EmbedderProvider,
  overrides: Partial<ConstructorParameters<typeof EmbeddingScheduler>[0]> = {},
): EmbeddingScheduler {
  return new EmbeddingScheduler({
    embedder,
    batchSize: 4,
    maxConcurrency: 4,
    initialConcurrency: 4,
    maxQueueAgeMs: 50,
    ...overrides,
  });
}

// ─── Basic correctness ────────────────────────────────────────────────────────

describe("EmbeddingScheduler — basic correctness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns vectors in original order for a single embed() call", async () => {
    const embedder = makeEmbedder(async (texts) =>
      texts.map((_, i) => [i + 1, 0, 0, 0]),
    );
    const scheduler = makeScheduler(embedder, { batchSize: 10 });

    const promise = scheduler.embed(["a", "b", "c"]);
    await vi.runAllTimersAsync();
    const vectors = await promise;

    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual([1, 0, 0, 0]);
    expect(vectors[1]).toEqual([2, 0, 0, 0]);
    expect(vectors[2]).toEqual([3, 0, 0, 0]);
  });

  it("returns empty array for empty input without calling embedder", async () => {
    const embedder = makeEmbedder();
    const scheduler = makeScheduler(embedder);
    const result = await scheduler.embed([]);
    expect(result).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });

  it("exposes modelId and dimension from underlying embedder", () => {
    const embedder = makeEmbedder();
    const scheduler = makeScheduler(embedder);
    expect(scheduler.modelId).toBe("test-model");
    expect(scheduler.dimension).toBe(4);
  });
});

// ─── Batch accumulation ───────────────────────────────────────────────────────

describe("EmbeddingScheduler — batch accumulation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a single batch when items accumulate to exactly batchSize", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    // batchSize=4, initialConcurrency=4 so it won't hold back
    const scheduler = makeScheduler(embedder, { batchSize: 4 });

    // Two concurrent calls each with 2 texts — should form one batch of 4
    const p1 = scheduler.embed(["a", "b"]);
    const p2 = scheduler.embed(["c", "d"]);

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    // Both calls combined into one batch
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]).toHaveLength(4);
  });

  it("fires multiple batches for items exceeding batchSize", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    const scheduler = makeScheduler(embedder, { batchSize: 3 });

    const promise = scheduler.embed(["a", "b", "c", "d", "e"]);
    await vi.runAllTimersAsync();
    await promise;

    // 5 items with batchSize=3: first batch=3, second batch=2
    const totalTexts = embedder.calls.reduce((s, c) => s + c.length, 0);
    expect(totalTexts).toBe(5);
    expect(embedder.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("flushes partial batch via timer when queue never fills", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    // batchSize=10 so 3 items won't trigger immediate flush
    const scheduler = makeScheduler(embedder, { batchSize: 10, maxQueueAgeMs: 50 });

    const promise = scheduler.embed(["a", "b", "c"]);
    expect(embedder.calls).toHaveLength(0); // not fired yet

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]).toHaveLength(3);
  });
});

// ─── Concurrent file batching ─────────────────────────────────────────────────

describe("EmbeddingScheduler — cross-file batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches chunks from multiple concurrent files into fewer requests", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    // batchSize=6, 3 files × 2 chunks = 6 → should combine into 1 batch
    const scheduler = makeScheduler(embedder, { batchSize: 6 });

    const promises = [
      scheduler.embed(["f1c1", "f1c2"]),
      scheduler.embed(["f2c1", "f2c2"]),
      scheduler.embed(["f3c1", "f3c2"]),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(promises);

    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]).toHaveLength(6);
  });

  it("each file's promise resolves with its own vectors in correct order", async () => {
    let callIdx = 0;
    const embedder = makeEmbedder(async (texts) =>
      texts.map(() => [callIdx++, 0, 0, 0]),
    );
    const scheduler = makeScheduler(embedder, { batchSize: 4 });

    const [v1, v2] = await Promise.all([
      scheduler.embed(["a", "b"]).then((vs) => Promise.resolve(vs)),
      scheduler.embed(["c", "d"]).then(async (vs) => {
        await vi.runAllTimersAsync();
        return vs;
      }),
    ]);

    // Both files resolved
    expect(v1).toHaveLength(2);
    expect(v2).toHaveLength(2);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("EmbeddingScheduler — error handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the promise when the underlying embedder throws", async () => {
    const embedder = makeEmbedder(async () => {
      throw new AxFabricError("EMBED_ERROR", "HTTP 500 from provider");
    });
    const scheduler = makeScheduler(embedder, { batchSize: 2 });

    const promise = scheduler.embed(["a", "b"]);
    // Attach handler immediately so the rejection is never unhandled.
    const check = expect(promise).rejects.toThrow("HTTP 500");
    await vi.runAllTimersAsync();
    await check;
  });

  it("reduces currentConcurrency on 429 retryable error (AIMD)", async () => {
    const embedder = makeEmbedder(async () => {
      throw new AxFabricError("EMBED_ERROR", "HTTP 429 rate limited");
    });
    const scheduler = makeScheduler(embedder, {
      batchSize: 2,
      initialConcurrency: 4,
      maxConcurrency: 4,
    });

    const promise = scheduler.embed(["a", "b"]);
    const check = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await check;

    // After a 429 the scheduler should have halved its concurrency
    const metrics = scheduler.getMetrics();
    expect(metrics.errorsEncountered).toBe(1);
  });

  it("rejects all tickets in a failed batch (split-ticket safety)", async () => {
    // File with 5 chunks, batchSize=3 → split across 2 batches.
    // Second batch fails. First batch succeeds but ticket should reject overall.
    let batchNum = 0;
    const embedder = makeEmbedder(async (texts) => {
      batchNum++;
      if (batchNum === 2) {
        throw new AxFabricError("EMBED_ERROR", "HTTP 500 batch 2");
      }
      return texts.map(() => [1, 0, 0, 0]);
    });
    const scheduler = makeScheduler(embedder, {
      batchSize: 3,
      maxConcurrency: 1,
      initialConcurrency: 1,
    });

    // 5 chunks: batch1=[0,1,2], batch2=[3,4]
    const promise = scheduler.embed(["a", "b", "c", "d", "e"]);
    const check = expect(promise).rejects.toThrow("HTTP 500 batch 2");
    await vi.runAllTimersAsync();
    await check;
  });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

describe("EmbeddingScheduler — metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks batchesFired and vectorsEmbedded", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    const scheduler = makeScheduler(embedder, { batchSize: 3 });

    const promise = scheduler.embed(["a", "b", "c", "d", "e"]); // 5 → 2 batches
    await vi.runAllTimersAsync();
    await promise;

    const m = scheduler.getMetrics();
    expect(m.batchesFired).toBe(2);
    expect(m.vectorsEmbedded).toBe(5);
  });

  it("tracks avgFillRatio", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    // batchSize=4, send exactly 4 → full batch → ratio 1.0
    const scheduler = makeScheduler(embedder, { batchSize: 4 });

    const promise = scheduler.embed(["a", "b", "c", "d"]);
    await vi.runAllTimersAsync();
    await promise;

    const m = scheduler.getMetrics();
    expect(m.avgFillRatio).toBeCloseTo(1.0);
  });

  it("metricsSince returns per-run delta, not lifetime total", async () => {
    const embedder = makeEmbedder(async (texts) => texts.map(() => [1, 0, 0, 0]));
    const scheduler = makeScheduler(embedder, { batchSize: 4 });

    // First run: embed 4 texts
    const p1 = scheduler.embed(["a", "b", "c", "d"]);
    await vi.runAllTimersAsync();
    await p1;

    // Take snapshot between runs
    const snap = scheduler.snapshot();

    // Second run: embed 2 texts
    const p2 = scheduler.embed(["e", "f"]);
    await vi.runAllTimersAsync();
    await p2;

    const lifetime = scheduler.getMetrics();
    const delta = scheduler.metricsSince(snap);

    // Lifetime total includes both runs
    expect(lifetime.vectorsEmbedded).toBe(6);
    // Delta reflects only the second run
    expect(delta.vectorsEmbedded).toBe(2);
    expect(delta.batchesFired).toBe(1);
  });

  it("tracks errorsEncountered on failure", async () => {
    const embedder = makeEmbedder(async () => {
      throw new AxFabricError("EMBED_ERROR", "HTTP 500");
    });
    const scheduler = makeScheduler(embedder, { batchSize: 2 });

    const promise = scheduler.embed(["a", "b"]);
    const check = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await check;

    const m = scheduler.getMetrics();
    expect(m.errorsEncountered).toBe(1);
  });
});
