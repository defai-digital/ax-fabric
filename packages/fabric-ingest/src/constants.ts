/**
 * Shared defaults for the fabric-ingest pipeline.
 *
 * Single source of truth for values that appear in multiple modules
 * and in the YAML config schema. Update here — nowhere else.
 */

// ─── Chunking ─────────────────────────────────────────────────────────────────

/** Target chunk size in characters (~700 tokens at 4 chars/token). */
export const DEFAULT_CHUNK_SIZE = 2800;

/** Overlap between consecutive chunks as a fraction of chunk size. */
export const DEFAULT_OVERLAP_RATIO = 0.15;

// ─── Embedding ────────────────────────────────────────────────────────────────

/** Maximum texts per embedding API request. */
export const DEFAULT_EMBED_BATCH_SIZE = 64;

/** HTTP request timeout for embedding calls (ms). */
export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

/** Max concurrent embedding HTTP requests per embedder instance. */
export const DEFAULT_EMBED_MAX_CONCURRENCY = 4;

// ─── Search ───────────────────────────────────────────────────────────────────

/** Default number of results returned by search tools. */
export const DEFAULT_SEARCH_TOP_K = 10;

/** Default search mode when none is specified. */
export const DEFAULT_SEARCH_MODE = "vector" as const;
