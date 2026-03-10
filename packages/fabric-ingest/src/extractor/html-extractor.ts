import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

export class HtmlExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const cheerio = await import("cheerio");
      const $ = cheerio.load(content);

      // Remove non-content elements
      $("script, style, nav, header, footer, noscript, iframe").remove();

      // Get body HTML, or full document if no body
      const bodyHtml = $("body").length > 0 ? $("body").html() ?? "" : $.html() ?? "";

      const text = htmlToMarkdown(bodyHtml);
      return { text };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract HTML content from ${filePath}`,
        err,
      );
    }
  }
}
