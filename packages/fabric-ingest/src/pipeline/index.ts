export { Pipeline } from "./pipeline.js";
export type {
  PipelineOptions,
  PipelineMetrics,
  PipelineFileError,
} from "./pipeline.js";
export type { EmbedStats } from "../observer/types.js";

export {
  stageExtract,
  stageNormalize,
  stageChunk,
  stageEmbed,
  stageBuild,
} from "./stages.js";
export type {
  ExtractOutput,
  NormalizeOutput,
  ChunkItem,
  ChunkOutput,
  EmbedOutput,
  BuildOutput,
} from "./stages.js";
