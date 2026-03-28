/**
 * Email (.eml) extractor — RFC 2822 / MIME message parser.
 *
 * Phase 1 email ingestion (FR-10): headers, body (text + HTML fallback),
 * attachment metadata. Attachment content ingestion is deferred.
 */

import { readFile } from "node:fs/promises";

import { AxFabricError } from "@ax-fabric/contracts";

import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

export class EmlExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const simpleParser = await loadMailparser();
      const source = await readFile(filePath);
      const parsed = await simpleParser(source);

      const lines: string[] = [];

      // Headers
      lines.push(`Subject: ${parsed.subject ?? "(no subject)"}`);
      if (parsed.from) {
        lines.push(`From: ${formatAddresses(parsed.from)}`);
      }
      if (parsed.to) {
        lines.push(`To: ${formatAddresses(parsed.to)}`);
      }
      if (parsed.cc) {
        lines.push(`Cc: ${formatAddresses(parsed.cc)}`);
      }
      if (parsed.date) {
        lines.push(`Date: ${parsed.date.toISOString()}`);
      }

      // Body
      let body = "";
      if (parsed.text) {
        body = parsed.text;
      } else if (parsed.html) {
        body = htmlToMarkdown(typeof parsed.html === "string" ? parsed.html : "");
      }
      if (body) {
        lines.push("");
        lines.push(body.trim());
      }

      // Attachments
      if (parsed.attachments && parsed.attachments.length > 0) {
        lines.push("");
        lines.push("---");
        lines.push("Attachments:");
        for (const att of parsed.attachments) {
          const name = att.filename ?? "(unnamed)";
          const type = att.contentType ?? "application/octet-stream";
          const size = formatSize(att.size);
          lines.push(`- ${name} (${type}, ${size})`);
        }
      }

      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract EML content from ${filePath}`,
        err,
      );
    }
  }
}

async function loadMailparser() {
  const mod = await import("mailparser");
  return mod.simpleParser;
}

function formatAddresses(
  addr: { value: Array<{ name?: string; address?: string }> } | Array<{ value: Array<{ name?: string; address?: string }> }>,
): string {
  const list = Array.isArray(addr) ? addr : [addr];
  return list
    .flatMap((group) => group.value)
    .map((entry) => {
      if (entry.name && entry.address) {
        return `${entry.name} <${entry.address}>`;
      }
      return entry.address ?? entry.name ?? "";
    })
    .filter(Boolean)
    .join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
