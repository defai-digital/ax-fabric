/**
 * `ax-fabric daemon` — start the long-running watch loop that polls source
 * folders and ingests changes into AkiDB automatically.
 *
 * Options:
 *   --once         Run a single cycle and exit (useful for testing / cron)
 *   -c, --config   Path to config.yaml (default: ~/.ax-fabric/config.yaml)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";

import { loadConfig, resolveConfigPath, resolveDataRoot } from "./config-loader.js";
import { createEmbedderFromConfig } from "./create-embedder.js";
import { Daemon } from "../daemon/watch.js";
import type { CycleResult } from "../daemon/watch.js";

// ─── Status file schema ───────────────────────────────────────────────────────

interface DaemonStatus {
  status: "idle" | "syncing" | "error";
  config_loaded: boolean;
  data_folder: string;
  last_sync_at: string | null;
  total_files: number;
  indexed_files: number;
  pending_files: number;
  error_files: number;
  daemon_pid: number;
}

/**
 * Write the daemon status to ~/.ax-fabric/status.json so that external tools
 * (e.g. Ax-Studio UI) can observe the daemon's progress without inspecting the
 * process directly.
 */
function writeStatus(axHome: string, status: DaemonStatus): void {
  try {
    if (!existsSync(axHome)) mkdirSync(axHome, { recursive: true });
    writeFileSync(join(axHome, "status.json"), JSON.stringify(status, null, 2), "utf-8");
  } catch {
    // Non-fatal — if we can't write the status file, continue running.
  }
}

function cycleResultToStatus(
  result: CycleResult,
): Pick<DaemonStatus, "total_files" | "indexed_files" | "pending_files" | "error_files"> {
  const m = result.pipeline;
  return {
    total_files: m?.filesScanned ?? 0,
    indexed_files: m?.filesSucceeded ?? 0,
    // "pending" = unchanged files not re-processed this cycle
    pending_files: m?.filesUnchanged ?? 0,
    error_files: m?.filesFailed ?? 0,
  };
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerDaemonCommand(program: Command): void {
  program
    .command("daemon")
    .description("Start the background watch daemon that auto-ingests file changes")
    .option("--once", "Run a single ingest cycle then exit")
    .option("-c, --config <path>", "Path to config.yaml (default: ~/.ax-fabric/config.yaml)")
    .action(async (opts: { once?: boolean; config?: string }) => {
      const configPath = opts.config ?? resolveConfigPath();
      const config = loadConfig(configPath);
      const dataRoot = resolveDataRoot(config);
      const axHome = join(homedir(), ".ax-fabric");

      const dataFolder = config.ingest.sources[0]?.path ?? dataRoot;
      const baseStatus: Omit<DaemonStatus, "status" | "last_sync_at" | "total_files" | "indexed_files" | "pending_files" | "error_files"> = {
        config_loaded: true,
        data_folder: dataFolder,
        daemon_pid: process.pid,
      };

      const akidbRoot = config.akidb.root.replace(/^~/, homedir());
      const db = new AkiDB({ storagePath: akidbRoot });
      const embedder = createEmbedderFromConfig(config);

      try {
        // Ensure the collection exists — only swallow "not found" / "already exists" errors.
        let collectionExists = false;
        try {
          db.getCollection(config.akidb.collection);
          collectionExists = true;
        } catch {
          // Collection doesn't exist yet — create it below.
        }
        if (!collectionExists) {
          db.createCollection({
            collectionId: config.akidb.collection,
            dimension: config.akidb.dimension,
            metric: config.akidb.metric,
            embeddingModelId: config.embedder.model_id,
          });
        }

        // Write initial "syncing" status so the UI sees the daemon starting up
        writeStatus(axHome, {
          ...baseStatus,
          status: "syncing",
          last_sync_at: null,
          total_files: 0,
          indexed_files: 0,
          pending_files: 0,
          error_files: 0,
        });

        const daemon = new Daemon({
          configPath,
          akidb: db,
          embedder,
          collectionId: config.akidb.collection,
          onCycleStart: () => {
            writeStatus(axHome, {
              ...baseStatus,
              status: "syncing",
              last_sync_at: null,
              total_files: 0,
              indexed_files: 0,
              pending_files: 0,
              error_files: 0,
            });
          },
          onCycleEnd: (result: CycleResult) => {
            const counts = cycleResultToStatus(result);
            writeStatus(axHome, {
              ...baseStatus,
              status: result.skipped ? "error" : "idle",
              last_sync_at: new Date().toISOString(),
              ...counts,
            });
          },
          onCycleError: () => {
            writeStatus(axHome, {
              ...baseStatus,
              status: "error",
              last_sync_at: new Date().toISOString(),
              total_files: 0,
              indexed_files: 0,
              pending_files: 0,
              error_files: 0,
            });
          },
        });

        console.log(`ax-fabric daemon starting (pid ${String(process.pid)})...`);
        if (opts.once) console.log("  --once: will run a single cycle then exit");

        const result = await daemon.run({ once: opts.once });
        console.log(`Daemon stopped: ${result.reason} (${String(result.cycles)} cycle(s))`);
      } finally {
        db.close();
        await embedder.close?.();
      }
    });
}
