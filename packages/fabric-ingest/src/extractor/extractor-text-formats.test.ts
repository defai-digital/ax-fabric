/**
 * Tests for text-format extractors and ExtractorRegistry.
 * Covers: TxtExtractor, CsvExtractor, JsonExtractor, YamlExtractor,
 *         ExtractorRegistry (register/lookup/extensions/default).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxFabricError } from "@ax-fabric/contracts";

import { TxtExtractor } from "./txt-extractor.js";
import { CsvExtractor } from "./csv-extractor.js";
import { JsonExtractor } from "./json-extractor.js";
import { YamlExtractor } from "./yaml-extractor.js";
import { ExtractorRegistry, createDefaultRegistry } from "./extractor-registry.js";
import { EXTRACTOR_VERSION } from "./extractor.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "extractor-text-formats-test-"));

  // TxtExtractor fixtures
  await writeFile(join(tmpDir, "hello.txt"), "Hello, world!\nSecond line.");
  await writeFile(join(tmpDir, "empty.txt"), "");

  // CsvExtractor fixtures
  await writeFile(
    join(tmpDir, "data.csv"),
    "Name,Age,City\nAlice,30,Tokyo\nBob,25,Osaka\n",
  );
  await writeFile(join(tmpDir, "headers-only.csv"), "Name,Age,City\n");
  await writeFile(join(tmpDir, "empty.csv"), "");
  await writeFile(join(tmpDir, "single-col.csv"), "Item\napple\nbanana\n");
  await writeFile(join(tmpDir, "quoted.csv"), 'Name,Bio\nAlice,"Writer, poet"\n');

  // JsonExtractor fixtures
  await writeFile(
    join(tmpDir, "flat.json"),
    JSON.stringify({ name: "Alice", age: 30, active: true }),
  );
  await writeFile(
    join(tmpDir, "nested.json"),
    JSON.stringify({ person: { name: "Bob", address: { city: "Tokyo" } } }),
  );
  await writeFile(
    join(tmpDir, "array.json"),
    JSON.stringify([{ id: 1 }, { id: 2 }]),
  );
  await writeFile(join(tmpDir, "null-val.json"), JSON.stringify({ key: null }));
  await writeFile(join(tmpDir, "empty-obj.json"), JSON.stringify({}));
  await writeFile(join(tmpDir, "empty-arr.json"), JSON.stringify([]));
  await writeFile(join(tmpDir, "bad.json"), "not json at all");

  // YamlExtractor fixtures
  await writeFile(
    join(tmpDir, "config.yaml"),
    "name: Alice\nage: 30\nactive: true\n",
  );
  await writeFile(
    join(tmpDir, "nested.yaml"),
    "database:\n  host: localhost\n  port: 5432\n",
  );
  await writeFile(
    join(tmpDir, "list.yaml"),
    "items:\n  - apple\n  - banana\n",
  );
  await writeFile(join(tmpDir, "bad.yaml"), "key: {\nbad");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── TxtExtractor ─────────────────────────────────────────────────────────────

describe("TxtExtractor", () => {
  const extractor = new TxtExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("returns file content verbatim", async () => {
    const result = await extractor.extract(join(tmpDir, "hello.txt"));
    expect(result.text).toBe("Hello, world!\nSecond line.");
  });

  it("returns empty string for an empty file", async () => {
    const result = await extractor.extract(join(tmpDir, "empty.txt"));
    expect(result.text).toBe("");
  });

  it("throws AxFabricError for a missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.txt"))).rejects.toThrow(AxFabricError);
  });

  it("thrown error has EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract(join(tmpDir, "no-such.txt"));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

// ─── CsvExtractor ────────────────────────────────────────────────────────────

describe("CsvExtractor", () => {
  const extractor = new CsvExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("converts each data row to a 'header: value' key-value line", async () => {
    const result = await extractor.extract(join(tmpDir, "data.csv"));
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("Name: Alice, Age: 30, City: Tokyo");
    expect(lines[1]).toBe("Name: Bob, Age: 25, City: Osaka");
  });

  it("returns only headers joined by comma when there are no data rows", async () => {
    const result = await extractor.extract(join(tmpDir, "headers-only.csv"));
    expect(result.text).toBe("Name, Age, City");
  });

  it("returns empty text for an empty file", async () => {
    const result = await extractor.extract(join(tmpDir, "empty.csv"));
    expect(result.text).toBe("");
  });

  it("handles single-column CSV correctly", async () => {
    const result = await extractor.extract(join(tmpDir, "single-col.csv"));
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("Item: apple");
    expect(lines[1]).toBe("Item: banana");
  });

  it("handles quoted fields containing commas", async () => {
    const result = await extractor.extract(join(tmpDir, "quoted.csv"));
    expect(result.text).toContain("Bio: Writer, poet");
  });

  it("throws AxFabricError for a missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.csv"))).rejects.toThrow(AxFabricError);
  });
});

// ─── JsonExtractor ────────────────────────────────────────────────────────────

describe("JsonExtractor", () => {
  const extractor = new JsonExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("flattens a flat object to 'key: value' lines", async () => {
    const result = await extractor.extract(join(tmpDir, "flat.json"));
    const lines = result.text.split("\n");
    expect(lines).toContain("name: Alice");
    expect(lines).toContain("age: 30");
    expect(lines).toContain("active: true");
  });

  it("flattens nested objects using dot notation", async () => {
    const result = await extractor.extract(join(tmpDir, "nested.json"));
    const lines = result.text.split("\n");
    expect(lines).toContain("person.name: Bob");
    expect(lines).toContain("person.address.city: Tokyo");
  });

  it("flattens arrays using bracket notation", async () => {
    const result = await extractor.extract(join(tmpDir, "array.json"));
    const lines = result.text.split("\n");
    expect(lines).toContain("[0].id: 1");
    expect(lines).toContain("[1].id: 2");
  });

  it("represents null values as 'key: null'", async () => {
    const result = await extractor.extract(join(tmpDir, "null-val.json"));
    expect(result.text).toContain("key: null");
  });

  it("returns empty text for an empty object", async () => {
    const result = await extractor.extract(join(tmpDir, "empty-obj.json"));
    expect(result.text).toBe("");
  });

  it("represents an empty top-level array as '[]'", async () => {
    const result = await extractor.extract(join(tmpDir, "empty-arr.json"));
    expect(result.text).toContain("[]");
  });

  it("throws AxFabricError for invalid JSON", async () => {
    await expect(extractor.extract(join(tmpDir, "bad.json"))).rejects.toThrow(AxFabricError);
  });

  it("throws AxFabricError for a missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.json"))).rejects.toThrow(AxFabricError);
  });

  it("thrown error has EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract(join(tmpDir, "bad.json"));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

// ─── YamlExtractor ────────────────────────────────────────────────────────────

describe("YamlExtractor", () => {
  const extractor = new YamlExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("flattens flat YAML to 'key: value' lines", async () => {
    const result = await extractor.extract(join(tmpDir, "config.yaml"));
    const lines = result.text.split("\n");
    expect(lines).toContain("name: Alice");
    expect(lines).toContain("age: 30");
    expect(lines).toContain("active: true");
  });

  it("flattens nested YAML using dot notation", async () => {
    const result = await extractor.extract(join(tmpDir, "nested.yaml"));
    const lines = result.text.split("\n");
    expect(lines).toContain("database.host: localhost");
    expect(lines).toContain("database.port: 5432");
  });

  it("flattens YAML arrays using bracket notation", async () => {
    const result = await extractor.extract(join(tmpDir, "list.yaml"));
    const lines = result.text.split("\n");
    expect(lines).toContain("items[0]: apple");
    expect(lines).toContain("items[1]: banana");
  });

  it("throws AxFabricError for invalid YAML", async () => {
    await expect(extractor.extract(join(tmpDir, "bad.yaml"))).rejects.toThrow(AxFabricError);
  });

  it("throws AxFabricError for a missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.yaml"))).rejects.toThrow(AxFabricError);
  });

  it("thrown error has EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract(join(tmpDir, "no-such.yaml"));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

// ─── ExtractorRegistry ────────────────────────────────────────────────────────

describe("ExtractorRegistry", () => {
  it("registers an extractor and retrieves it by file path", () => {
    const registry = new ExtractorRegistry();
    const ext = new TxtExtractor();
    registry.register(".txt", ext);
    expect(registry.getExtractor("document.txt")).toBe(ext);
  });

  it("normalises extensions to lowercase with leading dot", () => {
    const registry = new ExtractorRegistry();
    const ext = new TxtExtractor();
    registry.register("TXT", ext); // uppercase, no leading dot
    expect(registry.getExtractor("file.TXT")).toBe(ext);
    expect(registry.getExtractor("file.txt")).toBe(ext);
  });

  it("returns undefined for an unregistered extension", () => {
    const registry = new ExtractorRegistry();
    expect(registry.getExtractor("file.unknown")).toBeUndefined();
  });

  it("getSupportedExtensions() returns sorted list of registered extensions", () => {
    const registry = new ExtractorRegistry();
    registry.register(".txt", new TxtExtractor());
    registry.register(".csv", new CsvExtractor());
    registry.register(".json", new JsonExtractor());
    const exts = registry.getSupportedExtensions();
    expect(exts).toEqual([".csv", ".json", ".txt"]);
  });

  it("last register wins for the same extension", () => {
    const registry = new ExtractorRegistry();
    const first = new TxtExtractor();
    const second = new TxtExtractor();
    registry.register(".txt", first);
    registry.register(".txt", second);
    expect(registry.getExtractor("file.txt")).toBe(second);
  });

  it("getExtractor handles full file path, not just extension", () => {
    const registry = new ExtractorRegistry();
    const ext = new JsonExtractor();
    registry.register(".json", ext);
    expect(registry.getExtractor("/usr/local/data/config.json")).toBe(ext);
  });
});

// ─── createDefaultRegistry ────────────────────────────────────────────────────

describe("createDefaultRegistry", () => {
  it("registers all expected extensions", () => {
    const registry = createDefaultRegistry();
    const exts = registry.getSupportedExtensions();

    for (const ext of [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl",
      ".yaml", ".yml", ".html", ".htm", ".rtf", ".sql", ".log"]) {
      expect(exts).toContain(ext);
    }
  });

  it("returns an extractor for .txt files", () => {
    const registry = createDefaultRegistry();
    expect(registry.getExtractor("file.txt")).toBeDefined();
  });

  it("returns an extractor for .yaml and .yml (same extractor)", () => {
    const registry = createDefaultRegistry();
    const yaml = registry.getExtractor("file.yaml");
    const yml = registry.getExtractor("file.yml");
    expect(yaml).toBeDefined();
    expect(yml).toBeDefined();
    expect(yaml).toBe(yml); // same instance for both extensions
  });

  it("returns an extractor for .html and .htm (same extractor)", () => {
    const registry = createDefaultRegistry();
    const html = registry.getExtractor("page.html");
    const htm = registry.getExtractor("page.htm");
    expect(html).toBeDefined();
    expect(html).toBe(htm);
  });

  it("returns undefined for unsupported extensions", () => {
    const registry = createDefaultRegistry();
    expect(registry.getExtractor("file.exe")).toBeUndefined();
    expect(registry.getExtractor("file.zip")).toBeUndefined();
  });
});
