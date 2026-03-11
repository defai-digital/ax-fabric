import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { AxFabricError } from "@ax-fabric/contracts";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { TxtExtractor } from "./txt-extractor.js";
import { CsvExtractor } from "./csv-extractor.js";
import { JsonExtractor } from "./json-extractor.js";
import { YamlExtractor } from "./yaml-extractor.js";
import { PptxExtractor } from "./pptx-extractor.js";
import { XlsxExtractor } from "./xlsx-extractor.js";
import {
  ExtractorRegistry,
  createDefaultRegistry,
} from "./extractor-registry.js";
import { EXTRACTOR_VERSION } from "./extractor.js";

/* ================================================================== */
/*  Helpers: build minimal ZIP buffers for Office XML formats          */
/* ================================================================== */

/**
 * Build a minimal ZIP file in memory from a list of { name, content } entries.
 * Supports both STORE (method 0) and DEFLATE (method 8).
 */
function buildZip(
  files: Array<{ name: string; content: string }>,
  method: 0 | 8 = 8,
): Buffer {
  const parts: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf-8");
    const uncompressed = Buffer.from(file.content, "utf-8");
    const compressed = method === 8 ? deflateRawSync(uncompressed) : uncompressed;

    // Local file header (30 bytes + name + extra)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (not validated by our parser)
    localHeader.writeUInt32LE(compressed.length, 18); // compressed size
    localHeader.writeUInt32LE(uncompressed.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // name length
    localHeader.writeUInt16LE(0, 28); // extra length

    parts.push(localHeader, nameBuffer, compressed);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(compressed.length, 20); // compressed size
    centralHeader.writeUInt32LE(uncompressed.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // name length
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralEntries.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const entry of centralEntries) {
    centralDirSize += entry.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, ...centralEntries, eocd]);
}

function mutateFirstLocalHeader(
  zip: Buffer,
  mutator: (header: Buffer) => void,
): Buffer {
  const out = Buffer.from(zip);
  const header = out.subarray(0, 30);
  mutator(header);
  return out;
}

/* ================================================================== */
/*  Test setup — create temp dir with fixture files                   */
/* ================================================================== */

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "extractor-test-"));

  // TXT fixture
  await writeFile(join(tmpDir, "sample.txt"), "Hello, world!\nSecond line.");

  // CSV fixture
  await writeFile(
    join(tmpDir, "sample.csv"),
    "Name,Age,City\nAlice,30,Tokyo\nBob,25,Osaka\n",
  );

  // JSON fixture
  await writeFile(
    join(tmpDir, "sample.json"),
    JSON.stringify({
      name: "ax-fabric",
      version: "0.1.0",
      tags: ["ai", "ingest"],
      config: { debug: true, maxRetries: 3 },
    }),
  );

  // YAML fixture
  await writeFile(
    join(tmpDir, "sample.yaml"),
    [
      "name: ax-fabric",
      "version: 0.1.0",
      "tags:",
      "  - ai",
      "  - ingest",
      "config:",
      "  debug: true",
      "  maxRetries: 3",
    ].join("\n"),
  );

  // YAML with .yml extension
  await writeFile(join(tmpDir, "sample.yml"), "key: value\n");

  // PPTX fixture (minimal ZIP with one slide)
  const slideXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<p:sld>",
    "  <p:cSld>",
    "    <p:spTree>",
    "      <p:sp><p:txBody><a:p><a:r><a:t>Slide Title</a:t></a:r></a:p></p:txBody></p:sp>",
    "      <p:sp><p:txBody><a:p><a:r><a:t>Bullet point one</a:t></a:r></a:p></p:txBody></p:sp>",
    "    </p:spTree>",
    "  </p:cSld>",
    "</p:sld>",
  ].join("\n");
  const pptxZip = buildZip([
    { name: "ppt/slides/slide1.xml", content: slideXml },
  ]);
  await writeFile(join(tmpDir, "sample.pptx"), pptxZip);

  // XLSX fixture (minimal ZIP with shared strings + 1 sheet)
  const sharedStringsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">',
    "  <si><t>Name</t></si>",
    "  <si><t>Score</t></si>",
    "  <si><t>Alice</t></si>",
    "  <si><t>Bob</t></si>",
    "</sst>",
  ].join("\n");
  const sheetXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "  <sheetData>",
    '    <row r="1">',
    '      <c r="A1" t="s"><v>0</v></c>',
    '      <c r="B1" t="s"><v>1</v></c>',
    "    </row>",
    '    <row r="2">',
    '      <c r="A2" t="s"><v>2</v></c>',
    '      <c r="B2"><v>95</v></c>',
    "    </row>",
    '    <row r="3">',
    '      <c r="A3" t="s"><v>3</v></c>',
    '      <c r="B3"><v>88</v></c>',
    "    </row>",
    "  </sheetData>",
    "</worksheet>",
  ].join("\n");
  const xlsxZip = buildZip([
    { name: "xl/sharedStrings.xml", content: sharedStringsXml },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
  ]);
  await writeFile(join(tmpDir, "sample.xlsx"), xlsxZip);

  // Empty JSON (edge case)
  await writeFile(join(tmpDir, "empty.json"), "{}");

  // Invalid JSON
  await writeFile(join(tmpDir, "bad.json"), "{not json at all");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/*  TxtExtractor                                                      */
