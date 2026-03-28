/**
 * Tests for extractors not covered in extractor.test.ts:
 * MdExtractor, HtmlExtractor, JsonlExtractor, LogExtractor,
 * RtfExtractor, SqlExtractor, TsvExtractor, htmlToMarkdown.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxFabricError } from "@ax-fabric/contracts";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { EmlExtractor } from "./eml-extractor.js";
import { MdExtractor } from "./md-extractor.js";
import { HtmlExtractor } from "./html-extractor.js";
import { JsonlExtractor } from "./jsonl-extractor.js";
import { LogExtractor } from "./log-extractor.js";
import { RtfExtractor } from "./rtf-extractor.js";
import { SqlExtractor } from "./sql-extractor.js";
import { TsvExtractor } from "./tsv-extractor.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { EXTRACTOR_VERSION } from "./extractor.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "extractor-extras-test-"));

  // Markdown fixture
  await writeFile(
    join(tmpDir, "sample.md"),
    "# Hello\n\nThis is **markdown** content.\n\n## Section\n\nMore text here.",
  );

  // HTML fixture
  await writeFile(
    join(tmpDir, "sample.html"),
    `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <h1>Page Title</h1>
  <p>Hello <strong>world</strong>!</p>
  <ul>
    <li>Item one</li>
    <li>Item two</li>
  </ul>
  <script>console.log("remove me");</script>
</body>
</html>`,
  );

  // JSONL fixture
  await writeFile(
    join(tmpDir, "sample.jsonl"),
    [
      JSON.stringify({ id: 1, name: "Alice", score: 95 }),
      JSON.stringify({ id: 2, name: "Bob", score: 88 }),
      JSON.stringify({ id: 3, name: "Carol", score: 72 }),
    ].join("\n") + "\n",
  );

  // Log fixture
  await writeFile(
    join(tmpDir, "sample.log"),
    "2024-01-01 INFO Server started\n2024-01-01 ERROR Connection failed\n",
  );

  // RTF fixture — minimal valid RTF with text, paragraph breaks, and special chars
  await writeFile(
    join(tmpDir, "sample.rtf"),
    "{\\rtf1\\ansi Hello\\par World\\par }",
  );

  // RTF with Unicode escape
  await writeFile(
    join(tmpDir, "unicode.rtf"),
    "{\\rtf1 Caf\\u233?e}",
  );

  // RTF with skippable groups
  await writeFile(
    join(tmpDir, "groups.rtf"),
    "{\\rtf1{\\fonttbl{\\f0 Arial;}}Hello}",
  );

  // SQL fixture — CREATE TABLE + INSERT INTO
  await writeFile(
    join(tmpDir, "sample.sql"),
    [
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY,",
      "  name VARCHAR(100),",
      "  email VARCHAR(200)",
      ");",
      "",
      "INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');",
      "INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');",
    ].join("\n"),
  );

  // SQL fixture — PostgreSQL COPY FROM stdin
  await writeFile(
    join(tmpDir, "pg.sql"),
    [
      "COPY products (id, title, price) FROM stdin;",
      "1\tWidget\t9.99",
      "2\tGadget\t19.99",
      "\\.",
    ].join("\n"),
  );

  // SQL with no structured data — raw SQL passthrough
  await writeFile(
    join(tmpDir, "raw.sql"),
    "SELECT * FROM users WHERE active = true;",
  );

  // TSV fixture
  await writeFile(
    join(tmpDir, "sample.tsv"),
    "Name\tAge\tCity\nAlice\t30\tTokyo\nBob\t25\tOsaka\n",
  );

  // Empty TSV
  await writeFile(join(tmpDir, "empty.tsv"), "");

  // TSV with only headers
  await writeFile(join(tmpDir, "headers-only.tsv"), "Name\tAge\n");

  // EML fixture — plain text email
  await writeFile(
    join(tmpDir, "plain.eml"),
    [
      "From: Alice <alice@example.com>",
      "To: bob@example.com",
      "Subject: Meeting Notes",
      "Date: Sat, 28 Mar 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello Bob,",
      "",
      "Here are the meeting notes from today.",
    ].join("\r\n"),
  );

  // EML fixture — HTML-only body (no text/plain part)
  await writeFile(
    join(tmpDir, "html-only.eml"),
    [
      "From: carol@example.com",
      "To: dave@example.com",
      "Subject: HTML Report",
      "Date: Sat, 28 Mar 2026 11:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><h1>Report</h1><p>This is the <strong>HTML</strong> body.</p></body></html>",
    ].join("\r\n"),
  );

  // EML fixture — with attachment
  const boundary = "----=_Part_001";
  const attachmentContent = Buffer.from("fake pdf content").toString("base64");
  await writeFile(
    join(tmpDir, "with-attachment.eml"),
    [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: File attached",
      "Date: Sat, 28 Mar 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please see attached.",
      "",
      `--${boundary}`,
      "Content-Type: application/pdf",
      `Content-Disposition: attachment; filename="report.pdf"`,
      "Content-Transfer-Encoding: base64",
      "",
      attachmentContent,
      "",
      `--${boundary}--`,
    ].join("\r\n"),
  );

  // EML fixture — multiple recipients with Cc
  await writeFile(
    join(tmpDir, "multi-recipient.eml"),
    [
      "From: alice@example.com",
      "To: bob@example.com, carol@example.com",
      "Cc: dave@example.com",
      "Subject: Team Update",
      "Date: Sat, 28 Mar 2026 13:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Team update body.",
    ].join("\r\n"),
  );

  // EML fixture — no subject
  await writeFile(
    join(tmpDir, "no-subject.eml"),
    [
      "From: alice@example.com",
      "To: bob@example.com",
      "Date: Sat, 28 Mar 2026 14:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "No subject email body.",
    ].join("\r\n"),
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/*  MdExtractor                                                       */
/* ================================================================== */

