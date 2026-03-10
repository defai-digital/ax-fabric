import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

export class DocxExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const mammoth = await loadMammoth();
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract DOCX content from ${filePath}`,
        err,
      );
    }
  }
}

/** Lazy-load mammoth. */
async function loadMammoth() {
  const mod = await import("mammoth");
  return mod.default;
}
