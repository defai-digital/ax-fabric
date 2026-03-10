/**
 * `ax-fabric ingest diff` — show changed files since last ingest.
 */

import { join } from "node:path";

import type { Command } from "commander";

import { SourceScanner, createDefaultRegistry, JobRegistry } from "../index.js";

import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";

export function registerIngestDiffCommand(ingest: Command): void {
  ingest
    .command("diff")
    .description("Show changed files since last ingest")
    .action(async () => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const dataRoot = resolveDataRoot(config);

      // Set up scanner with supported extensions from default extractor registry
      const extractorRegistry = createDefaultRegistry();
      const scanner = new SourceScanner({
        extensions: extractorRegistry.getSupportedExtensions(),
      });

      // Scan all source paths — each source is scanned independently so one
      // inaccessible path doesn't prevent others from being diffed.
      const allResults = config.ingest.sources.flatMap((source) => {
        try {
          return scanner.scan(source.path);
        } catch (err) {
          console.warn(`Warning: failed to scan ${source.path}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      });

      // Load known fingerprints from Job Registry
      const registryDbPath = join(dataRoot, "registry.db");
      let registry: JobRegistry;
      try {
        registry = new JobRegistry(registryDbPath);
      } catch {
        // No registry yet — all files are new
        console.log("\nNo previous ingest found. All files are new.\n");
        console.log(`  New files: ${String(allResults.length)}`);
        for (const r of allResults) {
          console.log(`    + ${r.sourcePath}`);
        }
        return;
      }

      try {
        const knownFingerprints = registry.getKnownFingerprints();
        const changes = scanner.detectChanges(allResults, knownFingerprints);

        // Print results
        console.log("\nIngest diff:\n");

        if (changes.added.length > 0) {
          console.log(`  Added (${String(changes.added.length)}):`);
          for (const f of changes.added) {
            console.log(`    + ${f.sourcePath}`);
          }
        }

        if (changes.modified.length > 0) {
          console.log(`  Modified (${String(changes.modified.length)}):`);
          for (const f of changes.modified) {
            console.log(`    ~ ${f.sourcePath}`);
          }
        }

        if (changes.deleted.length > 0) {
          console.log(`  Deleted (${String(changes.deleted.length)}):`);
          for (const p of changes.deleted) {
            console.log(`    - ${p}`);
          }
        }

        console.log(`  Unchanged: ${String(changes.unchanged.length)}`);
        console.log();
      } finally {
        registry.close();
      }
    });
}
