import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * Log file extractor — reads the raw file content.
 * Chunking is handled by LogChunker which understands log entry boundaries.
 */
export class LogExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const text = await readFile(filePath, "utf-8");
      return { text };
    } catch (err) {
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract log content from ${filePath}`,
        err,
      );
    }
  }
}
