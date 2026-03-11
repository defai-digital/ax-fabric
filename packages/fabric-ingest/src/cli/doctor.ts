import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { readToken } from "../mcp/auth.js";
import {
  loadConfig,
  resolveConfigPath,
  resolveDataRoot,
  type FabricConfig,
} from "./config-loader.js";

type CheckLevel = "ok" | "warn" | "fail";

interface CheckResult {
  level: CheckLevel;
  label: string;
  detail: string;
}

function emit(result: CheckResult): void {
  const tag = result.level === "ok"
    ? "ok"
    : result.level === "warn"
      ? "warn"
      : "FAIL";
  console.log(`[${tag}] ${result.label}: ${result.detail}`);
}

function readDaemonStatus(): { status?: string; data_folder?: string; daemon_pid?: number } | undefined {
  const path = join(homedir(), ".ax-fabric", "status.json");
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { status?: string; data_folder?: string; daemon_pid?: number };
  } catch {
    return undefined;
  }
}

function collectServingUrls(config: FabricConfig): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];

  if (config.embedder.base_url) {
    out.push({ label: "embedder", url: config.embedder.base_url });
  }

  if (config.llm?.base_url) {
    out.push({ label: "llm", url: config.llm.base_url });
  }

  if (config.orchestrator) {
    out.push({
      label: "orchestrator-public",
      url: `http://${config.orchestrator.public_host}:${String(config.orchestrator.public_port)}/health`,
    });
    out.push({
      label: "orchestrator-internal",
      url: `http://${config.orchestrator.internal_host}:${String(config.orchestrator.internal_port)}/health`,
    });
  }

  return out;
}

async function checkReachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status >= 100;
  } catch {
    return false;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local AX Fabric stack readiness and common failure points")
    .option("-c, --config <path>", "Path to config.yaml (default: ~/.ax-fabric/config.yaml)")
    .option("--check-serving", "Probe configured local HTTP endpoints such as ax-serving and the orchestrator")
    .option("--timeout-ms <ms>", "Timeout for HTTP endpoint probes", "1500")
    .action(async (opts: { config?: string; checkServing?: boolean; timeoutMs: string }) => {
      const configPath = opts.config ?? resolveConfigPath();

      if (!existsSync(configPath)) {
        emit({
          level: "fail",
          label: "config",
          detail: `missing config file at ${configPath}`,
        });
        process.exitCode = 1;
        return;
      }

      emit({
        level: "ok",
        label: "config",
        detail: configPath,
      });

      let config: FabricConfig;
      try {
        config = loadConfig(configPath);
      } catch (error) {
        emit({
          level: "fail",
          label: "config-parse",
          detail: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
        return;
      }

      const dataRoot = resolveDataRoot(config);
      emit({
        level: existsSync(dataRoot) ? "ok" : "warn",
        label: "data-root",
        detail: existsSync(dataRoot) ? dataRoot : `${dataRoot} (missing; run 'ax-fabric init' or ingest once)`,
      });

      const akidbRoot = config.akidb.root.replace(/^~/, homedir());
      emit({
        level: existsSync(akidbRoot) ? "ok" : "warn",
        label: "akidb-root",
        detail: existsSync(akidbRoot) ? akidbRoot : `${akidbRoot} (missing collection storage)`,
      });

      emit({
        level: config.ingest.sources.length > 0 ? "ok" : "warn",
        label: "sources",
        detail: config.ingest.sources.length > 0
          ? `${String(config.ingest.sources.length)} source(s) configured`
          : "no sources configured; run 'ax-fabric ingest add <path>'",
      });

      const token = readToken();
      emit({
        level: token ? "ok" : "warn",
        label: "mcp-token",
        detail: token ? "present" : "missing; run 'ax-fabric mcp token ensure'",
      });

      const daemonStatus = readDaemonStatus();
      if (!daemonStatus) {
        emit({
          level: "warn",
          label: "daemon-status",
          detail: "no daemon status file; run 'ax-fabric daemon' if continuous sync is required",
        });
      } else {
        emit({
          level: daemonStatus.status === "error" ? "warn" : "ok",
          label: "daemon-status",
          detail: `${daemonStatus.status ?? "unknown"}`
            + (daemonStatus.data_folder ? ` (data folder: ${daemonStatus.data_folder})` : ""),
        });
      }

      if (!opts.checkServing) {
        return;
      }

      const timeoutMs = Number.parseInt(opts.timeoutMs, 10);
      const urls = collectServingUrls(config);
      if (urls.length === 0) {
        emit({
          level: "warn",
          label: "serving-check",
          detail: "no HTTP endpoints configured in embedder, llm, or orchestrator sections",
        });
        return;
      }

      let hasFailure = false;
      for (const entry of urls) {
        const reachable = await checkReachable(entry.url, Number.isFinite(timeoutMs) ? timeoutMs : 1500);
        emit({
          level: reachable ? "ok" : "fail",
          label: `endpoint:${entry.label}`,
          detail: reachable ? `${entry.url} reachable` : `${entry.url} unreachable`,
        });
        if (!reachable) {
          hasFailure = true;
        }
      }

      if (hasFailure) {
        process.exitCode = 1;
      }
    });
}
