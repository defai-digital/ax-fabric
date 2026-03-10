import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

export class RtfExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const text = rtfToText(content);
      return { text };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract RTF content from ${filePath}`,
        err,
      );
    }
  }
}

/**
 * Convert RTF content to plain text.
 * Handles control words, Unicode escapes, and group nesting.
 */
function rtfToText(rtf: string): string {
  const output: string[] = [];
  let i = 0;
  let depth = 0;
  let skipGroup = false;
  const skipDepth: number[] = [];

  // Groups to skip entirely (binary data, font tables, etc.)
  const skipGroups = new Set([
    "fonttbl", "colortbl", "stylesheet", "info", "pict",
    "header", "footer", "headerl", "headerr", "footerl", "footerr",
    "footnote", "fldinst",
  ]);

  while (i < rtf.length) {
    const ch = rtf[i]!;

    if (ch === "{") {
      depth++;
      i++;
      // Check if this group should be skipped
      if (rtf[i] === "\\" && !skipGroup) {
        // Read control word after opening brace
        const wordStart = i + 1;
        let wordEnd = wordStart;
        while (wordEnd < rtf.length && /[a-z]/i.test(rtf[wordEnd]!)) wordEnd++;
        const word = rtf.slice(wordStart, wordEnd);
        if (skipGroups.has(word)) {
          skipGroup = true;
          skipDepth.push(depth);
        }
      }
      continue;
    }

    if (ch === "}") {
      if (skipGroup && skipDepth.length > 0 && depth === skipDepth[skipDepth.length - 1]) {
        skipDepth.pop();
        if (skipDepth.length === 0) skipGroup = false;
      }
      depth--;
      i++;
      continue;
    }

    if (skipGroup) {
      i++;
      continue;
    }

    if (ch === "\\") {
      i++;
      if (i >= rtf.length) break;

      const next = rtf[i]!;

      // Escaped literal characters
      if (next === "\\" || next === "{" || next === "}") {
        output.push(next);
        i++;
        continue;
      }

      // Unicode escape: \uN?
      if (next === "u") {
        i++;
        let numStr = "";
        while (i < rtf.length && (/\d/.test(rtf[i]!) || (numStr === "" && rtf[i] === "-"))) {
          numStr += rtf[i];
          i++;
        }
        if (numStr) {
          const codePoint = parseInt(numStr, 10);
          // Handle negative values (RTF uses signed 16-bit)
          const actualCode = codePoint < 0 ? codePoint + 65536 : codePoint;
          output.push(String.fromCharCode(actualCode));
        }
        // Skip the replacement character (usually ?)
        if (i < rtf.length && rtf[i] === "?") i++;
        continue;
      }

      // Hex escape: \'XX
      if (next === "'") {
        i++;
        const hex = rtf.slice(i, i + 2);
        i += 2;
        const code = parseInt(hex, 16);
        if (!isNaN(code)) {
          output.push(String.fromCharCode(code));
        }
        continue;
      }

      // Control word
      let word = "";
      while (i < rtf.length && /[a-z]/i.test(rtf[i]!)) {
        word += rtf[i];
        i++;
      }

      // Read optional numeric parameter
      let param = "";
      while (i < rtf.length && (/\d/.test(rtf[i]!) || (param === "" && rtf[i] === "-"))) {
        param += rtf[i];
        i++;
      }

      // Skip the space delimiter after control word
      if (i < rtf.length && rtf[i] === " ") i++;

      // Handle \bin — skip N bytes of binary data
      if (word === "bin" && param) {
        const binLen = parseInt(param, 10);
        if (!isNaN(binLen) && binLen > 0) {
          i += binLen;
        }
        continue;
      }

      // Handle specific control words
      switch (word) {
        case "par":
        case "line":
          output.push("\n");
          break;
        case "tab":
          output.push("\t");
          break;
        case "lquote":
          output.push("\u2018");
          break;
        case "rquote":
          output.push("\u2019");
          break;
        case "ldblquote":
          output.push("\u201C");
          break;
        case "rdblquote":
          output.push("\u201D");
          break;
        case "emdash":
          output.push("\u2014");
          break;
        case "endash":
          output.push("\u2013");
          break;
        case "bullet":
          output.push("\u2022");
          break;
        // Skip all other control words silently
      }
      continue;
    }

    // Regular text character
    // Skip \r and \n (RTF uses \par for line breaks)
    if (ch !== "\r" && ch !== "\n") {
      output.push(ch);
    }
    i++;
  }

  // Clean up: collapse multiple newlines
  let result = output.join("");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();

  return result;
}