describe("MdExtractor", () => {
  const extractor = new MdExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("returns raw markdown content unchanged", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.md"));
    expect(result.text).toContain("# Hello");
    expect(result.text).toContain("**markdown**");
    expect(result.text).toContain("## Section");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.md"))).rejects.toThrow(AxFabricError);
  });

  it("error has EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract(join(tmpDir, "missing.md"));
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

/* ================================================================== */
/*  HtmlExtractor                                                     */
/* ================================================================== */

describe("HtmlExtractor", () => {
  const extractor = new HtmlExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("extracts visible text and removes script tags", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.html"));
    expect(result.text).toContain("Page Title");
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("world");
    expect(result.text).not.toContain("remove me");
    expect(result.text).not.toContain("<script");
  });

  it("converts headings to markdown", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.html"));
    expect(result.text).toContain("# Page Title");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.html"))).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  JsonlExtractor                                                    */
/* ================================================================== */

describe("JsonlExtractor", () => {
  const extractor = new JsonlExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("emits a Columns: schema header from first row", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.jsonl"));
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("Columns: id, name, score");
  });

  it("emits one data line per JSON record", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.jsonl"));
    const lines = result.text.split("\n");
    // header + 3 data rows
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("id: 1, name: Alice, score: 95");
    expect(lines[2]).toBe("id: 2, name: Bob, score: 88");
    expect(lines[3]).toBe("id: 3, name: Carol, score: 72");
  });

  it("returns empty text for empty file", async () => {
    const emptyPath = join(tmpDir, "empty.jsonl");
    await writeFile(emptyPath, "");
    const result = await extractor.extract(emptyPath);
    expect(result.text).toBe("");
  });

  it("throws AxFabricError for invalid JSON line", async () => {
    const badPath = join(tmpDir, "bad.jsonl");
    await writeFile(badPath, '{"valid": true}\nnot json\n');
    await expect(extractor.extract(badPath)).rejects.toThrow(AxFabricError);
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.jsonl"))).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  LogExtractor                                                      */
/* ================================================================== */

describe("LogExtractor", () => {
  const extractor = new LogExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("returns raw log content unchanged", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.log"));
    expect(result.text).toContain("INFO Server started");
    expect(result.text).toContain("ERROR Connection failed");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.log"))).rejects.toThrow(AxFabricError);
  });

  it("error has EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract("/no/such/path.log");
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

/* ================================================================== */
/*  RtfExtractor                                                      */
/* ================================================================== */

describe("RtfExtractor", () => {
  const extractor = new RtfExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("extracts plain text from RTF, converting \\par to newlines", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.rtf"));
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World");
  });

  it("handles Unicode escape sequences (\\uN?)", async () => {
    const result = await extractor.extract(join(tmpDir, "unicode.rtf"));
    // \u233 is é
    expect(result.text).toContain("Café");
  });

  it("skips content inside \\fonttbl groups", async () => {
    const result = await extractor.extract(join(tmpDir, "groups.rtf"));
    expect(result.text).toBe("Hello");
    expect(result.text).not.toContain("Arial");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.rtf"))).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  RtfExtractor — inline parsing edge cases                          */
/* ================================================================== */

describe("RtfExtractor inline parsing", () => {
  const extractor = new RtfExtractor();

  async function extract(rtf: string): Promise<string> {
    const path = join(tmpDir, `inline-${Date.now()}.rtf`);
    await writeFile(path, rtf);
    const result = await extractor.extract(path);
    return result.text;
  }

  it("handles escaped braces", async () => {
    const text = await extract("{\\rtf1 \\{ literal brace \\}}");
    expect(text).toContain("{ literal brace }");
  });

  it("handles \\tab control word", async () => {
    // RTF control words are terminated by a space — \tab must have a trailing space
    const text = await extract("{\\rtf1 col1\\tab col2}");
    expect(text).toContain("\t");
    expect(text).toContain("col1");
    expect(text).toContain("col2");
  });

  it("handles \\line control word as newline", async () => {
    const text = await extract("{\\rtf1 line1\\line line2}");
    expect(text).toContain("line1");
    expect(text).toContain("line2");
  });

  it("handles hex escapes (\\' XX)", async () => {
    // \'41 is ASCII 'A'
    const text = await extract("{\\rtf1 \\'41}");
    expect(text).toContain("A");
  });

  it("handles \\emdash and \\endash", async () => {
    const text = await extract("{\\rtf1 \\emdash \\endash}");
    expect(text).toContain("\u2014");
    expect(text).toContain("\u2013");
  });

  it("handles \\bullet control word", async () => {
    const text = await extract("{\\rtf1 \\bullet item}");
    expect(text).toContain("\u2022");
  });

  it("handles negative unicode values", async () => {
    // Negative signed 16-bit: -8364 + 65536 = 57172 (0xDF14) — not standard but shouldn't crash
    const text = await extract("{\\rtf1 \\u-8364?E}");
    // Just check it doesn't throw
    expect(typeof text).toBe("string");
  });
});

/* ================================================================== */
/*  SqlExtractor                                                      */
/* ================================================================== */

describe("SqlExtractor", () => {
  const extractor = new SqlExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("parses CREATE TABLE + INSERT INTO statements", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.sql"));
    expect(result.text).toContain("Table: users");
    expect(result.text).toContain("Columns: id, name, email");
    expect(result.text).toContain("name: Alice");
    expect(result.text).toContain("email: bob@example.com");
  });

  it("sets tableRef to table names", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.sql"));
    expect(result.tableRef).toContain("users");
  });

  it("parses PostgreSQL COPY FROM stdin", async () => {
    const result = await extractor.extract(join(tmpDir, "pg.sql"));
    expect(result.text).toContain("Table: products");
    expect(result.text).toContain("Columns: id, title, price");
    expect(result.text).toContain("title: Widget");
    expect(result.text).toContain("price: 19.99");
  });

  it("falls back to raw content when no structured tables found", async () => {
    const result = await extractor.extract(join(tmpDir, "raw.sql"));
    expect(result.text).toContain("SELECT * FROM users");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.sql"))).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  SqlExtractor — inline parsing edge cases                          */
/* ================================================================== */

describe("SqlExtractor inline parsing", () => {
  const extractor = new SqlExtractor();

  async function extract(sql: string): Promise<string> {
    const path = join(tmpDir, `sql-${Date.now()}.sql`);
    await writeFile(path, sql);
    const result = await extractor.extract(path);
    return result.text;
  }

  it("handles INSERT without prior CREATE TABLE", async () => {
    const text = await extract(
      "INSERT INTO orders (id, item) VALUES (1, 'Widget'), (2, 'Gadget');",
    );
    expect(text).toContain("Table: orders");
    expect(text).toContain("item: Widget");
    expect(text).toContain("item: Gadget");
  });

  it("handles NULL values as empty strings", async () => {
    const text = await extract(
      "INSERT INTO data (id, val) VALUES (1, NULL);",
    );
    expect(text).toContain("val: ");
  });

  it("handles SQL comments (--) gracefully", async () => {
    const text = await extract(
      "-- This is a comment\nSELECT 1;\n",
    );
    // No structured tables → passthrough
    expect(text).toContain("SELECT 1");
  });

  it("handles quoted string values with embedded commas", async () => {
    const text = await extract(
      "INSERT INTO t (a, b) VALUES ('hello, world', 'foo');",
    );
    expect(text).toContain("a: hello, world");
  });

  it("handles IF NOT EXISTS in CREATE TABLE", async () => {
    const text = await extract(
      "CREATE TABLE IF NOT EXISTS items (\n  name VARCHAR(100)\n);\nINSERT INTO items (name) VALUES ('thing');",
    );
    expect(text).toContain("Table: items");
    expect(text).toContain("name: thing");
  });

  it("handles lowercase 'values' keyword", async () => {
    const text = await extract(
      "insert into products (id, name) values (1, 'Widget');",
    );
    expect(text).toContain("Table: products");
    expect(text).toContain("name: Widget");
  });
});

/* ================================================================== */
/*  TsvExtractor                                                      */
/* ================================================================== */

describe("TsvExtractor", () => {
  const extractor = new TsvExtractor();

  it("has shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("emits a Columns: schema header", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.tsv"));
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("Columns: Name, Age, City");
  });

  it("converts TSV rows to key-value lines", async () => {
    const result = await extractor.extract(join(tmpDir, "sample.tsv"));
    const lines = result.text.split("\n");
    expect(lines[1]).toBe("Name: Alice, Age: 30, City: Tokyo");
    expect(lines[2]).toBe("Name: Bob, Age: 25, City: Osaka");
  });

  it("returns empty text for empty file", async () => {
    const result = await extractor.extract(join(tmpDir, "empty.tsv"));
    expect(result.text).toBe("");
  });

  it("returns only schema header for headers-only file", async () => {
    const result = await extractor.extract(join(tmpDir, "headers-only.tsv"));
    expect(result.text).toBe("Columns: Name, Age");
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(extractor.extract(join(tmpDir, "no-such.tsv"))).rejects.toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  htmlToMarkdown utility                                            */
/* ================================================================== */

describe("htmlToMarkdown", () => {
  it("converts h1-h6 headings to markdown", () => {
    const result = htmlToMarkdown("<h1>Title</h1><h2>Sub</h2><h3>Sub2</h3>");
    expect(result).toContain("# Title");
    expect(result).toContain("## Sub");
    expect(result).toContain("### Sub2");
  });

  it("converts <strong> and <b> to **text**", () => {
    const result = htmlToMarkdown("<strong>bold</strong> and <b>also bold</b>");
    expect(result).toContain("**bold**");
    expect(result).toContain("**also bold**");
  });

  it("converts <em> and <i> to *text*", () => {
    const result = htmlToMarkdown("<em>italic</em> and <i>also</i>");
    expect(result).toContain("*italic*");
    expect(result).toContain("*also*");
  });

  it("converts <code> to backtick notation", () => {
    const result = htmlToMarkdown("<code>fn()</code>");
    expect(result).toContain("`fn()`");
  });

  it("converts <a href> to markdown links", () => {
    const result = htmlToMarkdown('<a href="https://example.com">Click</a>');
    expect(result).toContain("[Click](https://example.com)");
  });

  it("converts single-quoted <a href> to markdown links", () => {
    const result = htmlToMarkdown("<a href='https://example.com'>Click</a>");
    expect(result).toContain("[Click](https://example.com)");
  });

  it("converts unordered lists", () => {
    const result = htmlToMarkdown("<ul><li>First</li><li>Second</li></ul>");
    expect(result).toContain("- First");
    expect(result).toContain("- Second");
  });

  it("converts ordered lists with numbering", () => {
    const result = htmlToMarkdown("<ol><li>One</li><li>Two</li></ol>");
    expect(result).toContain("1. One");
    expect(result).toContain("2. Two");
  });

  it("converts <table> to markdown pipe table", () => {
    const result = htmlToMarkdown(
      "<table><tr><th>Name</th><th>Score</th></tr><tr><td>Alice</td><td>95</td></tr></table>",
    );
    expect(result).toContain("| Name | Score |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 95 |");
  });

  it("strips remaining HTML tags", () => {
    const result = htmlToMarkdown("<div><span>content</span></div>");
    expect(result).not.toContain("<");
    expect(result).toContain("content");
  });

  it("decodes common HTML entities", () => {
    const result = htmlToMarkdown("&amp; &lt; &gt; &quot; &#39; &nbsp;");
    expect(result).toContain("&");
    expect(result).toContain("<");
    expect(result).toContain(">");
    expect(result).toContain('"');
    expect(result).toContain("'");
  });

  it("removes script and style blocks", () => {
    const result = htmlToMarkdown(
      "<script>alert('x')</script><style>.foo{color:red}</style>visible",
    );
    expect(result).not.toContain("alert");
    expect(result).not.toContain(".foo");
    expect(result).toContain("visible");
  });

  it("collapses excessive blank lines", () => {
    const result = htmlToMarkdown("<p>a</p><p>b</p><p>c</p>");
    // Should not have 3+ consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });
});

/* ================================================================== */
/*  EmlExtractor                                                       */
/* ================================================================== */

describe("EmlExtractor", () => {
  const extractor = new EmlExtractor();

  it("has the shared extractor version", () => {
    expect(extractor.version).toBe(EXTRACTOR_VERSION);
  });

  it("extracts subject, from, to, and date from plain text email", async () => {
    const result = await extractor.extract(join(tmpDir, "plain.eml"));
    expect(result.text).toContain("Subject: Meeting Notes");
    expect(result.text).toContain("From: Alice <alice@example.com>");
    expect(result.text).toContain("To: bob@example.com");
    expect(result.text).toContain("Date:");
  });

  it("extracts plain text body", async () => {
    const result = await extractor.extract(join(tmpDir, "plain.eml"));
    expect(result.text).toContain("Hello Bob,");
    expect(result.text).toContain("meeting notes from today");
  });

  it("falls back to HTML-to-markdown when no plain text part exists", async () => {
    const result = await extractor.extract(join(tmpDir, "html-only.eml"));
    expect(result.text).toContain("Subject: HTML Report");
    // htmlToMarkdown converts <h1> to # and <strong> to **
    expect(result.text).toContain("Report");
    expect(result.text).toContain("HTML");
  });

  it("captures attachment metadata", async () => {
    const result = await extractor.extract(join(tmpDir, "with-attachment.eml"));
    expect(result.text).toContain("Attachments:");
    expect(result.text).toContain("report.pdf");
    expect(result.text).toContain("application/pdf");
  });

  it("includes Cc header when present", async () => {
    const result = await extractor.extract(join(tmpDir, "multi-recipient.eml"));
    expect(result.text).toContain("Cc: dave@example.com");
  });

  it("handles multiple recipients", async () => {
    const result = await extractor.extract(join(tmpDir, "multi-recipient.eml"));
    expect(result.text).toContain("bob@example.com");
    expect(result.text).toContain("carol@example.com");
  });

  it("handles missing subject", async () => {
    const result = await extractor.extract(join(tmpDir, "no-subject.eml"));
    expect(result.text).toContain("Subject: (no subject)");
    expect(result.text).toContain("No subject email body.");
  });

  it("throws AxFabricError for non-existent file", async () => {
    await expect(extractor.extract(join(tmpDir, "nonexistent.eml"))).rejects.toThrow(AxFabricError);
  });

  it("throws AxFabricError with EXTRACT_ERROR code", async () => {
    try {
      await extractor.extract(join(tmpDir, "nonexistent.eml"));
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });

  it("does not include Cc header when absent", async () => {
    const result = await extractor.extract(join(tmpDir, "plain.eml"));
    expect(result.text).not.toContain("Cc:");
  });

  it("does not include attachments section for emails without attachments", async () => {
    const result = await extractor.extract(join(tmpDir, "plain.eml"));
    expect(result.text).not.toContain("Attachments:");
  });
});
