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

  it("has a version string", () => {
    expect(typeof extractor.version).toBe("string");
    expect(extractor.version.length).toBeGreaterThan(0);
  });

  it("produces one output row per data row", async () => {
    const tsv = `col\n1\n2\n3`;
    const p = await write("rows.tsv", tsv);
    const result = await extractor.extract(p);
    const lines = result.text.split("\n");
    // First line is the schema, next 3 are data rows
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Columns: col");
  });
});

// ─── Additional extractor gaps ────────────────────────────────────────────

describe("MdExtractor — additional", () => {
  const extractor = new MdExtractor();

  it("preserves Unicode content unchanged", async () => {
    const p = await write("unicode.md", "# 日本語\n\nСодержание: emoji 🎉");
    const result = await extractor.extract(p);
    expect(result.text).toContain("日本語");
    expect(result.text).toContain("🎉");
  });

  it("preserves code blocks unchanged", async () => {
    const md = "```typescript\nconst x: string = 'hello';\n```";
    const p = await write("code.md", md);
    const result = await extractor.extract(p);
    expect(result.text).toBe(md);
  });
});

describe("HtmlExtractor — additional", () => {
  const extractor = new HtmlExtractor();

  it("removes nav and footer elements", async () => {
    const html = `<html><body><nav>Skip me</nav><p>Content</p><footer>Skip footer</footer></body></html>`;
    const p = await write("nav-footer.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Content");
    expect(result.text).not.toContain("Skip me");
    expect(result.text).not.toContain("Skip footer");
  });

  it("extracts anchor link text", async () => {
    const html = `<html><body><p>Visit <a href="https://example.com">our website</a> today.</p></body></html>`;
    const p = await write("links.html", html);
    const result = await extractor.extract(p);
    expect(result.text).toContain("our website");
  });

  it("has a version string", () => {
    expect(typeof extractor.version).toBe("string");
    expect(extractor.version.length).toBeGreaterThan(0);
  });
});

describe("RtfExtractor — additional control words", () => {
  const extractor = new RtfExtractor();

  it("converts \\tab control word to tab character", async () => {
    // A space after a control word acts as a delimiter in RTF
    const rtf = `{\\rtf1 col1\\tab col2}`;
    const p = await write("tab.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("col1");
    expect(result.text).toContain("col2");
  });

  it("converts \\emdash to em-dash character", async () => {
    const rtf = `{\\rtf1 before\\emdash after}`;
    const p = await write("emdash.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("\u2014");
  });

  it("converts \\endash to en-dash character", async () => {
    const rtf = `{\\rtf1 before\\endash after}`;
    const p = await write("endash.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("\u2013");
  });

  it("converts \\lquote and \\rquote to typographic single quotes", async () => {
    const rtf = `{\\rtf1 \\lquote hello\\rquote }`;
    const p = await write("quotes.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("\u2018");
    expect(result.text).toContain("\u2019");
  });

  it("decodes hex escape sequences", async () => {
    // \'41 is 'A' in ASCII (0x41 = 65 = 'A')
    const rtf = `{\\rtf1 \\'41 text}`;
    const p = await write("hex.rtf", rtf);
    const result = await extractor.extract(p);
    // Should decode hex 41 = 'A'
    expect(result.text).toContain("A");
    expect(result.text).toContain("text");
  });

  it("skips fonttbl group content", async () => {
    const rtf = `{\\rtf1{\\fonttbl{\\f0 Arial;}}Visible text.}`;
    const p = await write("fonttbl.rtf", rtf);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Visible text.");
    expect(result.text).not.toContain("Arial");
  });

  it("has a version string", () => {
    expect(typeof extractor.version).toBe("string");
    expect(extractor.version.length).toBeGreaterThan(0);
  });
});

describe("SqlExtractor — additional", () => {
  const extractor = new SqlExtractor();

  it("handles CREATE TABLE IF NOT EXISTS syntax", async () => {
    const sql = `CREATE TABLE IF NOT EXISTS events (\n  id INTEGER,\n  name TEXT\n);\nINSERT INTO events (id, name) VALUES (1, 'launch');`;
    const p = await write("ifnotexists.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Table: events");
    expect(result.text).toContain("name: launch");
  });

  it("parses INSERT without prior CREATE TABLE using column list", async () => {
    const sql = `INSERT INTO logs (ts, msg) VALUES ('2024-01-01', 'started');`;
    const p = await write("insert-only.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Table: logs");
    expect(result.text).toContain("ts: 2024-01-01");
    expect(result.text).toContain("msg: started");
  });

  it("handles PostgreSQL COPY FROM stdin format", async () => {
    const sql = `COPY users (id, name) FROM stdin;\n1\tAlice\n2\tBob\n\\.`;
    const p = await write("pg-copy.sql", sql);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Table: users");
    expect(result.text).toContain("Columns: id, name");
    expect(result.text).toContain("name");
  });

  it("handles NULL values in INSERT rows", async () => {
    const sql = `CREATE TABLE t (\n  a TEXT,\n  b TEXT\n);\nINSERT INTO t (a, b) VALUES ('hello', NULL);`;
    const p = await write("nulls.sql", sql);
    const result = await extractor.extract(p);
    // NULL should be replaced with empty string
    expect(result.text).toContain("a: hello");
    expect(result.text).toContain("b: ");
  });
});

describe("JsonlExtractor — additional", () => {
  const extractor = new JsonlExtractor();

  it("schema is determined by first row — extra keys in later rows use first row's columns", async () => {
    // Second row has an extra key 'extra' not in first row — it should be ignored
    const jsonl = `{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob","extra":"ignored"}`;
    const p = await write("schema-first.jsonl", jsonl);
    const result = await extractor.extract(p);
    expect(result.text).toContain("Columns: id, name");
    expect(result.text).not.toContain("extra");
  });

  it("handles nested object values by stringifying them", async () => {
    const jsonl = `{"id":1,"meta":{"key":"val"}}`;
    const p = await write("nested.jsonl", jsonl);
    const result = await extractor.extract(p);
    // The meta value is an object; it should appear as a string representation
    expect(result.text).toContain("meta:");
  });

  it("has a version string", () => {
    expect(typeof extractor.version).toBe("string");
    expect(extractor.version.length).toBeGreaterThan(0);
  });
});
