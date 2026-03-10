import type { ChunkOpts, ChunkingStrategy, LabeledChunk } from "./strategy.js";

/**
 * Table-aware chunker that keeps rows atomic and prepends schema context.
 *
 * Input format expected from extractors:
 * - First line: `Columns: col1, col2, col3` (schema header)
 * - Remaining lines: `col1: val1, col2: val2, col3: val3` (data rows)
 *
 * Each output chunk starts with the schema header for context.
 */
export class TableChunker implements ChunkingStrategy {
  readonly name = "table";

  chunk(text: string, opts: ChunkOpts): LabeledChunk[] {
    const lines = text.split("\n");
    if (lines.length === 0) return [];

    // Detect schema header line
    const firstLine = lines[0]!;
    const hasSchemaHeader = firstLine.startsWith("Columns:");
    const schemaLine = hasSchemaHeader ? firstLine : "";
    const dataLines = hasSchemaHeader
      ? lines.slice(1).filter((l) => l.trim().length > 0)
      : lines.filter((l) => l.trim().length > 0);

    if (dataLines.length === 0) return [];

    const schemaPrefix = schemaLine ? schemaLine + "\n---\n" : "";
    const schemaPrefixLen = schemaPrefix.length;
    const chunks: LabeledChunk[] = [];
    let currentLines: string[] = [];
    let currentSize = schemaPrefixLen;
    // Offset into the original text (skip schema line + newline if present)
    let sourceOffset = hasSchemaHeader ? firstLine.length + 1 : 0;
    let chunkOffset = sourceOffset;

    for (const line of dataLines) {
      const lineSize = line.length + 1; // +1 for newline

      // If adding this line would exceed maxChunkSize and we have data, flush
      if (currentSize + lineSize > opts.maxChunkSize && currentLines.length > 0) {
        chunks.push({
          text: schemaPrefix + currentLines.join("\n"),
          label: "table",
          offset: chunkOffset,
        });
        const dataLen = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
        chunkOffset += dataLen;
        currentLines = [];
        currentSize = schemaPrefixLen;
      }

      // If a single row exceeds maxChunkSize, emit it as its own chunk
      if (schemaPrefixLen + lineSize > opts.maxChunkSize && currentLines.length === 0) {
        chunks.push({
          text: schemaPrefix + line,
          label: "table",
          offset: chunkOffset,
        });
        chunkOffset += lineSize;
        continue;
      }

      currentLines.push(line);
      currentSize += lineSize;
    }

    // Flush remaining
    if (currentLines.length > 0) {
      chunks.push({
        text: schemaPrefix + currentLines.join("\n"),
        label: "table",
        offset: chunkOffset,
      });
    }

    return chunks;
  }
}
