/**
 * StructuredTextChunker — preserves structural elements (tables, code blocks, lists).
 *
 * First splits text into structural blocks, then applies fixed-size chunking
 * within each block. Blocks that are smaller than maxChunkSize are kept whole.
 */

import type { ChunkingStrategy, ChunkOpts, LabeledChunk } from "./strategy.js";

interface Block {
  text: string;
  label: LabeledChunk["label"];
  offset: number;
}

export class StructuredTextChunker implements ChunkingStrategy {
  readonly name = "structured";

  chunk(text: string, opts: ChunkOpts): LabeledChunk[] {
    if (text.length === 0) return [];

    const blocks = splitIntoBlocks(text);
    const chunks: LabeledChunk[] = [];

    for (const block of blocks) {
      if (block.text.length <= opts.maxChunkSize) {
        chunks.push({
          text: block.text,
          label: block.label,
          offset: block.offset,
        });
      } else {
        // Sub-chunk large blocks using overlap.
        const subChunks = subChunkBlock(block, opts);
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }
}

// ── Block detection ──────────────────────────────────────────────────────────

const CODE_FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\|.+\|$/;
const LIST_ITEM_RE = /^(\s*([-*+]|\d+\.)\s)/;

function splitIntoBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let currentLines: string[] = [];
  let currentLabel: LabeledChunk["label"] = "paragraph";
  let currentOffset = 0;
  let lineOffset = 0;
  let inCodeFence = false;

  function flushBlock() {
    if (currentLines.length === 0) return;
    const blockText = currentLines.join("\n");
    if (blockText.trim().length > 0) {
      blocks.push({
        text: blockText,
        label: currentLabel,
        offset: currentOffset,
      });
    }
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (CODE_FENCE_RE.test(line.trimStart())) {
      if (!inCodeFence) {
        flushBlock();
        currentOffset = lineOffset;
        currentLabel = "code";
        currentLines.push(line);
        inCodeFence = true;
      } else {
        currentLines.push(line);
        inCodeFence = false;
        flushBlock();
        currentLabel = "paragraph";
        currentOffset = lineOffset + line.length + 1;
      }
      lineOffset += line.length + 1;
      continue;
    }

    if (inCodeFence) {
      currentLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const newLabel = detectLineLabel(line);

    if (line.trim() === "") {
      // Blank line — potential paragraph boundary.
      if (currentLines.length > 0) {
        currentLines.push(line);
      }
      lineOffset += line.length + 1;
      continue;
    }

    if (newLabel !== currentLabel && currentLines.length > 0) {
      flushBlock();
      currentOffset = lineOffset;
      currentLabel = newLabel;
    } else if (currentLines.length === 0) {
      currentOffset = lineOffset;
      currentLabel = newLabel;
    }

    currentLines.push(line);
    lineOffset += line.length + 1;
  }

  // Don't forget unclosed code fences.
  flushBlock();

  return blocks;
}

function detectLineLabel(line: string): LabeledChunk["label"] {
  const trimmed = line.trimStart();
  if (TABLE_ROW_RE.test(trimmed)) return "table";
  if (LIST_ITEM_RE.test(trimmed)) return "list";
  return "paragraph";
}

// ── Sub-chunking ─────────────────────────────────────────────────────────────

function subChunkBlock(block: Block, opts: ChunkOpts): LabeledChunk[] {
  const { maxChunkSize, overlap } = opts;
  const text = block.text;
  const chunks: LabeledChunk[] = [];
  let position = 0;

  while (position < text.length) {
    const remaining = text.length - position;
    let end: number;

    if (remaining <= maxChunkSize) {
      end = text.length;
    } else {
      end = position + maxChunkSize;
      // Try to break at a newline.
      const searchStart = position + Math.floor(maxChunkSize * 0.5);
      const window = text.slice(searchStart, end);
      const nlIdx = window.lastIndexOf("\n");
      if (nlIdx !== -1) {
        end = searchStart + nlIdx + 1;
      }
    }

    chunks.push({
      text: text.slice(position, end),
      label: block.label,
      offset: block.offset + position,
    });

    if (end >= text.length) break;
    const advance = Math.max(1, end - position - overlap);
    position += advance;
  }

  return chunks;
}
