/**
 * Pipeline Stage Contracts — typed input/output for each stage of the ingest pipeline.
 *
 * Each stage is a pure function: same input → same output, no side effects.
 * The Pipeline orchestrator calls stages in sequence and owns all side effects
 * (registry writes, publisher batching, error isolation).
 *
 * Flow:
 *   ScanResult → [extract] → ExtractOutput
 *             → [normalize] → NormalizeOutput
 *             → [chunk] → ChunkOutput
 *             → [embed] → EmbedOutput
 *             → [build] → BuildOutput
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { Record } from "@ax-fabric/contracts";

import type { ScanResult } from "../scanner/index.js";
import type { ExtractorRegistry } from "../extractor/index.js";
import type { EmbedderProvider } from "@ax-fabric/contracts";
import { normalize } from "../normalizer/index.js";
import { chunk } from "../chunker/index.js";
import type { ChunkerOptions } from "../chunker/index.js";
import { RecordBuilder } from "../builder/index.js";
import type { ChunkWithEmbedding } from "../builder/index.js";

// ─── Stage output types ───────────────────────────────────────────────────────

export interface ExtractOutput {
  text: string;
  pageRange: string | null;
  tableRef: string | null;
}

export interface NormalizeOutput {
  normalizedText: string;
}

export interface ChunkItem {
  chunkId: string;
  chunkHash: string;
  text: string;
  offset: number;
}

export interface ChunkOutput {
  docId: string;
  docVersion: string;
  chunks: ChunkItem[];
}

export interface EmbedOutput {
  docId: string;
  docVersion: string;
  chunks: ChunkItem[];
  vectors: number[][];
}

export interface BuildOutput {
  records: Record[];
}

// ─── Stage functions ──────────────────────────────────────────────────────────

/** Stage 1: Extract raw text and metadata from a file. */
export async function stageExtract(
  file: ScanResult,
  extractorRegistry: ExtractorRegistry,
): Promise<ExtractOutput | null> {
  const extractor = extractorRegistry.getExtractor(file.sourcePath);
  if (!extractor) {
    throw new AxFabricError("EXTRACT_ERROR", `No extractor registered for: ${file.sourcePath}`);
  }
  const extracted = await extractor.extract(file.sourcePath);
  if (!extracted.text.trim()) return null;
  return {
    text: extracted.text,
    pageRange: extracted.pageRange ?? null,
    tableRef: extracted.tableRef ?? null,
  };
}

/** Stage 2: Normalize extracted text (Unicode NFC, whitespace, line endings). */
export function stageNormalize(extracted: ExtractOutput): NormalizeOutput {
  return { normalizedText: normalize(extracted.text) };
}

/** Stage 3: Chunk normalized text into overlapping segments. */
export function stageChunk(
  normalized: NormalizeOutput,
  file: ScanResult,
  options?: ChunkerOptions,
): ChunkOutput | null {
  const docId = RecordBuilder.computeDocId(file.sourcePath, file.fingerprint);
  const docVersion = file.fingerprint;
  const chunks = chunk(normalized.normalizedText, docId, docVersion, options);
  if (chunks.length === 0) return null;
  return {
    docId,
    docVersion,
    chunks: chunks.map((c) => ({
      chunkId: c.chunkId,
      chunkHash: c.chunkHash,
      text: c.text,
      offset: c.offset,
    })),
  };
}

/** Stage 4: Embed all chunks using the configured embedder. */
export async function stageEmbed(
  chunked: ChunkOutput,
  embedder: EmbedderProvider,
): Promise<EmbedOutput> {
  const texts = chunked.chunks.map((c) => c.text);
  const vectors = await embedder.embed(texts);

  if (vectors.length !== texts.length) {
    throw new AxFabricError(
      "EMBED_ERROR",
      `Embedder returned ${String(vectors.length)} vectors for ${String(texts.length)} chunks`,
    );
  }

  return {
    docId: chunked.docId,
    docVersion: chunked.docVersion,
    chunks: chunked.chunks,
    vectors,
  };
}

/** Stage 5: Assemble AkiDB Records from chunks + embeddings. */
export function stageBuild(
  embedded: EmbedOutput,
  file: ScanResult,
  extracted: ExtractOutput,
  builder: RecordBuilder,
): BuildOutput {
  const chunksWithEmbeddings: ChunkWithEmbedding[] = embedded.chunks.map((c, i) => ({
    chunkId: c.chunkId,
    chunkHash: c.chunkHash,
    text: c.text,
    offset: c.offset,
    vector: embedded.vectors[i]!,
    sourcePath: file.sourcePath,
    contentType: file.contentType,
    pageRange: extracted.pageRange,
    tableRef: extracted.tableRef,
  }));

  const records = builder.buildRecords(embedded.docId, embedded.docVersion, chunksWithEmbeddings);
  return { records };
}
