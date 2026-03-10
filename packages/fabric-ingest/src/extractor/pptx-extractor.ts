import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * PPTX extractor using minimal ZIP parsing.
 *
 * PPTX files are ZIP archives containing XML slides at
 * `ppt/slides/slide1.xml`, `ppt/slides/slide2.xml`, etc.
 * Text content lives inside `<a:t>` XML tags.
 */
export class PptxExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const buffer = await readFile(filePath);
      const entries = parseZipEntries(buffer);

      const slideEntries = entries
        .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const slideTexts: string[] = [];
      for (const entry of slideEntries) {
        const xml = decompressEntry(buffer, entry);
        const text = extractTextFromXml(xml);
        if (text.length > 0) {
          slideTexts.push(text);
        }
      }

      return { text: slideTexts.join("\n\n") };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract PPTX content from ${filePath}`,
        err,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Minimal ZIP parsing (local file headers only)                     */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  dataOffset: number;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const MAX_COMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Walk local file headers in a ZIP buffer and collect entries.
 */
function parseZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  let totalUncompressed = 0;

  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== LOCAL_FILE_HEADER_SIG) break;

    const compressionMethod = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const dataOffset = nameEnd + extraLen;
    const dataEnd = dataOffset + compressedSize;
    if (nameEnd > buf.length || dataEnd > buf.length) {
      throw new AxFabricError("EXTRACT_ERROR", "Malformed ZIP entry in PPTX");
    }
    if (compressedSize > MAX_COMPRESSED_ENTRY_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "PPTX ZIP entry exceeds compressed size limit");
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "PPTX ZIP entry exceeds uncompressed size limit");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "PPTX ZIP total uncompressed size exceeds limit");
    }
    const name = buf.subarray(nameStart, nameEnd).toString("utf-8");

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, dataOffset });
    offset = dataEnd;
  }

  return entries;
}

/**
 * Decompress a single ZIP entry to a UTF-8 string.
 */
function decompressEntry(buf: Buffer, entry: ZipEntry): string {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return raw.toString("utf-8");
  }
  if (entry.compressionMethod !== 8) {
    throw new AxFabricError("EXTRACT_ERROR", `Unsupported PPTX ZIP compression method: ${String(entry.compressionMethod)}`);
  }

  // Deflated
  const inflated = inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED_ENTRY_BYTES });
  if (inflated.length > MAX_UNCOMPRESSED_ENTRY_BYTES) {
    throw new AxFabricError("EXTRACT_ERROR", "PPTX ZIP inflated entry exceeds uncompressed size limit");
  }
  return inflated.toString("utf-8");
}

/**
 * Extract all text from `<a:t>` tags in an XML string.
 */
function extractTextFromXml(xml: string): string {
  const matches: string[] = [];
  const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const content = match[1];
    if (content !== undefined) {
      matches.push(content);
    }
  }

  return matches.join(" ");
}
