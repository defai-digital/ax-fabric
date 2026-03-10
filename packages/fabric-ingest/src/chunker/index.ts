export {
  chunk,
  CHUNKER_VERSION,
  type ChunkerOptions,
  type Chunk,
} from "./chunker.js";

export type {
  ChunkingStrategy,
  ChunkOpts,
  LabeledChunk,
} from "./strategy.js";

export { FixedSizeChunker } from "./fixed.js";
export { StructuredTextChunker } from "./structured.js";
export { MarkdownChunker } from "./markdown.js";
export { detectStrategy, getStrategy } from "./auto-detect.js";
