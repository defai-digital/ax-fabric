/**
 * Tests for Task 3.8 — Config Loader.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { stringify } from "yaml";

import {
  loadConfig,
  resolveConfigPath,
  resolveDataRoot,
  resolveToken,
  writeConfig,
} from "./config-loader.js";
import type { FabricConfig } from "./config-loader.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ax-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpYaml(filename: string, content: unknown): string {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, stringify(content), "utf8");
  return filePath;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resolveConfigPath", () => {
  it("returns a path under the home directory", () => {
    const p = resolveConfigPath();
    expect(p).toBe(join(homedir(), ".ax-fabric", "config.yaml"));
  });
});

describe("resolveDataRoot", () => {
  it("expands ~ to the home directory", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.yaml"));
    const root = resolveDataRoot(config);
    expect(root).toBe(join(homedir(), ".ax-fabric", "data"));
  });

  it("returns an absolute path for non-tilde roots", () => {
    const configPath = writeTmpYaml("custom.yaml", {
      fabric: { data_root: "/opt/ax-data" },
    });
    const config = loadConfig(configPath);
    expect(resolveDataRoot(config)).toBe("/opt/ax-data");
  });
});

describe("loadConfig", () => {
  it("returns schema defaults when the file does not exist", () => {
    const config = loadConfig(join(tmpDir, "missing.yaml"));

    expect(config.fabric.data_root).toBe("~/.ax-fabric/data");
    expect(config.fabric.max_storage_gb).toBe(50);
    expect(config.akidb.collection).toBe("default");
    expect(config.akidb.metric).toBe("cosine");
    expect(config.akidb.dimension).toBe(1024);
    expect(config.ingest.scan.mode).toBe("incremental");
    expect(config.ingest.chunking.chunk_size).toBe(2800);
    expect(config.ingest.chunking.overlap).toBe(0.15);
    expect(config.ingest.chunking.strategy).toBe("auto");
    expect(config.embedder.type).toBe("local");
    expect(config.embedder.dimension).toBe(128);
    expect(config.embedder.batch_size).toBe(64);
    expect(config.schedule).toBeUndefined();
    expect(config.lifecycle).toBeUndefined();
    expect(config.llm).toBeUndefined();
  });

  it("loads and validates a complete YAML config", () => {
    const raw = {
      fabric: { data_root: "/my/data" },
      akidb: {
        root: "/my/akidb",
        collection: "docs",
        metric: "l2",
        dimension: 768,
      },
      ingest: {
        sources: [{ path: "/docs" }],
        scan: { mode: "incremental", fingerprint: "sampled" },
        chunking: { chunk_size: 1024, overlap: 0.2, strategy: "structured" },
      },
      embedder: {
        type: "http",
        model_id: "text-embedding-3-small",
        dimension: 1536,
        batch_size: 32,
        base_url: "https://api.example.com",
      },
      llm: {
        type: "http",
        model_id: "qwen3-0.6b",
        base_url: "https://llm.example.com/v1",
        auth: { scheme: "bearer", token: "test-token" },
        timeout_seconds: 120,
      },
    };

    const configPath = writeTmpYaml("full.yaml", raw);
    const config = loadConfig(configPath);

    expect(config.fabric.data_root).toBe("/my/data");
    expect(config.akidb.metric).toBe("l2");
    expect(config.akidb.dimension).toBe(768);
    expect(config.ingest.sources).toHaveLength(1);
    expect(config.ingest.sources[0]!.path).toBe("/docs");
    expect(config.ingest.scan.fingerprint).toBe("sampled");
    expect(config.ingest.chunking.chunk_size).toBe(1024);
    expect(config.ingest.chunking.strategy).toBe("structured");
    expect(config.embedder.type).toBe("http");
    expect(config.embedder.dimension).toBe(1536);
    expect(config.llm?.model_id).toBe("qwen3-0.6b");
    expect(config.llm?.auth.token).toBe("test-token");
    expect(config.llm?.timeout_seconds).toBe(120);
  });

  it("fills defaults for partial config", () => {
    const configPath = writeTmpYaml("partial.yaml", {
      akidb: { collection: "wiki" },
    });
    const config = loadConfig(configPath);

    expect(config.akidb.collection).toBe("wiki");
    // Other fields get defaults:
    expect(config.akidb.metric).toBe("cosine");
    expect(config.fabric.data_root).toBe("~/.ax-fabric/data");
    expect(config.ingest.chunking.chunk_size).toBe(2800);
  });

  it("throws on invalid field values", () => {
    const configPath = writeTmpYaml("bad.yaml", {
      akidb: { metric: "invalid-metric" },
    });

    expect(() => loadConfig(configPath)).toThrow(/Invalid config/);
  });

  it("throws on invalid types", () => {
    const configPath = writeTmpYaml("bad-type.yaml", {
      akidb: { dimension: "not-a-number" },
    });

    expect(() => loadConfig(configPath)).toThrow(/Invalid config/);
  });

  it("handles an empty YAML file (returns defaults)", () => {
    const configPath = join(tmpDir, "empty.yaml");
    writeFileSync(configPath, "", "utf8");

    const config = loadConfig(configPath);
    expect(config.fabric.data_root).toBe("~/.ax-fabric/data");
    expect(config.akidb.dimension).toBe(1024);
  });
});

describe("v2.5 config sections", () => {
  it("loads schedule config with defaults", () => {
    const configPath = writeTmpYaml("schedule.yaml", {
      schedule: { interval_minutes: 30 },
    });
    const config = loadConfig(configPath);
    expect(config.schedule?.interval_minutes).toBe(30);
    expect(config.schedule?.quiet_hours).toBeUndefined();
  });

  it("loads schedule with quiet hours", () => {
    const configPath = writeTmpYaml("schedule-quiet.yaml", {
      schedule: {
        interval_minutes: 5,
        quiet_hours: { start: "01:00", end: "05:00" },
      },
    });
    const config = loadConfig(configPath);
    expect(config.schedule?.quiet_hours?.start).toBe("01:00");
    expect(config.schedule?.quiet_hours?.end).toBe("05:00");
  });

  it("loads lifecycle config", () => {
    const configPath = writeTmpYaml("lifecycle.yaml", {
      lifecycle: {
        store_chunk_text: false,
        compact_threshold: 100,
        archive_retention_days: 14,
      },
    });
    const config = loadConfig(configPath);
    expect(config.lifecycle?.store_chunk_text).toBe(false);
    expect(config.lifecycle?.compact_threshold).toBe(100);
    expect(config.lifecycle?.archive_retention_days).toBe(14);
  });

  it("uses lifecycle defaults when partial", () => {
    const configPath = writeTmpYaml("lifecycle-partial.yaml", {
      lifecycle: {},
    });
    const config = loadConfig(configPath);
    expect(config.lifecycle?.store_chunk_text).toBe(true);
    expect(config.lifecycle?.compact_threshold).toBe(50);
    expect(config.lifecycle?.archive_retention_days).toBe(7);
  });

  it("loads max_storage_gb in fabric section", () => {
    const configPath = writeTmpYaml("storage.yaml", {
      fabric: { max_storage_gb: 100 },
    });
    const config = loadConfig(configPath);
    expect(config.fabric.max_storage_gb).toBe(100);
  });

  it("loads complete v2.5 config with all new sections", () => {
    const configPath = writeTmpYaml("v25-full.yaml", {
      fabric: { data_root: "/data", max_storage_gb: 25 },
      schedule: { interval_minutes: 15, quiet_hours: { start: "03:00", end: "07:00" } },
      lifecycle: { store_chunk_text: true, compact_threshold: 75, archive_retention_days: 30 },
      orchestrator: {
        public_host: "127.0.0.1",
        public_port: 18080,
        internal_host: "127.0.0.1",
        internal_port: 19090,
        auth_token_env: "AX_FABRIC_ORCH_TOKEN",
      },
    });
    const config = loadConfig(configPath);
    expect(config.fabric.max_storage_gb).toBe(25);
    expect(config.schedule?.interval_minutes).toBe(15);
    expect(config.lifecycle?.archive_retention_days).toBe(30);
    expect(config.orchestrator?.public_host).toBe("127.0.0.1");
    expect(config.orchestrator?.auth_token_env).toBe("AX_FABRIC_ORCH_TOKEN");
  });

  it("applies defaults inside orchestrator section", () => {
    const configPath = writeTmpYaml("orchestrator-defaults.yaml", {
      orchestrator: {},
    });
    const config = loadConfig(configPath);
    expect(config.orchestrator?.public_host).toBe("127.0.0.1");
    expect(config.orchestrator?.public_port).toBe(18080);
    expect(config.orchestrator?.internal_host).toBe("127.0.0.1");
    expect(config.orchestrator?.internal_port).toBe(19090);
  });
});

describe("resolveToken", () => {
  const ENV_KEY = "AX_TEST_TOKEN_" + Date.now();

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns env var value when token_env is set and env var exists", () => {
    process.env[ENV_KEY] = "from-env";
    const result = resolveToken({ token: "from-file", token_env: ENV_KEY });
    expect(result).toBe("from-env");
  });

  it("falls back to raw token when env var is unset", () => {
    const result = resolveToken({ token: "from-file", token_env: ENV_KEY });
    expect(result).toBe("from-file");
  });

  it("falls back to raw token when env var is empty string", () => {
    process.env[ENV_KEY] = "";
    const result = resolveToken({ token: "from-file", token_env: ENV_KEY });
    expect(result).toBe("from-file");
  });

  it("returns undefined when neither token nor env var is set", () => {
    const result = resolveToken({});
    expect(result).toBeUndefined();
  });

  it("returns raw token when only token is provided", () => {
    const result = resolveToken({ token: "raw-secret" });
    expect(result).toBe("raw-secret");
  });

  it("returns undefined when only token_env is set but env var is missing", () => {
    const result = resolveToken({ token_env: "NONEXISTENT_VAR_12345" });
    expect(result).toBeUndefined();
  });
});

describe("writeConfig", () => {
  it("serializes config to YAML and writes to disk", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.yaml"));
    const outPath = join(tmpDir, "output.yaml");

    writeConfig(outPath, config);

    const raw = readFileSync(outPath, "utf8");
    expect(raw).toContain("data_root");
    expect(raw).toContain("cosine");
  });

  it("creates parent directories if needed", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.yaml"));
    const outPath = join(tmpDir, "nested", "deep", "config.yaml");

    writeConfig(outPath, config);

    const raw = readFileSync(outPath, "utf8");
    expect(raw).toContain("data_root");
  });

  it("roundtrips — load then write then load produces the same config", () => {
    const original: Record<string, unknown> = {
      fabric: { data_root: "/roundtrip/data" },
      akidb: {
        root: "/roundtrip/akidb",
        collection: "test-col",
        metric: "dot",
        dimension: 512,
      },
      ingest: {
        sources: [{ path: "/docs/a" }, { path: "/docs/b" }],
        scan: { mode: "incremental", fingerprint: "sha256" },
        chunking: { chunk_size: 1000, overlap: 0.1 },
      },
      embedder: {
        type: "http",
        model_id: "embed-v2",
        dimension: 256,
        batch_size: 16,
        base_url: "https://embed.example.com",
      },
      llm: {
        type: "http",
        model_id: "gpt-4o-mini",
        base_url: "https://api.openai.com/v1",
        auth: { scheme: "bearer", token: "sk-test-123" },
        timeout_seconds: 30,
      },
    };

    const inputPath = writeTmpYaml("roundtrip-in.yaml", original);
    const config = loadConfig(inputPath);

    const outPath = join(tmpDir, "roundtrip-out.yaml");
    writeConfig(outPath, config);

    const reloaded = loadConfig(outPath);
    expect(reloaded).toEqual(config);
  });
});
