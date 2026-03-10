export interface ParsedCommand {
  command: string;
  args: string[];
}

/**
 * Parse a command line into argv without invoking a shell.
 * Supports whitespace splitting, single/double quotes, and backslash escaping.
 */
export function parseCommandLine(commandLine: string): ParsedCommand {
  const input = commandLine.trim();
  if (!input) {
    throw new Error("mcp command is empty");
  }

  const out: string[] = [];
  let cur = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (escape || quote) {
    throw new Error("mcp command has invalid escaping or unmatched quote");
  }
  if (cur.length > 0) {
    out.push(cur);
  }
  if (out.length === 0) {
    throw new Error("mcp command is empty");
  }

  return { command: out[0]!, args: out.slice(1) };
}
