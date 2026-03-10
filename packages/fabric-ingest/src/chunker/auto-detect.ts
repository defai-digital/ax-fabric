/**
 * Auto-detect the best chunking strategy based on file extension.
 */

import type { ChunkingStrategy } from "./strategy.js";
import { FixedSizeChunker } from "./fixed.js";
import { MarkdownChunker } from "./markdown.js";
import { StructuredTextChunker } from "./structured.js";

const markdown = new MarkdownChunker();
const structured = new StructuredTextChunker();
const fixed = new FixedSizeChunker();

/**
 * Select a chunking strategy based on the file extension.
 *
 * - `.md` → MarkdownChunker
 * - `.pdf`, `.docx`, `.txt` → StructuredTextChunker
 * - everything else → FixedSizeChunker
 *
 * Can be overridden by specifying a strategy name directly.
 */
export function detectStrategy(
  filenameOrExt: string,
  override?: "fixed" | "structured" | "markdown",
): ChunkingStrategy {
  if (override) return getStrategy(override);

  const ext = filenameOrExt.includes(".")
    ? filenameOrExt.slice(filenameOrExt.lastIndexOf(".")).toLowerCase()
    : filenameOrExt.toLowerCase();

  switch (ext) {
    case ".md":
    case ".markdown":
      return markdown;
    case ".pdf":
    case ".docx":
    case ".pptx":
    case ".txt":
      return structured;
    default:
      return fixed;
  }
}

export function getStrategy(
  name: "fixed" | "structured" | "markdown",
): ChunkingStrategy {
  switch (name) {
    case "markdown":
      return markdown;
    case "structured":
      return structured;
    case "fixed":
      return fixed;
  }
}
