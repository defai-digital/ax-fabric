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

interface DoctorReport {
  configPath: string;
  checks: CheckResult[];
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

function push(report: DoctorReport, result: CheckResult, json: boolean): void {
  report.checks.push(result);
  if (!json) {
    emit(result);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local AX Fabric stack readiness and common failure points")
    .option("-c, --config <path>", "Path to config.yaml (default: ~/.ax-fabric/config.yaml)")
    .option("--check-serving", "Probe configured local HTTP endpoints such as ax-serving and the orchestrator")
    .option("--json", "Print machine-readable JSON output")
    .option("--timeout-ms <ms>", "Timeout for HTTP endpoint probes", "1500")
    .action(async (opts: { config?: string; checkServing?: boolean; json?: boolean; timeoutMs: string }) => {
      const configPath = opts.config ?? resolveConfigPath();
      const report: DoctorReport = { configPath, checks: [] };

      if (!existsSync(configPath)) {
        push(report, {
          level: "fail",
          label: "config",
          detail: `missing config file at ${configPath}`,
        }, Boolean(opts.json));
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        }
        process.exitCode = 1;
        return;
      }

      push(report, {
        level: "ok",
        label: "config",
        detail: configPath,
      }, Boolean(opts.json));

      let config: FabricConfig;
      try {
        config = loadConfig(configPath);
      } catch (error) {
        push(report, {
          level: "fail",
          label: "config-parse",
          detail: error instanceof Error ? error.message : String(error),
        }, Boolean(opts.json));
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        }
        process.exitCode = 1;
        return;
      }

      const dataRoot = resolveDataRoot(config);
      push(report, {
        level: existsSync(dataRoot) ? "ok" : "warn",
        label: "data-root",
        detail: existsSync(dataRoot) ? dataRoot : `${dataRoot} (missing; run 'ax-fabric init' or ingest once)`,
      }, Boolean(opts.json));

      const akidbRoot = config.akidb.root.replace(/^~/, homedir());
      push(report, {
        level: existsSync(akidbRoot) ? "ok" : "warn",
        label: "akidb-root",
        detail: existsSync(akidbRoot) ? akidbRoot : `${akidbRoot} (missing collection storage)`,
      }, Boolean(opts.json));

      push(report, {
        level: config.ingest.sources.length > 0 ? "ok" : "warn",
        label: "sources",
        detail: config.ingest.sources.length > 0
          ? `${String(config.ingest.sources.length)} source(s) configured`
          : "no sources configured; run 'ax-fabric ingest add <path>'",
      }, Boolean(opts.json));

      for (const source of config.ingest.sources) {
        push(report, {
          level: existsSync(source.path) ? "ok" : "warn",
          label: `source:${source.path}`,
          detail: existsSync(source.path) ? "path exists" : "path missing or unavailable",
        }, Boolean(opts.json));
      }

      if (config.embedder.api_key_env) {
        push(report, {
          level: process.env[config.embedder.api_key_env] ? "ok" : "warn",
          label: `env:${config.embedder.api_key_env}`,
          detail: process.env[config.embedder.api_key_env]
            ? "present"
            : "missing; embedder may fail authentication",
        }, Boolean(opts.json));
      }

      if (config.llm?.auth.token_env) {
        push(report, {
          level: process.env[config.llm.auth.token_env] ? "ok" : "warn",
          label: `env:${config.llm.auth.token_env}`,
          detail: process.env[config.llm.auth.token_env]
            ? "present"
            : "missing; grounded answer generation may fail authentication",
        }, Boolean(opts.json));
      }

      const token = readToken();
      push(report, {
        level: token ? "ok" : "warn",
        label: "mcp-token",
        detail: token ? "present" : "missing; run 'ax-fabric mcp token ensure'",
      }, Boolean(opts.json));

      const daemonStatus = readDaemonStatus();
      if (!daemonStatus) {
        push(report, {
          level: "warn",
          label: "daemon-status",
          detail: "no daemon status file; run 'ax-fabric daemon' if continuous sync is required",
        }, Boolean(opts.json));
      } else {
        push(report, {
          level: daemonStatus.status === "error" ? "warn" : "ok",
          label: "daemon-status",
          detail: `${daemonStatus.status ?? "unknown"}`
            + (daemonStatus.data_folder ? ` (data folder: ${daemonStatus.data_folder})` : ""),
        }, Boolean(opts.json));
      }

      if (!opts.checkServing) {
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        }
        return;
      }

      const timeoutMs = Number.parseInt(opts.timeoutMs, 10);
      const urls = collectServingUrls(config);
      if (urls.length === 0) {
        push(report, {
          level: "warn",
          label: "serving-check",
          detail: "no HTTP endpoints configured in embedder, llm, or orchestrator sections",
        }, Boolean(opts.json));
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        }
        return;
      }

      let hasFailure = false;
      for (const entry of urls) {
        const reachable = await checkReachable(entry.url, Number.isFinite(timeoutMs) ? timeoutMs : 1500);
        push(report, {
          level: reachable ? "ok" : "fail",
          label: `endpoint:${entry.label}`,
          detail: reachable ? `${entry.url} reachable` : `${entry.url} unreachable`,
        }, Boolean(opts.json));
        if (!reachable) {
          hasFailure = true;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      }

      if (hasFailure) {
        process.exitCode = 1;
      }
    });
}
