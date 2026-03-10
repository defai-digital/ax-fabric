/**
 * MarkdownChunker — heading-based section chunking for Markdown documents.
 *
 * Splits on headings (# to ######), keeping each section as a chunk.
 * Sections that exceed maxChunkSize are sub-chunked at paragraph boundaries.
 */

import type { ChunkingStrategy, ChunkOpts, LabeledChunk } from "./strategy.js";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

interface Section {
  heading: string;
  level: number;
  body: string;
  offset: number;
}

export class MarkdownChunker implements ChunkingStrategy {
  readonly name = "markdown";

  chunk(text: string, opts: ChunkOpts): LabeledChunk[] {
    if (text.length === 0) return [];

    const sections = splitIntoSections(text);
    const chunks: LabeledChunk[] = [];

    for (const section of sections) {
      const fullText = section.heading
        ? `${section.heading}\n\n${section.body}`.trim()
        : section.body.trim();

      if (fullText.length === 0) continue;

      if (fullText.length <= opts.maxChunkSize) {
        chunks.push({
          text: fullText,
          label: section.heading ? "heading" : "paragraph",
          offset: section.offset,
        });
      } else {
        // Sub-chunk at paragraph boundaries.
        const subChunks = subChunkSection(fullText, section.offset, opts);
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }
}

function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentBody: string[] = [];
  let currentOffset = 0;
  let lineOffset = 0;

  function flushSection() {
    const body = currentBody.join("\n");
    if (body.trim().length > 0 || currentHeading) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        body: body.trim(),
        offset: currentOffset,
      });
    }
    currentBody = [];
    currentHeading = "";
    currentLevel = 0;
  }

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flushSection();
      currentOffset = lineOffset;
      currentHeading = line;
      currentLevel = match[1]!.length;
    } else {
      if (currentBody.length === 0 && !currentHeading && sections.length === 0) {
        currentOffset = lineOffset;
      }
      currentBody.push(line);
    }
    lineOffset += line.length + 1;
  }

  flushSection();
  return sections;
}

function subChunkSection(
  text: string,
  baseOffset: number,
  opts: ChunkOpts,
): LabeledChunk[] {
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
      // Try paragraph boundary.
      const searchStart = position + Math.floor(maxChunkSize * 0.5);
      const window = text.slice(searchStart, end);
      const paraIdx = window.lastIndexOf("\n\n");
      if (paraIdx !== -1) {
        end = searchStart + paraIdx + 2;
      } else {
        const nlIdx = window.lastIndexOf("\n");
        if (nlIdx !== -1) {
          end = searchStart + nlIdx + 1;
        }
      }
    }

    const chunkText = text.slice(position, end);
    chunks.push({
      text: chunkText,
      label: position === 0 ? "heading" : "paragraph",
      offset: baseOffset + position,
    });

    if (end >= text.length) break;
    const advance = Math.max(1, end - position - overlap);
    position += advance;
  }

  return chunks;
}
