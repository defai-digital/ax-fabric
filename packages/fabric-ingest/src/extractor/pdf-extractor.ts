import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

export class PdfExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const pdfParse = await loadPdfParse();
      const buffer = await readFile(filePath);
      const result = await pdfParse(buffer);

      return {
        text: result.text,
        pageRange: result.numpages > 0 ? `1-${result.numpages}` : undefined,
      };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract PDF content from ${filePath}`,
        err,
      );
    }
  }
}

/** Lazy-load pdf-parse to keep startup fast. */
async function loadPdfParse() {
  const mod = await import("pdf-parse");
  return mod.default;
}
