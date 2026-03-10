import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * XLSX extractor using minimal ZIP + XML parsing.
 *
 * XLSX files are ZIP archives containing:
 *   - `xl/sharedStrings.xml` — shared string table
 *   - `xl/worksheets/sheet1.xml`, `sheet2.xml`, ... — worksheet data
 *
 * Row-to-text approach (ADR-004): each row becomes
 * "Column1: value1, Column2: value2, ..."
 */
export class XlsxExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const buffer = await readFile(filePath);
      const entries = parseZipEntries(buffer);

      const sharedStrings = loadSharedStrings(buffer, entries);
      const sheetResults = extractSheets(buffer, entries, sharedStrings);

      const allText = sheetResults.map((s) => s.text).join("\n\n");
      const firstSheet = sheetResults[0];

      return {
        text: allText,
        tableRef: firstSheet?.name,
      };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract XLSX content from ${filePath}`,
        err,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Shared strings                                                    */
/* ------------------------------------------------------------------ */

function loadSharedStrings(buf: Buffer, entries: ZipEntry[]): string[] {
  const entry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  if (!entry) return [];

  const xml = decompressEntry(buf, entry);
  const strings: string[] = [];

  // Each <si> element contains one shared string; text is in <t> tags
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;

  while ((siMatch = siRegex.exec(xml)) !== null) {
    const siContent = siMatch[1] ?? "";
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    const parts: string[] = [];

    while ((tMatch = tRegex.exec(siContent)) !== null) {
      if (tMatch[1] !== undefined) {
        parts.push(tMatch[1]);
      }
    }
    strings.push(parts.join(""));
  }

  return strings;
}

/* ------------------------------------------------------------------ */
/*  Sheet extraction                                                  */
/* ------------------------------------------------------------------ */

interface SheetResult {
  name: string;
  text: string;
}

function extractSheets(
  buf: Buffer,
  entries: ZipEntry[],
  sharedStrings: string[],
): SheetResult[] {
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return sheetEntries.map((entry, idx) => {
    const xml = decompressEntry(buf, entry);
    const text = sheetXmlToText(xml, sharedStrings);
    return { name: `Sheet${idx + 1}`, text };
  });
}

/**
 * Convert a sheet XML to row-based text.
 * Uses column letters as headers when no explicit header row is detected.
 */
function sheetXmlToText(xml: string, sharedStrings: string[]): string {
  const rows = parseRows(xml, sharedStrings);
  if (rows.length === 0) return "";

  // Use first row as headers
  const headers = rows[0];
  if (!headers || headers.length === 0) return "";

  if (rows.length === 1) {
    return headers.join(", ");
  }

  const dataRows = rows.slice(1);
  const lines: string[] = [];

  for (const row of dataRows) {
    const pairs: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i] ?? `Col${i + 1}`;
      const value = row[i] ?? "";
      pairs.push(`${header}: ${value}`);
    }
    lines.push(pairs.join(", "));
  }

  return lines.join("\n");
}

function parseRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowContent = rowMatch[1] ?? "";
    const cells: Array<{ ref: string; value: string }> = [];
    const cellRegex = /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const ref = cellMatch[1] ?? "";
      const attrs = cellMatch[2] ?? "";
      const inner = cellMatch[3] ?? "";
      const value = resolveCellValue(attrs, inner, sharedStrings);
      cells.push({ ref, value });
    }

    // Convert cell refs to column indices to build a sparse row array
    const rowArr: string[] = [];
    for (const cell of cells) {
      const colIdx = colRefToIndex(cell.ref.replace(/\d+/g, ""));
      rowArr[colIdx] = cell.value;
    }
    rows.push(rowArr);
  }

  return rows;
}

function resolveCellValue(
  attrs: string,
  inner: string,
  sharedStrings: string[],
): string {
  const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (!vMatch) return "";

  const raw = vMatch[1] ?? "";

  // t="s" means shared string reference
  if (/t="s"/.test(attrs)) {
    const idx = parseInt(raw, 10);
    return sharedStrings[idx] ?? raw;
  }

  // t="inlineStr" — inline string
  if (/t="inlineStr"/.test(attrs)) {
    const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
    return tMatch?.[1] ?? raw;
  }

  return raw;
}

/**
 * Convert Excel column letter(s) to zero-based index.
 * A=0, B=1, ..., Z=25, AA=26, ...
 */
function colRefToIndex(col: string): number {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/* ------------------------------------------------------------------ */
/*  Minimal ZIP parsing (same approach as pptx-extractor)             */
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
      throw new AxFabricError("EXTRACT_ERROR", "Malformed ZIP entry in XLSX");
    }
    if (compressedSize > MAX_COMPRESSED_ENTRY_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "XLSX ZIP entry exceeds compressed size limit");
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "XLSX ZIP entry exceeds uncompressed size limit");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new AxFabricError("EXTRACT_ERROR", "XLSX ZIP total uncompressed size exceeds limit");
    }
    const name = buf.subarray(nameStart, nameEnd).toString("utf-8");

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, dataOffset });
    offset = dataEnd;
  }

  return entries;
}

function decompressEntry(buf: Buffer, entry: ZipEntry): string {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return raw.toString("utf-8");
  }
  if (entry.compressionMethod !== 8) {
    throw new AxFabricError("EXTRACT_ERROR", `Unsupported XLSX ZIP compression method: ${String(entry.compressionMethod)}`);
  }

  const inflated = inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED_ENTRY_BYTES });
  if (inflated.length > MAX_UNCOMPRESSED_ENTRY_BYTES) {
    throw new AxFabricError("EXTRACT_ERROR", "XLSX ZIP inflated entry exceeds uncompressed size limit");
  }
  return inflated.toString("utf-8");
}
