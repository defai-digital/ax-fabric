import { createHash } from "node:crypto";

/** Version string for pipeline signature tracking. */
export const CHUNKER_VERSION = "1.0.0";

/** Configuration options for the chunker. */
export interface ChunkerOptions {
  /** Target chunk size in characters. Default: 2800 (~700 tokens). */
  chunkSize?: number;
  /** Overlap ratio between consecutive chunks. Default: 0.15. */
  overlapRatio?: number;
}

/** A single chunk produced by the chunker. */
export interface Chunk {
  /** The chunk text content. */
  text: string;
  /** Character offset of this chunk in the source text. */
  offset: number;
  /** SHA-256 hex digest of the chunk text. */
  chunkHash: string;
  /** SHA-256 hex digest of (docId + docVersion + offset + chunkHash). */
  chunkId: string;
}

const DEFAULT_CHUNK_SIZE = 2800;
const DEFAULT_OVERLAP_RATIO = 0.15;

/**
 * Fixed-size character-based chunker with overlap.
 *
 * Attempts to break at paragraph boundaries (double newline), falling back
 * to sentence boundaries (period/question/exclamation followed by space),
 * then word boundaries (space), and finally hard-cuts at chunkSize.
 *
 * Deterministic: same input always produces same chunks with same IDs.
 */
export function chunk(
  text: string,
  docId: string,
  docVersion: string,
  options?: ChunkerOptions,
): Chunk[] {
  if (text.length === 0) return [];

  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlapRatio = options?.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const overlapSize = Math.floor(chunkSize * overlapRatio);

  const chunks: Chunk[] = [];
  let position = 0;

  while (position < text.length) {
    const remaining = text.length - position;
    let end: number;

    if (remaining <= chunkSize) {
      // Last chunk: take everything remaining
      end = text.length;
    } else {
      // Find the best break point within the chunk window
      end = position + chunkSize;
      end = findBreakPoint(text, position, end);
    }

    const chunkText = text.slice(position, end);
    const chunkHash = sha256(chunkText);
    const chunkId = sha256(docId + docVersion + String(position) + chunkHash);

    chunks.push({
      text: chunkText,
      offset: position,
      chunkHash,
      chunkId,
    });

    // If we consumed all remaining text, we're done
    if (end >= text.length) break;

    // Advance position: move forward by (chunkLength - overlap)
    const advance = Math.max(1, (end - position) - overlapSize);
    position += advance;
  }

  return chunks;
}

/**
 * Find the best break point at or before `maxEnd` but after `start`.
 * Prefers: paragraph boundary > sentence boundary > word boundary > hard cut.
 */
function findBreakPoint(text: string, start: number, maxEnd: number): number {
  // Search zone: look backwards from maxEnd within the chunk window
  const searchStart = start + Math.floor((maxEnd - start) * 0.5);
  const window = text.slice(searchStart, maxEnd);

  // 1. Try paragraph boundary (double newline)
  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx !== -1) {
    return searchStart + paraIdx + 2; // Include the double newline
  }

  // 2. Try sentence boundary (. or ? or ! followed by space or newline)
  const sentenceMatch = findLastSentenceEnd(window);
  if (sentenceMatch !== -1) {
    return searchStart + sentenceMatch;
  }

  // 3. Try word boundary (last space)
  const spaceIdx = window.lastIndexOf(" ");
  if (spaceIdx !== -1) {
    return searchStart + spaceIdx + 1; // Break after the space
  }

  // 4. Try newline boundary
  const nlIdx = window.lastIndexOf("\n");
  if (nlIdx !== -1) {
    return searchStart + nlIdx + 1;
  }

  // 5. Hard cut at maxEnd
  return maxEnd;
}

/**
 * Find the last sentence-ending position in the window.
 * Looks for `.`, `?`, or `!` followed by a space or newline.
 * Returns the index AFTER the whitespace (i.e., the start of the next sentence).
 */
function findLastSentenceEnd(window: string): number {
  let lastIdx = -1;

  for (let i = window.length - 1; i >= 1; i--) {
    const ch = window[i];
    if (ch === " " || ch === "\n") {
      const prev = window[i - 1];
      if (prev === "." || prev === "?" || prev === "!") {
        lastIdx = i + 1;
        break;
      }
    }
  }

  return lastIdx;
}

/** Compute SHA-256 hex digest of a string. */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
