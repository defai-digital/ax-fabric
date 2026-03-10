/**
 * FixedSizeChunker — wraps the existing chunk() function as a ChunkingStrategy.
 *
 * This is the v1.0 default behavior: fixed-size character-based chunks with
 * smart break points at paragraph/sentence/word boundaries.
 */

import type { ChunkingStrategy, ChunkOpts, LabeledChunk } from "./strategy.js";

export class FixedSizeChunker implements ChunkingStrategy {
  readonly name = "fixed";

  chunk(text: string, opts: ChunkOpts): LabeledChunk[] {
    if (text.length === 0) return [];

    const { maxChunkSize, overlap } = opts;
    const chunks: LabeledChunk[] = [];
    let position = 0;

    while (position < text.length) {
      const remaining = text.length - position;
      let end: number;

      if (remaining <= maxChunkSize) {
        end = text.length;
      } else {
        end = position + maxChunkSize;
        end = findBreakPoint(text, position, end);
      }

      chunks.push({
        text: text.slice(position, end),
        label: "text",
        offset: position,
      });

      if (end >= text.length) break;

      const advance = Math.max(1, end - position - overlap);
      position += advance;
    }

    return chunks;
  }
}

function findBreakPoint(text: string, start: number, maxEnd: number): number {
  const searchStart = start + Math.floor((maxEnd - start) * 0.5);
  const window = text.slice(searchStart, maxEnd);

  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx !== -1) return searchStart + paraIdx + 2;

  const sentenceIdx = findLastSentenceEnd(window);
  if (sentenceIdx !== -1) return searchStart + sentenceIdx;

  const spaceIdx = window.lastIndexOf(" ");
  if (spaceIdx !== -1) return searchStart + spaceIdx + 1;

  const nlIdx = window.lastIndexOf("\n");
  if (nlIdx !== -1) return searchStart + nlIdx + 1;

  return maxEnd;
}

function findLastSentenceEnd(window: string): number {
  for (let i = window.length - 1; i >= 1; i--) {
    const ch = window[i];
    if (ch === " " || ch === "\n") {
      const prev = window[i - 1];
      if (prev === "." || prev === "?" || prev === "!") {
        return i + 1;
      }
    }
  }
  return -1;
}
