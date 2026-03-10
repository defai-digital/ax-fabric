import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * TSV extractor that converts each row to a labelled key-value string.
 * Uses the first row as column headers.
 * Outputs a `Columns:` schema header for TableChunker compatibility.
 */
export class TsvExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const { parse } = await loadCsvParse();
      const records: string[][] = parse(content, {
        delimiter: "\t",
        skip_empty_lines: true,
        relax_column_count: true,
      });

      if (records.length === 0) return { text: "" };

      const headers = records[0]!;

      if (records.length === 1)
        return { text: `Columns: ${headers.join(", ")}` };

      const schemaLine = `Columns: ${headers.join(", ")}`;
      const dataRows = records.slice(1);
      const lines: string[] = [schemaLine];

      for (const row of dataRows) {
        const pairs: string[] = [];
        for (let i = 0; i < headers.length; i++) {
          const header = headers[i] ?? `Col${i + 1}`;
          const value = row[i] ?? "";
          pairs.push(`${header}: ${value}`);
        }
        lines.push(pairs.join(", "));
      }

      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract TSV content from ${filePath}`,
        err,
      );
    }
  }
}

/** Lazy-load csv-parse/sync. */
async function loadCsvParse() {
  const mod = await import("csv-parse/sync");
  return mod;
}
