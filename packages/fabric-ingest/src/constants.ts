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

// ─── File-system paths ────────────────────────────────────────────────────────

/** Hidden home directory for ax-fabric runtime data. */
export const AX_FABRIC_HOME_DIR = ".ax-fabric";

/** File name for the MCP auth token (relative to AX_FABRIC_HOME_DIR). */
export const MCP_TOKEN_FILENAME = "mcp-token";

/** File name for the daemon status snapshot (relative to AX_FABRIC_HOME_DIR). */
export const DAEMON_STATUS_FILENAME = "status.json";

// ─── Environment variables ────────────────────────────────────────────────────

/** Env var read by HttpEmbedder as the fallback Bearer token. */
export const ENV_EMBEDDING_API_KEY = "EMBEDDING_API_KEY";

/** Env var that overrides the MCP server auth token. */
export const ENV_MCP_TOKEN = "AX_FABRIC_MCP_TOKEN";

/** Env var that overrides the orchestrator auth token. */
export const ENV_ORCHESTRATOR_TOKEN = "AX_FABRIC_ORCHESTRATOR_TOKEN";

// ─── Storage budget thresholds ────────────────────────────────────────────────

/** Percent usage above which the daemon skips ingestion and only compacts. */
export const BUDGET_SKIP_THRESHOLD_PCT = 95;

/** Percent usage above which compaction is triggered before the next ingest. */
export const BUDGET_COMPACT_THRESHOLD_PCT = 85;

/** Percent usage above which a warning is logged. */
export const BUDGET_WARN_THRESHOLD_PCT = 70;

// ─── Compaction policy defaults ───────────────────────────────────────────────

/** Tombstone-to-live-record density that triggers compaction. */
export const DEFAULT_TOMBSTONE_DENSITY_THRESHOLD = 0.3;

/** Number of cycles without compaction before a cycle-limit compaction fires. */
export const DEFAULT_MAX_CYCLES_WITHOUT_COMPACT = 20;

/** Minimum tombstone count before density-based compaction is considered. */
export const DEFAULT_MIN_TOMBSTONES_FOR_DENSITY_CHECK = 5;

// ─── Semantic CLI ─────────────────────────────────────────────────────────────

/** Quality score below which semantic units are flagged as low quality. */
export const DEFAULT_LOW_QUALITY_THRESHOLD = 0.6;

/** Minimum quality score for auto-approval in semantic review. */
export const DEFAULT_SEMANTIC_APPROVAL_THRESHOLD = 0.7;

// ─── LLM ──────────────────────────────────────────────────────────────────────

/** HTTP request timeout for LLM calls (ms). */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

// ─── EmbeddingScheduler (AIMD) ────────────────────────────────────────────────

/** Cooldown after a rate-limit or server error before concurrency increases (ms). */
export const AIMD_COOLDOWN_MS = 5_000;

/** Scheduler-level concurrency cap (aggregates across concurrent files). */
export const DEFAULT_SCHEDULER_MAX_CONCURRENCY = 8;

/** Starting concurrency for AIMD ramp-up. */
export const DEFAULT_SCHEDULER_INITIAL_CONCURRENCY = 2;

/** Max milliseconds a queued chunk waits before a partial flush fires (ms). */
export const DEFAULT_SCHEDULER_MAX_QUEUE_AGE_MS = 150;

// ─── MCP sentinels ────────────────────────────────────────────────────────────

/** pipeline_signature used for records inserted directly via MCP. */
export const MCP_PIPELINE_SIGNATURE = "mcp";

/** Default embedding_model_id for records inserted directly via MCP. */
export const MCP_EMBEDDING_MODEL_ID = "mcp-unknown";

/** Prefix for chunk_hash when no hash is provided via MCP. */
export const MCP_CHUNK_ID_PREFIX = "mcp:";

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export const DEFAULT_LOCALHOST = "127.0.0.1";
export const DEFAULT_PUBLIC_PORT = 18080;
export const DEFAULT_INTERNAL_PORT = 19090;

/** How often workers must send a heartbeat (ms). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Minimum allowed heartbeat interval (ms). */
export const MIN_HEARTBEAT_INTERVAL_MS = 250;

/** Worker TTL — evicted if no heartbeat received within this window (ms). */
export const DEFAULT_WORKER_TTL_MS = 15_000;

/** Minimum health-tick interval (ms). */
export const MIN_TICK_INTERVAL_MS = 100;

/** Seconds to return in Retry-After when the queue is full. */
export const DEFAULT_RETRY_AFTER_SECS = 5;

/** Hard timeout for a single forwarded worker request (ms). */
export const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 300_000;

/** Max concurrent requests being forwarded to workers. */
export const ORCHESTRATOR_QUEUE_MAX = 128;

/** Max depth of the waiting queue before requests are rejected/shed. */
export const ORCHESTRATOR_QUEUE_DEPTH = 256;

/** How long a request waits in the queue before timing out (ms). */
export const ORCHESTRATOR_QUEUE_WAIT_MS = 10_000;
