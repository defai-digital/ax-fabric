import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

interface ParsedTable {
  name: string;
  columns: string[];
  rows: string[][];
}

/**
 * SQL dump extractor that parses CREATE TABLE, INSERT INTO, and
 * PostgreSQL COPY statements into structured text output.
 *
 * Each table section includes a `Table:` name, `Columns:` schema header,
 * and key-value data rows for TableChunker compatibility.
 */
export class SqlExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const tables = parseSqlDump(content);

      if (tables.length === 0) return { text: content };

      const sections = tables.map((table) => {
        const header = `Table: ${table.name}\nColumns: ${table.columns.join(", ")}`;
        const rows = table.rows.map((row) =>
          table.columns
            .map((col, i) => `${col}: ${row[i] ?? ""}`)
            .join(", "),
        );
        return [header, "---", ...rows].join("\n");
      });

      return {
        text: sections.join("\n\n"),
        tableRef: tables.map((t) => t.name).join(", "),
      };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract SQL content from ${filePath}`,
        err,
      );
    }
  }
}

function parseSqlDump(content: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const tableMap = new Map<string, ParsedTable>();
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();

    // Skip comments and empty lines
    if (line.startsWith("--") || line.startsWith("/*") || line === "") {
      i++;
      continue;
    }

    // CREATE TABLE
    const createMatch = line.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/i,
    );
    if (createMatch) {
      const tableName = createMatch[1]!;
      const columns: string[] = [];

      i++;
      while (i < lines.length) {
        const colLine = lines[i]!.trim();
        if (colLine.startsWith(")")) break;

        // Extract column name (skip constraints like PRIMARY KEY, FOREIGN KEY, etc.)
        const colMatch = colLine.match(/^["`]?(\w+)["`]?\s+\w/);
        if (
          colMatch &&
          !colLine.match(
            /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)\b/i,
          )
        ) {
          columns.push(colMatch[1]!);
        }
        i++;
      }

      if (columns.length > 0) {
        const table: ParsedTable = { name: tableName, columns, rows: [] };
        tableMap.set(tableName, table);
        tables.push(table);
      }
      i++;
      continue;
    }

    // INSERT INTO
    const insertMatch = line.match(
      /INSERT\s+INTO\s+["`]?(\w+)["`]?\s+(?:\(([^)]*)\)\s+)?VALUES\s*/i,
    );
    if (insertMatch) {
      const tableName = insertMatch[1]!;
      const insertColumnList = insertMatch[2];
      let table = tableMap.get(tableName);
      if (!table) {
        table = { name: tableName, columns: [], rows: [] };
        tableMap.set(tableName, table);
        tables.push(table);
      }

      // Use column list from INSERT INTO when table has no columns yet
      if (table.columns.length === 0 && insertColumnList) {
        table.columns = insertColumnList
          .split(",")
          .map((c) => c.trim().replace(/^["`]+|["`]+$/g, ""));
      }

      // Collect the full INSERT statement (may span multiple lines)
      let insertText = line;
      while (i + 1 < lines.length && !isStatementComplete(insertText)) {
        i++;
        insertText += " " + lines[i]!.trim();
      }

      // Extract value groups: (val1, val2, val3)
      const valuesIdx = insertText.search(/VALUES/i);
      const valuesSection = valuesIdx >= 0
        ? insertText.slice(valuesIdx + 6)
        : "";
      const valueGroups = extractValueGroups(valuesSection);

      for (const group of valueGroups) {
        const inner = group.slice(1, -1); // Remove parens
        const values = splitSqlValues(inner);
        table.rows.push(values);

        // Auto-detect column names if not from CREATE TABLE
        if (table.columns.length === 0) {
          table.columns = values.map((_, idx) => `col${idx + 1}`);
        }
      }
      i++;
      continue;
    }

    // COPY ... FROM stdin (PostgreSQL pg_dump)
    const copyMatch = line.match(
      /COPY\s+(?:public\.)?["`]?(\w+)["`]?\s*\(([^)]+)\)\s+FROM\s+stdin/i,
    );
    if (copyMatch) {
      const tableName = copyMatch[1]!;
      const columns = copyMatch[2]!
        .split(",")
        .map((c) => c.trim().replace(/^["` ]+|["` ]+$/g, ""));

      let table = tableMap.get(tableName);
      if (!table) {
        table = { name: tableName, columns, rows: [] };
        tableMap.set(tableName, table);
        tables.push(table);
      } else if (table.columns.length === 0) {
        table.columns = columns;
      }

      i++;
      // Read tab-delimited data until \. terminator
      while (i < lines.length) {
        const dataLine = lines[i]!;
        if (dataLine.trim() === "\\.") break;
        const values = dataLine
          .split("\t")
          .map((v) => (v === "\\N" ? "" : v));
        table.rows.push(values);
        i++;
      }
      i++;
      continue;
    }

    i++;
  }

  return tables;
}

/**
 * Check whether a SQL statement text is complete: it must end with `;`
 * and all single-quoted strings must be properly closed (even count of
 * unescaped single quotes, where `''` counts as an escaped quote).
 */
function isStatementComplete(text: string): boolean {
  if (!text.trimEnd().endsWith(";")) return false;

  let insideString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (insideString) {
      if (ch === "'") {
        if (i + 1 < text.length && text[i + 1] === "'") {
          i++; // skip escaped ''
        } else {
          insideString = false;
        }
      }
    } else {
      if (ch === "'") {
        insideString = true;
      }
    }
  }

  return !insideString;
}

/**
 * Extract balanced `(...)` value groups from the VALUES section of an
 * INSERT statement, properly respecting single-quoted strings that may
 * contain parentheses or escaped quotes (`''`).
 *
 * Returns the full `(...)` strings including the outer parens.
 */
function extractValueGroups(valuesSection: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let inString = false;
  let start = -1;

  for (let i = 0; i < valuesSection.length; i++) {
    const ch = valuesSection[i];

    if (inString) {
      if (ch === "'") {
        if (i + 1 < valuesSection.length && valuesSection[i + 1] === "'") {
          i++; // skip escaped ''
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      continue;
    }

    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start !== -1) {
        groups.push(valuesSection.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return groups;
}

function splitSqlValues(inner: string): string[] {
  const values: string[] = [];
  let current = "";
  let inString = false;
  let quote = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;

    if (inString) {
      if (ch === quote) {
        if (i + 1 < inner.length && inner[i + 1] === quote) {
          // Escaped quote
          current += ch;
          i++;
        } else {
          inString = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === ",") {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current.trim());

  // Clean up NULL values
  return values.map((v) => (v === "NULL" ? "" : v));
}
