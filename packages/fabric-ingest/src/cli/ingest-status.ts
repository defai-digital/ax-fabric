/**
 * `ax-fabric ingest status` — show pipeline status from the Job Registry.
 */

import { join } from "node:path";

import type { Command } from "commander";

import { JobRegistry } from "../registry/index.js";

import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";

export function registerIngestStatusCommand(ingest: Command): void {
  ingest
    .command("status")
    .description("Show ingestion status for all tracked files")
    .action(async () => {
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const dataRoot = resolveDataRoot(config);

      const registryDbPath = join(dataRoot, "registry.db");
      let registry: JobRegistry;
      try {
        registry = new JobRegistry(registryDbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish a missing registry (never ingested) from a corrupt one.
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          console.log("No ingest history found. Run `ax-fabric ingest run` first.");
        } else {
          console.error(`Error: registry database appears corrupt: ${msg}`);
          console.error(`Path: ${registryDbPath}`);
          process.exit(1);
        }
        return;
      }

      try {
        const files = registry.listFiles();

        if (files.length === 0) {
          console.log("No files have been ingested yet.");
          return;
        }

        const successful = files.filter((f) => f.status === "success");
        const errored = files.filter((f) => f.status === "error");

        // Find the most recent ingest timestamp
        const timestamps = files.map((f) => f.lastIngestAt).sort();
        const lastIngest = timestamps[timestamps.length - 1];

        console.log("\nIngestion status:\n");
        console.log(`  Total files:   ${String(files.length)}`);
        console.log(`  Successful:    ${String(successful.length)}`);
        console.log(`  Errored:       ${String(errored.length)}`);
        console.log(`  Last ingest:   ${lastIngest ?? "n/a"}`);

        // List files with their status
        console.log("\n  Files:");
        for (const file of files) {
          const statusMark = file.status === "success" ? "ok" : "ERR";
          const chunks = file.chunkIds.length;
          console.log(`    [${statusMark}] ${file.sourcePath} (${String(chunks)} chunks)`);
        }

        // Show error details
        if (errored.length > 0) {
          console.log("\n  Error details:");
          for (const file of errored) {
            console.log(`    ${file.sourcePath}: ${file.errorMessage ?? "unknown error"}`);
          }
        }

        console.log();
      } finally {
        registry.close();
      }
    });
}
