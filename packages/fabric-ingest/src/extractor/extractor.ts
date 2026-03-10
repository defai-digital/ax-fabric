/**
 * Extractor interface and types for the fabric-ingest pipeline (Layer 2.2).
 * Each extractor converts a specific file format into plain text.
 */

/** Shared version for all extractors that ship together. */
export const EXTRACTOR_VERSION = "1.0.0";

/** Result of extracting content from a file. */
export interface ExtractedContent {
  /** Extracted plain text. */
  text: string;
  /** Page range string, e.g. "1-5" for PDFs. Undefined for non-paged formats. */
  pageRange?: string;
  /** Sheet/table name for tabular formats. Undefined for non-tabular formats. */
  tableRef?: string;
}

/** Contract that every format extractor must satisfy. */
export interface Extractor {
  /** Version string used for pipeline signature tracking. */
  readonly version: string;
  /** Extract plain text from the file at the given path. */
  extract(filePath: string): Promise<ExtractedContent>;
}
