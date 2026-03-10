import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * JSONL (JSON Lines) extractor.
 * Detects schema from the first row's keys and outputs a `Columns:` header
 * followed by key-value rows for TableChunker compatibility.
 */
export class JsonlExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      if (lines.length === 0) return { text: "" };

      const rows: Record<string, unknown>[] = lines.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );

      // Detect schema from first row's keys
      const columns = Object.keys(rows[0]!);
      const schemaLine = `Columns: ${columns.join(", ")}`;

      const dataLines = rows.map((row) =>
        columns.map((col) => `${col}: ${String(row[col] ?? "")}`).join(", "),
      );

      return { text: [schemaLine, ...dataLines].join("\n") };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract JSONL content from ${filePath}`,
        err,
      );
    }
  }
}