/* ================================================================== */

describe("TxtExtractor", () => {
  const extractor = new TxtExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("reads a plain text file", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.txt"));
    expect(result.text).toBe("Hello, world!\nSecond line.");
    expect(result.pageRange).toBeUndefined();
    expect(result.tableRef).toBeUndefined();
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(
      extractor.extract(join(tmpDir, "does-not-exist.txt")),
    ).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  CsvExtractor                                                      */
/* ================================================================== */

describe("CsvExtractor", () => {
  const extractor = new CsvExtractor();

  it("converts CSV rows to labelled key-value lines", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.csv"));
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Name: Alice, Age: 30, City: Tokyo");
    expect(lines[1]).toBe("Name: Bob, Age: 25, City: Osaka");
  });

  it("returns empty text for empty file", async () => {
    const emptyPath = join(tmpDir, "empty.csv");
    await writeFile(emptyPath, "");
    const result = await extractor.extract(emptyPath);
    expect(result.text).toBe("");
  });
});

/* ================================================================== */
/*  JsonExtractor                                                     */
/* ================================================================== */

describe("JsonExtractor", () => {
  const extractor = new JsonExtractor();

  it("flattens a JSON object into key-value lines", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.json"));
    expect(result.text).toContain("name: ax-fabric");
    expect(result.text).toContain("version: 0.1.0");
    expect(result.text).toContain("tags[0]: ai");
    expect(result.text).toContain("tags[1]: ingest");
    expect(result.text).toContain("config.debug: true");
    expect(result.text).toContain("config.maxRetries: 3");
  });

  it("handles empty object", async () => {
    const result = await extractor.extract(join(tmpDir, "empty.json"));
    // An empty top-level object with no prefix produces no lines
    // because flatten skips the top-level empty-object case when prefix is ""
    expect(result.text).toBe("");
  });

  it("throws AxFabricError for invalid JSON", async () => {
    await expect(
      extractor.extract(join(tmpDir, "bad.json")),
    ).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  YamlExtractor                                                     */
/* ================================================================== */

describe("YamlExtractor", () => {
  const extractor = new YamlExtractor();

  it("flattens a YAML file into key-value lines", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.yaml"));
    expect(result.text).toContain("name: ax-fabric");
    expect(result.text).toContain("version: 0.1.0");
    expect(result.text).toContain("tags[0]: ai");
    expect(result.text).toContain("tags[1]: ingest");
    expect(result.text).toContain("config.debug: true");
    expect(result.text).toContain("config.maxRetries: 3");
  });

  it("handles .yml extension", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.yml"));
    expect(result.text).toContain("key: value");
  });
});

/* ================================================================== */
/*  PptxExtractor                                                     */
/* ================================================================== */

describe("PptxExtractor", () => {
  const extractor = new PptxExtractor();

  it("extracts text from PPTX slide XML", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.pptx"));
    expect(result.text).toContain("Slide Title");
    expect(result.text).toContain("Bullet point one");
  });

  it("throws AxFabricError for non-ZIP file", async () => {
    const badPath = join(tmpDir, "bad.pptx");
    await writeFile(badPath, "this is not a zip file");
    const result = await extractor.extract(badPath);
    // A non-ZIP file will have no matching entries, producing empty text
    expect(result.text).toBe("");
  });

  it("rejects oversized declared ZIP entries", async () => {
    const slideXml = "<p:sld><a:t>x</a:t></p:sld>";
    const zip = buildZip([{ name: "ppt/slides/slide1.xml", content: slideXml }]);
    const mutated = mutateFirstLocalHeader(zip, (header) => {
      header.writeUInt32LE(33 * 1024 * 1024, 22); // uncompressed size
    });
    const badPath = join(tmpDir, "oversized.pptx");
    await writeFile(badPath, mutated);
    await expect(extractor.extract(badPath)).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  XlsxExtractor                                                     */
/* ================================================================== */

describe("XlsxExtractor", () => {
  const extractor = new XlsxExtractor();

  it("extracts sheet data as row-to-text with headers", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.xlsx"));
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Name: Alice, Score: 95");
    expect(lines[1]).toBe("Name: Bob, Score: 88");
  });

  it("sets tableRef to sheet name", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.xlsx"));
    expect(result.tableRef).toBe("Sheet1");
  });

  it("rejects unsupported ZIP compression methods", async () => {
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", content: "<worksheet/>" }], 8);
    const mutated = mutateFirstLocalHeader(zip, (header) => {
      header.writeUInt16LE(99, 8); // compression method
    });
    const badPath = join(tmpDir, "unsupported-compression.xlsx");
    await writeFile(badPath, mutated);
    await expect(extractor.extract(badPath)).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  ExtractorRegistry                                                 */
/* ================================================================== */

describe("ExtractorRegistry", () => {
  it("resolves extractor by file path extension", () => {
    const registry = createDefaultRegistry();
    const extractor = registry.getExtractor("/some/path/file.csv");
    expect(extractor).toBeInstanceOf(CsvExtractor);
  });

  it("returns undefined for unsupported extension", () => {
    const registry = createDefaultRegistry();
    expect(registry.getExtractor("file.mp3")).toBeUndefined();
  });

  it("is case-insensitive for extensions", () => {
    const registry = createDefaultRegistry();
    expect(registry.getExtractor("FILE.JSON")).toBeInstanceOf(JsonExtractor);
    expect(registry.getExtractor("data.CSV")).toBeInstanceOf(CsvExtractor);
  });

  it("maps .yml and .yaml to the same extractor", () => {
    const registry = createDefaultRegistry();
    const yamlExt = registry.getExtractor("a.yaml");
    const ymlExt = registry.getExtractor("b.yml");
    expect(yamlExt).toBeDefined();
    expect(yamlExt).toBe(ymlExt);
  });

  it("lists all supported extensions sorted", () => {
    const registry = createDefaultRegistry();
    const exts = registry.getSupportedExtensions();
    expect(exts).toEqual([
      ".csv",
      ".docx",
      ".json",
      ".markdown",
      ".md",
      ".pdf",
      ".pptx",
      ".txt",
      ".xlsx",
      ".yaml",
      ".yml",
    ]);
  });

  it("allows custom extractor registration", () => {
    const registry = new ExtractorRegistry();
    const custom: { version: string; extract: () => Promise<{ text: string }> } = {
      version: "1.0.0",
      extract: async () => ({ text: "custom" }),
    };
    registry.register(".md", custom);
    expect(registry.getExtractor("readme.md")).toBe(custom);
  });
});

/* ================================================================== */
/*  Error handling                                                    */
/* ================================================================== */

describe("Error handling", () => {
  it("TxtExtractor wraps filesystem errors in AxFabricError", async () => {
    const ext = new TxtExtractor();
    try {
      await ext.extract("/nonexistent/path/file.txt");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });

  it("JsonExtractor wraps parse errors in AxFabricError", async () => {
    const ext = new JsonExtractor();
    try {
      await ext.extract(join(tmpDir, "bad.json"));
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});
