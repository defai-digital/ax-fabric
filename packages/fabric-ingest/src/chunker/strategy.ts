/**
 * ChunkingStrategy — pluggable chunking interface for v2.5.
 *
 * Implementations: FixedSizeChunker, StructuredTextChunker, MarkdownChunker.
 */

export interface ChunkOpts {
  /** Maximum chunk size in characters. */
  maxChunkSize: number;
  /** Overlap in characters between consecutive chunks. */
  overlap: number;
}

export interface LabeledChunk {
  /** Chunk text content. */
  text: string;
  /** Semantic label for the chunk type. */
  label: "paragraph" | "heading" | "table" | "code" | "list" | "text";
  /** Character offset in the source text. */
  offset: number;
}

export interface ChunkingStrategy {
  /** Strategy identifier for pipeline signature tracking. */
  readonly name: string;
  /** Split text into labeled chunks. */
  chunk(text: string, opts: ChunkOpts): LabeledChunk[];
}
