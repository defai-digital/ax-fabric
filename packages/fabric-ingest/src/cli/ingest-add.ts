/**
 * `ax-fabric ingest add <path>` — register a source path in the config.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "commander";

import { loadConfig, resolveConfigPath, writeConfig } from "./config-loader.js";

export function registerIngestAddCommand(ingest: Command): void {
  ingest
    .command("add <path>")
    .description("Register a source path for ingestion")
    .action(async (rawPath: string) => {
      const absPath = resolve(rawPath);

      // Validate path exists
      if (!existsSync(absPath)) {
        console.error(`Error: path does not exist: ${absPath}`);
        process.exit(1);
      }

      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);

      // Check for duplicates
      const existing = config.ingest.sources.map((s) => s.path);
      if (existing.includes(absPath)) {
        console.log(`Source already registered: ${absPath}`);
        return;
      }

      // Add source and write config
      config.ingest.sources.push({ path: absPath });
      writeConfig(configPath, config);

      console.log(`Added source: ${absPath}`);
      console.log(`Total sources: ${String(config.ingest.sources.length)}`);
    });
}
