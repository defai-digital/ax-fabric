/**
 * Tests for extractors not covered by extractor.test.ts:
 * MdExtractor, HtmlExtractor, RtfExtractor, SqlExtractor, JsonlExtractor, TsvExtractor.
 *
 * All I/O uses real temp files to exercise the full extraction path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AxFabricError } from "@ax-fabric/contracts";

import { MdExtractor } from "./md-extractor.js";
import { HtmlExtractor } from "./html-extractor.js";
import { RtfExtractor } from "./rtf-extractor.js";
import { SqlExtractor } from "./sql-extractor.js";
import { JsonlExtractor } from "./jsonl-extractor.js";
import { TsvExtractor } from "./tsv-extractor.js";

// ─── Temp directory ────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ax-extractor-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function write(filename: string, content: string): Promise<string> {
  const p = join(tmpDir, filename);
  await writeFile(p, content, "utf-8");
  return p;
}

// ─── MdExtractor ──────────────────────────────────────────────────────────

describe("MdExtractor", () => {
  const extractor = new MdExtractor();

  it("returns the raw markdown text unchanged", async () => {
    const p = await write("doc.md", "# Hello\n\nThis is **bold** text.");
    const result = await extractor.extract(p);
    expect(result.text).toBe("# Hello\n\nThis is **bold** text.");
  });

  it("handles empty file", async () => {
    const p = await write("empty.md", "");
    const result = await extractor.extract(p);
    expect(result.text).toBe("");
  });

  it("preserves frontmatter", async () => {
    const p = await write("front.md", "---\ntitle: Test\n---\n\nContent here.");
    const result = await extractor.extract(p);
    expect(result.text).toContain("title: Test");
    expect(result.text).toContain("Content here.");
  });

  it("returns null pageRange and tableRef", async () => {
    const p = await write("md2.md", "text");
    const result = await extractor.extract(p);
    expect(result.pageRange).toBeUndefined();
    expect(result.tableRef).toBeUndefined();
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.md")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });

  it("has a version string", () => {
    expect(typeof extractor.version).toBe("string");
    expect(extractor.version.length).toBeGreaterThan(0);
  });
});

// ─── HtmlExtractor ────────────────────────────────────────────────────────

describe("HtmlExtractor", () => {
  const extractor = new HtmlExtractor();

  it("extracts text from simple HTML", async () => {
    const html = `<!DOCTYPE html><html><body><p>Hello world</p></body></html>`;
    const p = await write("page.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Hello world");
  });

  it("removes script and style tags", async () => {
    const html = `<html><body><script>alert('x')</script><style>.a{}</style><p>Keep this</p></body></html>`;
    const p = await write("scripts.html", html);
    const result = await extractor.extract(p);
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain(".a{}");
    expect(result.text).toContain("Keep this");
  });

  it("converts headings to markdown format", async () => {
    const html = `<html><body><h1>Title</h1><h2>Subtitle</h2></body></html>`;
    const p = await write("headings.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toContain("# Title");
    expect(result.text).toContain("## Subtitle");
  });

  it("decodes HTML entities", async () => {
    const html = `<html><body><p>&amp; &lt;tag&gt; &quot;quoted&quot; &nbsp;</p></body></html>`;
    const p = await write("entities.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toContain("&");
    expect(result.text).toContain("<tag>");
    expect(result.text).toContain('"quoted"');
  });

  it("handles empty body", async () => {
    const html = `<html><body></body></html>`;
    const p = await write("empty.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toBe("");
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.html")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });
});

// ─── RtfExtractor ────────────────────────────────────────────────────────

describe("RtfExtractor", () => {
  const extractor = new RtfExtractor();

  it("extracts plain text from basic RTF", async () => {
    const rtf = `{\\rtf1\\ansi Hello World\\par}`;
    const p = await write("doc.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Hello World");
  });

  it("strips RTF control words", async () => {
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Clean text.\\par}`;
    const p = await write("control.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Clean text.");
    expect(result.text).not.toContain("\\f0");
    expect(result.text).not.toContain("\\fonttbl");
  });

  it("converts \\par to newlines", async () => {
    const rtf = `{\\rtf1 Line one\\par Line two\\par}`;
    const p = await write("lines.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Line one");
    expect(result.text).toContain("Line two");
  });

  it("handles escaped braces", async () => {
    const rtf = `{\\rtf1 \\{braces\\}}`;
    const p = await write("braces.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("{braces}");
  });

  it("decodes unicode escape sequences", async () => {
    // \u9733? is the RTF unicode escape for ★ (U+2605)
    const rtf = `{\\rtf1 Star: \\u9733?}`;
    const p = await write("unicode.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("★");
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.rtf")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });
});

// ─── SqlExtractor ─────────────────────────────────────────────────────────

describe("SqlExtractor", () => {
  const extractor = new SqlExtractor();

  it("extracts CREATE TABLE + INSERT rows into structured text", async () => {
    const sql = `
CREATE TABLE users (
  id INTEGER,
  name VARCHAR(100),
  email VARCHAR(255)
);
INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');
`.trim();
    const p = await write("schema.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Table: users");
    expect(result.text).toContain("Columns: id, name, email");
    expect(result.text).toContain("name: Alice");
    expect(result.text).toContain("name: Bob");
  });

  it("sets tableRef to table name(s)", async () => {
    const sql = `CREATE TABLE products (id INTEGER, title TEXT);\nINSERT INTO products VALUES (1, 'Widget');`;
    const p = await write("products.sql", sql);
    const result = await extractor.extract(p);
    expect(result.tableRef).toContain("products");
  });

  it("returns raw SQL when no parseable tables found", async () => {
    const sql = `-- just a comment\nSELECT 1;`;
    const p = await write("plain.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("SELECT 1");
  });

  it("handles multi-value INSERT rows", async () => {
    const sql = `
CREATE TABLE items (
  id INTEGER,
  label TEXT
);
INSERT INTO items (id, label) VALUES (1, 'first'), (2, 'second');
`.trim();
    const p = await write("multi.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("label: first");
    expect(result.text).toContain("label: second");
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.sql")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });
});

// ─── JsonlExtractor ───────────────────────────────────────────────────────

describe("JsonlExtractor", () => {
  const extractor = new JsonlExtractor();

  it("extracts JSONL with schema header and key-value rows", async () => {
    const jsonl = `{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}`;
    const p = await write("data.jsonl", jsonl);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Columns: id, name");
    expect(result.text).toContain("id: 1");
    expect(result.text).toContain("name: Alice");
    expect(result.text).toContain("name: Bob");
  });

  it("returns empty string for empty file", async () => {
    const p = await write("empty.jsonl", "");
    const result = await extractor.extract(p);
    expect(result.text).toBe("");
  });

  it("handles single-row JSONL", async () => {
    const p = await write("single.jsonl", `{"x":42}`);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Columns: x");
    expect(result.text).toContain("x: 42");
  });

  it("skips blank lines between entries", async () => {
    const jsonl = `{"a":1}\n\n{"a":2}\n`;
    const p = await write("blanks.jsonl", jsonl);
    const result = await extractor.extract(p);
    const rows = result.text.split("\n").filter((l) => l.startsWith("a:"));
    expect(rows).toHaveLength(2);
  });

  it("throws EXTRACT_ERROR for invalid JSON line", async () => {
    const p = await write("bad.jsonl", `{"ok":1}\nNOT_JSON`);
    await expect(extractor.extract(p)).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.jsonl")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });
});

// ─── TsvExtractor ─────────────────────────────────────────────────────────

describe("TsvExtractor", () => {
  const extractor = new TsvExtractor();

  it("extracts TSV with schema header and key-value rows", async () => {
    const tsv = `id\tname\tage\n1\tAlice\t30\n2\tBob\t25`;
    const p = await write("data.tsv", tsv);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Columns: id, name, age");
    expect(result.text).toContain("name: Alice");
    expect(result.text).toContain("age: 30");
    expect(result.text).toContain("name: Bob");
  });

  it("returns empty string for empty file", async () => {
    const p = await write("empty.tsv", "");
    const result = await extractor.extract(p);
    expect(result.text).toBe("");
  });

  it("returns only schema line for header-only TSV", async () => {
    const p = await write("header-only.tsv", "col1\tcol2\tcol3");
    const result = await extractor.extract(p);
    expect(result.text).toBe("Columns: col1, col2, col3");
  });

  it("handles rows with fewer columns than header", async () => {
    const tsv = `a\tb\tc\n1\t2`;
    const p = await write("short.tsv", tsv);
    const result = await extractor.extract(p);
    expect(result.text).toContain("a: 1");
    expect(result.text).toContain("b: 2");
  });

  it("handles tab characters within fields", async () => {
    const tsv = `name\tvalue\ntest\t42`;
    const p = await write("basic.tsv", tsv);
    const result = await extractor.extract(p);
    expect(result.text).toContain("value: 42");
  });

  it("throws EXTRACT_ERROR for non-existent file", async () => {
    await expect(extractor.extract("/nonexistent/file.tsv")).rejects.toSatisfy(
      (e) => e instanceof AxFabricError && (e as AxFabricError).code === "EXTRACT_ERROR",
    );
  });
});
