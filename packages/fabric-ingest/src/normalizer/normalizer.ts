/**
 * Deterministic text normalizer for the fabric-ingest pipeline.
 * Produces identical output for identical input on any platform.
 */

/** Version string for pipeline signature tracking. */
export const NORMALIZER_VERSION = "1.0.0";

/**
 * Normalize text through a deterministic sequence of transformations.
 *
 * Steps (in order):
 * 1. Unicode NFC normalization
 * 2. CRLF / CR -> LF (Unix line endings)
 * 3. Tabs -> single space
 * 4. Collapse consecutive spaces (preserve newlines)
 * 5. Collapse 3+ consecutive newlines into 2 newlines
 * 6. Trim leading/trailing whitespace
 */
export function normalize(text: string): string {
  let result = text;

  // 1. Unicode NFC normalization
  result = result.normalize("NFC");

  // 2. Normalize line endings: \r\n and standalone \r -> \n
  result = result.replace(/\r\n/g, "\n");
  result = result.replace(/\r/g, "\n");

  // 3. Replace tabs with a single space
  result = result.replace(/\t/g, " ");

  // 4. Collapse multiple consecutive spaces into one (preserve newlines)
  result = result.replace(/ {2,}/g, " ");

  // 5. Collapse 3+ consecutive newlines into exactly 2 newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  // 6. Trim leading and trailing whitespace
  result = result.trim();

  return result;
}
