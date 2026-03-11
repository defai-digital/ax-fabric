// fabric-ingest — Phase 1 ingestion pipeline (Milestone 2)

// ─── Layer 2.1: Scanner ─────────────────────────────────────────────────────
export {
  computeFingerprint,
  computeSampledFingerprint,
  fingerprint,
  SourceScanner,
  type ContentType,
  type ScanResult,
  type ChangeSet,
} from "./scanner/index.js";

// ─── Layer 2.3: Normalizer ──────────────────────────────────────────────────
export { normalize, NORMALIZER_VERSION } from "./normalizer/index.js";

// ─── Layer 2.4: Chunker ────────────────────────────────────────────────────
export {
  chunk,
  CHUNKER_VERSION,
  type ChunkerOptions,
  type Chunk,
} from "./chunker/index.js";

// ─── Layer 2.5: Embedder Providers ─────────────────────────────────────────
export {
  MockEmbedder,
  type MockEmbedderOptions,
  HttpEmbedder,
  type HttpEmbedderOptions,
} from "./embedder/index.js";

// ─── Layer 2.6: Record Builder ─────────────────────────────────────────────
export {
  RecordBuilder,
  type RecordBuilderOptions,
  type ChunkWithEmbedding,
} from "./builder/index.js";

// ─── Layer 2.7: Batch Publisher ─────────────────────────────────────────────
export {
  BatchPublisher,
  type BatchPublisherOptions,
} from "./publisher/index.js";

// ─── Layer 2.7b: Memory Store ──────────────────────────────────────────────
export {
  MemoryStore,
  type MemoryKind,
  type MemoryRecord,
  type PutMemoryInput,
  type ListMemoryOptions,
  type AssembleContextOptions,
} from "./memory/index.js";

// ─── Layer 2.8: Job Registry ───────────────────────────────────────────────
export {
  JobRegistry,
  type FileRecord,
} from "./registry/index.js";

// ─── Layer 2.9: Pipeline Orchestrator ─────────────────────────────────────
export {
  Pipeline,
  type PipelineOptions,
  type PipelineMetrics,
  type PipelineFileError,
} from "./pipeline/index.js";

// ─── Layer 2.2: Extractors ────────────────────────────────────────────────
export {
  EXTRACTOR_VERSION,
  createDefaultRegistry,
  ExtractorRegistry,
  type ExtractedContent,
  type Extractor,
} from "./extractor/index.js";

// ─── Layer 2.2b: Semantic Distillation ─────────────────────────────────────
export {
  SemanticDistiller,
  type SemanticDistillOptions,
  type SemanticDistillResult,
  SemanticReviewEngine,
  type SemanticReviewOptions,
  type SemanticApprovalOptions,
  SemanticStore,
  type SemanticBundleSummary,
  type SemanticPublicationState,
  type StoredSemanticBundle,
  type SemanticUnitLookup,
  type SemanticPublishedBundleRef,
} from "./semantic/index.js";

// ─── Layer 3.0: MCP Server ─────────────────────────────────────────────────
export {
  createMcpServer,
  authenticateRequest,
  type McpServerOptions,
  registerAkiDbTools,
  registerFabricTools,
  type FabricToolsDeps,
  registerResources,
  type ResourceDeps,
  generateToken,
  readToken,
  ensureToken,
  validateToken,
} from "./mcp/index.js";

// ─── Layer 4.0: Orchestrator ───────────────────────────────────────────────
export {
  createOrchestratorServer,
  type OrchestratorServer,
  type OrchestratorServerConfig,
  type OrchestratorServerPorts,
  WorkerRegistry,
  type WorkerCounts,
  type WorkerHealth,
  type WorkerSnapshot,
  type WorkerStatus,
  type RegisterRequest,
  type RegisterResponse,
  type HeartbeatRequest,
  policyFromName,
  LeastInflightPolicy,
  WeightedRoundRobinPolicy,
  type DispatchPolicy,
  GlobalQueue,
  type GlobalQueueConfig,
  type QueuePermit,
  type AcquireResult,
  type OverloadPolicy,
  DirectDispatcher,
  type DispatchResult,
} from "./orchestrator/index.js";
