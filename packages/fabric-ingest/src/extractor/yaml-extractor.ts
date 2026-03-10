import { readFile } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";
import { EXTRACTOR_VERSION } from "./extractor.js";
import type { ExtractedContent, Extractor } from "./extractor.js";

/**
 * YAML extractor that parses YAML and flattens to key-value lines,
 * using the same approach as the JSON extractor.
 */
export class YamlExtractor implements Extractor {
  readonly version = EXTRACTOR_VERSION;

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const content = await readFile(filePath, "utf-8");
      const yamlMod = await loadYaml();
      const data: unknown = yamlMod.parse(content);
      const lines: string[] = [];
      flatten(data, "", lines);
      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AxFabricError) throw err;
      throw new AxFabricError(
        "EXTRACT_ERROR",
        `Failed to extract YAML content from ${filePath}`,
        err,
      );
    }
  }
}

/** Lazy-load yaml package. */
async function loadYaml() {
  const mod = await import("yaml");
  return mod.default;
}

/**
 * Recursively flatten a value into "path: value" lines.
 */
function flatten(value: unknown, prefix: string, lines: string[]): void {
  if (value === null || value === undefined) {
    if (prefix) lines.push(`${prefix}: null`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix}: []`);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      flatten(value[i], `${prefix}[${i}]`, lines);
    }
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      if (prefix) lines.push(`${prefix}: {}`);
      return;
    }
    for (const key of keys) {
      const newPrefix = prefix ? `${prefix}.${key}` : key;
      flatten(obj[key], newPrefix, lines);
    }
    return;
  }

  // Primitive
  lines.push(`${prefix}: ${String(value)}`);
}
