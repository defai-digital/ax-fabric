import type { ChunkOpts, ChunkingStrategy, LabeledChunk } from "./strategy.js";

// Timestamp patterns for log entry detection
const TIMESTAMP_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/, // ISO 8601
  /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/, // Bracketed ISO
  /^\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/, // Common log format
  /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/, // Syslog format
  /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/, // Slash date format
];

function isTimestampLine(line: string): boolean {
  return TIMESTAMP_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Log-aware chunker that groups log entries and never splits multi-line entries
 * (e.g., stack traces).
 *
 * Falls back to grouping by line count if no timestamp pattern is detected.
 */
export class LogChunker implements ChunkingStrategy {
  readonly name = "log";

  chunk(text: string, opts: ChunkOpts): LabeledChunk[] {
    const lines = text.split("\n");
    if (lines.length === 0 || (lines.length === 1 && lines[0]!.trim() === ""))
      return [];

    // Detect if timestamps are present by checking the first 20 lines
    const sampleLines = lines.slice(0, 20);
    const hasTimestamps = sampleLines.some((l) => isTimestampLine(l));

    if (!hasTimestamps) {
      // Fall back to simple line-based chunking
      return this.chunkByLines(lines, opts);
    }

    // Group lines into log entries (a new entry starts with a timestamp)
    const entries: string[] = [];
    let currentEntry: string[] = [];

    for (const line of lines) {
      if (isTimestampLine(line) && currentEntry.length > 0) {
        entries.push(currentEntry.join("\n"));
        currentEntry = [];
      }
      currentEntry.push(line);
    }
    if (currentEntry.length > 0) {
      entries.push(currentEntry.join("\n"));
    }

    // Group entries into chunks respecting maxChunkSize
    const chunks: LabeledChunk[] = [];
    let currentChunkEntries: string[] = [];
    let currentSize = 0;
    let offset = 0;

    for (const entry of entries) {
      const entrySize = entry.length + 1;

      if (
        currentSize + entrySize > opts.maxChunkSize &&
        currentChunkEntries.length > 0
      ) {
        const chunkText = currentChunkEntries.join("\n");
        chunks.push({ text: chunkText, label: "text", offset });
        offset += chunkText.length + 1;
        currentChunkEntries = [];
        currentSize = 0;
      }

      // If a single entry exceeds maxChunkSize, emit it as its own chunk
      if (entrySize > opts.maxChunkSize && currentChunkEntries.length === 0) {
        chunks.push({ text: entry, label: "text", offset });
        offset += entry.length + 1;
        continue;
      }

      currentChunkEntries.push(entry);
      currentSize += entrySize;
    }

    if (currentChunkEntries.length > 0) {
      chunks.push({
        text: currentChunkEntries.join("\n"),
        label: "text",
        offset,
      });
    }

    return chunks;
  }

  private chunkByLines(lines: string[], opts: ChunkOpts): LabeledChunk[] {
    const chunks: LabeledChunk[] = [];
    let currentLines: string[] = [];
    let currentSize = 0;
    let offset = 0;

    for (const line of lines) {
      const lineSize = line.length + 1;

      if (
        currentSize + lineSize > opts.maxChunkSize &&
        currentLines.length > 0
      ) {
        const chunkText = currentLines.join("\n");
        chunks.push({ text: chunkText, label: "text", offset });
        offset += chunkText.length + 1;
        currentLines = [];
        currentSize = 0;
      }

      currentLines.push(line);
      currentSize += lineSize;
    }

    if (currentLines.length > 0) {
      const chunkText = currentLines.join("\n");
      chunks.push({ text: chunkText, label: "text", offset });
    }

    return chunks;
  }
}
