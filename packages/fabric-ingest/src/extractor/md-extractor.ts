import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

export class MdExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const text = await readFile(filePath, "utf-8");
      return { text };
    } catch (err) {
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract Markdown from ${filePath}`,
        err,
      );
    }
  }
}
