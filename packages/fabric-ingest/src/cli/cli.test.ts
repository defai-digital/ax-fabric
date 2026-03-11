/**
 * CLI integration tests — programmatic invocation via commander's parseAsync.
 *
 * Each test creates a temp workspace, wires config to it, and invokes
 * CLI commands without spawning child processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";

import { registerInitCommand } from "./init.js";
import { registerIngestAddCommand } from "./ingest-add.js";
import { registerIngestDiffCommand } from "./ingest-diff.js";
import { registerIngestRunCommand } from "./ingest-run.js";
import { registerIngestStatusCommand } from "./ingest-status.js";
import { registerSearchCommand } from "./search.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerEvalCommand } from "./eval.js";
import { registerMemoryCommand } from "./memory.js";
import { registerSemanticCommand } from "./semantic.js";
import { SemanticStore } from "../semantic/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cli-test-${prefix}-`));
}

/**
 * Build a minimal FabricConfig YAML for testing.
 * We write it as YAML content that the config-loader would parse.
 */
function writeTestConfig(
  configPath: string,
  overrides: {
    dataRoot: string;
    akidbRoot: string;
    sources?: string[];
    collection?: string;
    dimension?: number;
  },
): void {
  const sources = (overrides.sources ?? [])
    .map((s) => `  - path: "${s}"`)
    .join("\n");

  const yaml = `
fabric:
  data_root: "${overrides.dataRoot}"

akidb:
  root: "${overrides.akidbRoot}"
  collection: "${overrides.collection ?? "test-col"}"
  metric: cosine
  dimension: ${String(overrides.dimension ?? 128)}

ingest:
  sources:
${sources || "  []"}
  scan:
    mode: incremental
    fingerprint: sha256
  chunking:
    chunk_size: 512
    overlap: 0.15

embedder:
  type: local
  model_id: mock-embed-v1
  dimension: ${String(overrides.dimension ?? 128)}
  batch_size: 64
`;
  writeFileSync(configPath, yaml, "utf-8");
}

/**
 * Create a test AkiDB instance and the default collection.
 */
function createTestDb(akidbRoot: string, dimension = 128): AkiDB {
  mkdirSync(akidbRoot, { recursive: true });
  const db = new AkiDB({
    storagePath: akidbRoot,
  });
  db.createCollection({
    collectionId: "test-col",
    dimension,
    metric: "cosine",
    embeddingModelId: "mock-embed-v1",
  });
  return db;
}

// ─── Mock config-loader ──────────────────────────────────────────────────────

// We mock the config-loader module to use test-specific paths.
// The real config-loader is being built in parallel; these mocks ensure
// CLI commands work with predictable test data.

let mockConfigPath = "";
let mockConfig: Record<string, unknown> = {};
let mockMcpToken: string | undefined;

vi.mock("./config-loader.js", () => ({
  resolveConfigPath: () => mockConfigPath,
  loadConfig: (_path?: string) => mockConfig,
  resolveDataRoot: (config: { fabric: { data_root: string } }) => config.fabric.data_root,
  resolveToken: (auth: { token?: string; token_env?: string }) => {
    if (auth.token) return auth.token;
    if (auth.token_env) return process.env[auth.token_env];
    return undefined;
  },
  writeConfig: (path: string, config: Record<string, unknown>) => {
    const yaml = JSON.stringify(config, null, 2);
    writeFileSync(path, yaml, "utf-8");
    // Also update the mock so subsequent loadConfig calls see the change
    mockConfig = config;
  },
}));

vi.mock("../mcp/auth.js", () => ({
  readToken: () => mockMcpToken,
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLI commands", () => {
  let workDir: string;
  let dataRoot: string;
  let akidbRoot: string;
  let sourceDir: string;
  let configPath: string;
  let db: AkiDB;

  beforeEach(() => {
    workDir = makeTmpDir("work");
    dataRoot = join(workDir, "data");
    akidbRoot = join(dataRoot, "akidb");
    sourceDir = makeTmpDir("sources");
    configPath = join(workDir, "config.yaml");

    mkdirSync(dataRoot, { recursive: true });

    db = createTestDb(akidbRoot);

    // Set up mock config
    mockConfigPath = configPath;
    mockConfig = {
      fabric: { data_root: dataRoot },
      akidb: {
        root: akidbRoot,
        collection: "test-col",
        metric: "cosine",
        dimension: 128,
      },
      ingest: {
        sources: [] as Array<{ path: string }>,
        scan: { mode: "incremental", fingerprint: "sha256" },
        chunking: { chunk_size: 512, overlap: 0.15, strategy: "auto" },
      },
      embedder: {
        type: "local",
        model_id: "mock-embed-v1",
        dimension: 128,
        batch_size: 64,
      },
    };
    mockMcpToken = undefined;

    writeTestConfig(configPath, {
      dataRoot,
      akidbRoot,
      sources: [],
    });
  });

  afterEach(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  // ─── init ────────────────────────────────────────────────────────────────

  describe("init", () => {
    it("creates workspace directories and config", async () => {
      // Use a fresh directory for init testing
      const initHome = join(workDir, "init-test");

      // Temporarily override homedir for the init command
      const originalHome = process.env["HOME"];
      process.env["HOME"] = initHome;

      const program = new Command();
      program.exitOverride();
      registerInitCommand(program);

      // Suppress console output during test
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await program.parseAsync(["node", "test", "init"]);
      } catch {
        // Commander may throw on exitOverride
      }

      logSpy.mockRestore();
      process.env["HOME"] = originalHome;

      const axFabricDir = join(initHome, ".ax-fabric");
      expect(existsSync(axFabricDir)).toBe(true);
      expect(existsSync(join(axFabricDir, "data"))).toBe(true);
      expect(existsSync(join(axFabricDir, "data", "akidb"))).toBe(true);
      expect(existsSync(join(axFabricDir, "config.yaml"))).toBe(true);
    });
  });

  // ─── ingest add ──────────────────────────────────────────────────────────

  describe("ingest add", () => {
    it("adds a source path to config", async () => {
      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestAddCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "ingest", "add", sourceDir]);

      logSpy.mockRestore();

      // Check the mock config was updated
      const sources = (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources;
      expect(sources.length).toBe(1);
      expect(sources[0]!.path).toBe(sourceDir);
    });

    it("does not add duplicate paths", async () => {
      // Pre-add the source to config
      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestAddCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "ingest", "add", sourceDir]);

      logSpy.mockRestore();

      const sources = (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources;
      expect(sources.length).toBe(1);
    });
  });

  describe("doctor", () => {
    it("reports local readiness checks", async () => {
      mockMcpToken = "axf_tk_exampletoken";
      mkdirSync(join(workDir, ".ax-fabric"), { recursive: true });
      writeFileSync(
        join(workDir, ".ax-fabric", "status.json"),
        JSON.stringify({
          status: "idle",
          data_folder: sourceDir,
          daemon_pid: 12345,
        }),
        "utf-8",
      );

      const originalHome = process.env["HOME"];
      process.env["HOME"] = workDir;

      const program = new Command();
      program.exitOverride();
      registerDoctorCommand(program);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await program.parseAsync(["node", "test", "doctor", "--config", configPath]);
      } catch {
        // Commander may throw on exitOverride
      } finally {
        process.env["HOME"] = originalHome;
      }

      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("[ok] config:");
      expect(output).toContain("[ok] mcp-token: present");
      expect(output).toContain("[ok] daemon-status: idle");
    });

    it("checks configured HTTP endpoints when requested", async () => {
      mockConfig = {
        ...mockConfig,
        embedder: {
          type: "http",
          model_id: "text-embedding-3-small",
          dimension: 128,
          batch_size: 64,
          base_url: "http://127.0.0.1:18080/v1/embeddings",
        },
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;

      const program = new Command();
      program.exitOverride();
      registerDoctorCommand(program);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await program.parseAsync(["node", "test", "doctor", "--config", configPath, "--check-serving"]);
      } catch {
        // Commander may throw on exitOverride
      } finally {
        globalThis.fetch = originalFetch;
      }

      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("[ok] endpoint:embedder:");
      expect(output).toContain("reachable");
    });

    it("prints JSON output for automation workflows", async () => {
      mockConfig = {
        ...mockConfig,
        ingest: {
          ...mockConfig["ingest"] as Record<string, unknown>,
          sources: [{ path: sourceDir }],
        },
        embedder: {
          type: "http",
          model_id: "text-embedding-3-small",
          dimension: 128,
          batch_size: 64,
          base_url: "http://127.0.0.1:18080/v1/embeddings",
          api_key_env: "EMBEDDING_API_KEY",
        },
      };
      process.env["EMBEDDING_API_KEY"] = "test-token";

      const program = new Command();
      program.exitOverride();
      registerDoctorCommand(program);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await program.parseAsync(["node", "test", "doctor", "--config", configPath, "--json"]);
      } catch {
        // Commander may throw on exitOverride
      } finally {
        delete process.env["EMBEDDING_API_KEY"];
      }

      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("\"configPath\"");
      expect(output).toContain("\"label\": \"env:EMBEDDING_API_KEY\"");
      expect(output).toContain("\"label\": \"source:");
    });
  });

  // ─── ingest diff ─────────────────────────────────────────────────────────

  describe("ingest diff", () => {
    it("shows all files as new when no previous ingest", async () => {
      writeFileSync(join(sourceDir, "doc.txt"), "Hello world content for testing.");

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestDiffCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "ingest", "diff"]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      // Should report files as new since no registry exists
      expect(output).toContain("doc.txt");
    });
  });

  // ─── ingest run ──────────────────────────────────────────────────────────

  describe("ingest run", () => {
    it("executes the pipeline and prints metrics", async () => {
      writeFileSync(
        join(sourceDir, "test.txt"),
        "This is test content for the ingestion pipeline. It should be processed successfully.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestRunCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "ingest", "run"]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Pipeline completed");
      expect(output).toContain("Files scanned:");
      expect(output).toContain("Records generated:");
    });
  });

  // ─── ingest status ───────────────────────────────────────────────────────

  describe("ingest status", () => {
    it("shows status after a successful ingest", async () => {
      // First, run an ingest to populate the registry
      writeFileSync(
        join(sourceDir, "status-test.txt"),
        "Content for the status test command verification.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      // Run ingest first
      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);

      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      // Now check status
      const statusProgram = new Command();
      statusProgram.exitOverride();
      const statusIngest = statusProgram.command("ingest");
      registerIngestStatusCommand(statusIngest);

      const statusLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await statusProgram.parseAsync(["node", "test", "ingest", "status"]);

      const output = statusLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      statusLogSpy.mockRestore();

      expect(output).toContain("Total files:");
      expect(output).toContain("Successful:");
      expect(output).toContain("status-test.txt");
    });
  });

  // ─── ingest run — edge cases ─────────────────────────────────────────────────

  describe("ingest run edge cases", () => {
    it("exits with error when no sources are configured", async () => {
      // mockConfig already has sources: []
      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestRunCommand(ingest);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync(["node", "test", "ingest", "run"]),
      ).rejects.toThrow("process.exit");

      const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      errSpy.mockRestore();
      exitSpy.mockRestore();

      expect(errOutput).toContain("No sources configured");
    });

    it("processes multiple files in a single run", async () => {
      writeFileSync(join(sourceDir, "file-a.txt"), "Content of file A for testing purposes.");
      writeFileSync(join(sourceDir, "file-b.txt"), "Content of file B with different content.");
      writeFileSync(join(sourceDir, "file-c.txt"), "Content of file C, the third file.");

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestRunCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await program.parseAsync(["node", "test", "ingest", "run"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      // The output format uses padded labels: "Files scanned:     3"
      expect(output).toContain("Files scanned:");
      expect(output).toMatch(/Files scanned:\s+3/);
      expect(output).toMatch(/Files added:\s+3|Added:\s+3/);
    });
  });

  // ─── ingest status — edge cases ──────────────────────────────────────────────

  describe("ingest status edge cases", () => {
    it("shows a helpful message when no ingest has run yet", async () => {
      // The registry.db does not exist before the first ingest run.
      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestStatusCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await program.parseAsync(["node", "test", "ingest", "status"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      // Either "No ingest history found" (no registry.db) or
      // "No files have been ingested yet" (empty registry) are acceptable.
      expect(output).toMatch(/No ingest history|No files have been ingested yet/);
    });
  });

  // ─── ingest diff — edge cases ────────────────────────────────────────────────

  describe("ingest diff edge cases", () => {
    it("reports no new files for an empty source directory", async () => {
      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestDiffCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await program.parseAsync(["node", "test", "ingest", "diff"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      // Empty dir: no files are reported as added
      expect(output).not.toMatch(/added:.*\S/);
    });

    it("shows multiple new files as added", async () => {
      writeFileSync(join(sourceDir, "alpha.txt"), "Alpha content.");
      writeFileSync(join(sourceDir, "beta.txt"), "Beta content.");

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const program = new Command();
      program.exitOverride();
      const ingest = program.command("ingest");
      registerIngestDiffCommand(ingest);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await program.parseAsync(["node", "test", "ingest", "diff"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("alpha.txt");
      expect(output).toContain("beta.txt");
    });
  });

  // ─── search ──────────────────────────────────────────────────────────────

  describe("search", () => {
    it("returns results after ingestion", async () => {
      // Ingest a file first
      writeFileSync(
        join(sourceDir, "searchable.txt"),
        "The quick brown fox jumps over the lazy dog. This is a classic pangram for testing.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      // Run ingest
      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);

      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      // Close and reopen the db so search picks up the published data
      db.close();
      db = new AkiDB({
        storagePath: akidbRoot,
      });

      // Search
      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const searchLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await searchProgram.parseAsync([
        "node",
        "test",
        "search",
        "quick brown fox",
        "--top-k",
        "5",
      ]);

      const output = searchLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      searchLogSpy.mockRestore();

      expect(output).toContain("Search results for:");
      expect(output).toContain("chunk_id:");
      expect(output).toContain("score:");
    });

    it("prints message when --answer is used without LLM config", async () => {
      writeFileSync(
        join(sourceDir, "answer-test.txt"),
        "Some content for the answer flag test of the search command.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      // Run ingest
      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);

      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      db.close();
      db = new AkiDB({
        storagePath: akidbRoot,
      });

      // Search with --answer flag — expects an error + process.exit(1) when no LLM config
      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const searchErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
        throw new Error("process.exit");
      });

      await expect(
        searchProgram.parseAsync([
          "node",
          "test",
          "search",
          "answer flag test",
          "--answer",
        ]),
      ).rejects.toThrow("process.exit");

      const errOutput = searchErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      searchErrSpy.mockRestore();
      exitSpy.mockRestore();

      expect(errOutput).toContain("--answer requires an `llm` section");
    });

    it("shows result count in output header", async () => {
      writeFileSync(
        join(sourceDir, "count-test.txt"),
        "Content to count results for the search command header test.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      // Ingest
      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      // Search
      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await searchProgram.parseAsync(["node", "test", "search", "count test", "--top-k", "1"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Results:");
      expect(output).toContain("1");
      expect(output).toContain("Manifest version:");
    });

    it("supports keyword mode without embedding the query", async () => {
      writeFileSync(
        join(sourceDir, "keyword-test.txt"),
        "JWT expiry handling for access tokens and refresh tokens.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await searchProgram.parseAsync([
        "node",
        "test",
        "search",
        "JWT expiry",
        "--mode",
        "keyword",
        "--top-k",
        "3",
      ]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Search results for:");
      expect(output).toContain("source:");
    });

    it("prints explain details for hybrid search", async () => {
      writeFileSync(
        join(sourceDir, "hybrid-test.txt"),
        "Authentication token expiry policies and refresh token rotation.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await searchProgram.parseAsync([
        "node",
        "test",
        "search",
        "token expiry",
        "--mode",
        "hybrid",
        "--explain",
        "--top-k",
        "3",
      ]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("explain:");
      expect(output).toContain("chunk preview:");
    });

    it("supports JSON output for evaluation workflows", async () => {
      writeFileSync(
        join(sourceDir, "json-test.txt"),
        "Local retrieval quality test fixture for JSON output.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await searchProgram.parseAsync([
        "node",
        "test",
        "search",
        "retrieval quality",
        "--json",
        "--explain",
      ]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("\"query\"");
      expect(output).toContain("\"results\"");
      expect(output).toContain("\"explain\"");
    });

    it("exits with error for invalid --top-k value", async () => {
      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
        throw new Error("process.exit");
      });

      await expect(
        searchProgram.parseAsync(["node", "test", "search", "query", "--top-k", "0"]),
      ).rejects.toThrow("process.exit");

      const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      errSpy.mockRestore();
      exitSpy.mockRestore();

      expect(errOutput).toContain("top-k");
    });

    it("exits with error for non-numeric --top-k value", async () => {
      const searchProgram = new Command();
      searchProgram.exitOverride();
      registerSearchCommand(searchProgram);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
        throw new Error("process.exit");
      });

      await expect(
        searchProgram.parseAsync(["node", "test", "search", "query", "--top-k", "abc"]),
      ).rejects.toThrow("process.exit");

      errSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe("eval", () => {
    it("evaluates retrieval hit rates across vector, keyword, and hybrid modes", async () => {
      writeFileSync(
        join(sourceDir, "eval-target.txt"),
        "Authentication token expiry policies and refresh token rotation.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      const fixturePath = join(workDir, "eval-fixture.json");
      writeFileSync(
        fixturePath,
        JSON.stringify({
          cases: [
            {
              query: "token expiry",
              expected_sources: [join(sourceDir, "eval-target.txt")],
              top_k: 3,
            },
          ],
        }, null, 2),
        "utf-8",
      );

      const evalProgram = new Command();
      evalProgram.exitOverride();
      registerEvalCommand(evalProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await evalProgram.parseAsync(["node", "test", "eval", fixturePath]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Evaluation fixture:");
      expect(output).toContain("vector");
      expect(output).toContain("keyword");
      expect(output).toContain("hybrid");
      expect(output).toContain("hit@k=");
    });

    it("supports JSON output for evaluation automation", async () => {
      writeFileSync(
        join(sourceDir, "eval-json.txt"),
        "Local retrieval quality evaluation fixture for JSON automation.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      const fixturePath = join(workDir, "eval-fixture-json.json");
      writeFileSync(
        fixturePath,
        JSON.stringify({
          cases: [
            {
              query: "retrieval quality",
              expected_sources: [join(sourceDir, "eval-json.txt")],
            },
          ],
        }, null, 2),
        "utf-8",
      );

      const evalProgram = new Command();
      evalProgram.exitOverride();
      registerEvalCommand(evalProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await evalProgram.parseAsync(["node", "test", "eval", fixturePath, "--json"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("\"totals\"");
      expect(output).toContain("\"mode\": \"hybrid\"");
      expect(output).toContain("\"cases\"");
    });

    it("reports a miss when expected source is not in results", async () => {
      writeFileSync(
        join(sourceDir, "eval-miss.txt"),
        "This document is about solar panels and renewable energy.",
      );

      (mockConfig as { ingest: { sources: Array<{ path: string }> } }).ingest.sources = [
        { path: sourceDir },
      ];

      const runProgram = new Command();
      runProgram.exitOverride();
      const runIngest = runProgram.command("ingest");
      registerIngestRunCommand(runIngest);
      const runLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runProgram.parseAsync(["node", "test", "ingest", "run"]);
      runLogSpy.mockRestore();

      // Query that will not match "solar panels" in keyword or vector mode
      // — the expected source is a completely different non-existent file.
      const fixturePath = join(workDir, "eval-miss-fixture.json");
      writeFileSync(
        fixturePath,
        JSON.stringify({
          cases: [
            {
              query: "authentication token expiry",
              expected_sources: ["/nonexistent/path/that/will/never/match.txt"],
            },
          ],
        }, null, 2),
        "utf-8",
      );

      const evalProgram = new Command();
      evalProgram.exitOverride();
      registerEvalCommand(evalProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await evalProgram.parseAsync(["node", "test", "eval", fixturePath, "--json"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      const parsed = JSON.parse(output) as {
        totals: Array<{ mode: string; hitAtK: number; missAtK: number; hitRate: number }>;
      };
      for (const entry of parsed.totals) {
        expect(entry.missAtK).toBeGreaterThan(0);
        expect(entry.hitRate).toBe(0);
      }
    });
  });

  describe("memory", () => {
    it("stores, lists, and assembles memory records", async () => {
      const memoryProgram = new Command();
      memoryProgram.exitOverride();
      registerMemoryCommand(memoryProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "put",
        "--session",
        "session-1",
        "--text",
        "Remember the deployment window is Friday night.",
      ]);

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "put",
        "--session",
        "session-1",
        "--kind",
        "long-term",
        "--text",
        "Primary policy owner is the platform team.",
      ]);

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "list",
        "--session",
        "session-1",
      ]);

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "assemble",
        "--session",
        "session-1",
      ]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Stored memory");
      expect(output).toContain("deployment window");
      expect(output).toContain("platform team");
    });

    it("supports JSON output and deletion", async () => {
      const memoryProgram = new Command();
      memoryProgram.exitOverride();
      registerMemoryCommand(memoryProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "put",
        "--session",
        "session-2",
        "--text",
        "JSON memory record",
        "--json",
      ]);

      const putOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      const parsed = JSON.parse(putOutput) as { id: string };
      logSpy.mockClear();

      await memoryProgram.parseAsync([
        "node",
        "test",
        "memory",
        "delete",
        parsed.id,
      ]);

      const deleteOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(parsed.id).toBeTruthy();
      expect(deleteOutput).toContain("Deleted memory");
    });

    it("supports show, list --json, and assemble --json", async () => {
      const memoryProgram = new Command();
      memoryProgram.exitOverride();
      registerMemoryCommand(memoryProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Put two records
      await memoryProgram.parseAsync(["node", "test", "memory", "put", "--session", "session-3", "--text", "First context fact", "--json"]);
      const firstId = (JSON.parse(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")) as { id: string }).id;
      logSpy.mockClear();

      await memoryProgram.parseAsync(["node", "test", "memory", "put", "--session", "session-3", "--kind", "long-term", "--text", "Second long-term fact", "--json"]);
      logSpy.mockClear();

      // show
      await memoryProgram.parseAsync(["node", "test", "memory", "show", firstId, "--json"]);
      const showOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockClear();
      const showParsed = JSON.parse(showOutput) as { id: string; text: string };
      expect(showParsed.id).toBe(firstId);
      expect(showParsed.text).toBe("First context fact");

      // list --json
      await memoryProgram.parseAsync(["node", "test", "memory", "list", "--session", "session-3", "--json"]);
      const listOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockClear();
      const listParsed = JSON.parse(listOutput) as { records: Array<{ kind: string }> };
      expect(listParsed.records).toHaveLength(2);
      expect(listParsed.records.some((r) => r.kind === "long-term")).toBe(true);

      // assemble --json
      await memoryProgram.parseAsync(["node", "test", "memory", "assemble", "--session", "session-3", "--json"]);
      const assembleOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();
      const assembleParsed = JSON.parse(assembleOutput) as { text: string; entries: unknown[] };
      expect(assembleParsed.entries).toHaveLength(2);
      expect(assembleParsed.text).toContain("First context fact");
      expect(assembleParsed.text).toContain("Second long-term fact");
    });

    it("exits with error for invalid memory --limit values", async () => {
      const memoryProgram = new Command();
      memoryProgram.exitOverride();
      registerMemoryCommand(memoryProgram);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
        throw new Error("process.exit");
      });

      await expect(
        memoryProgram.parseAsync([
          "node",
          "test",
          "memory",
          "list",
          "--session",
          "session-4",
          "--limit",
          "abc",
        ]),
      ).rejects.toThrow("process.exit");

      const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      errSpy.mockRestore();
      exitSpy.mockRestore();

      expect(errOutput).toContain("--limit must be a positive integer");
    });
  });

  // ─── semantic store ───────────────────────────────────────────────────────

  describe("semantic store commands", () => {
    it("stores a bundle and lists it with status=pending", async () => {
      const sourceFile = join(sourceDir, "knowledge.txt");
      writeFileSync(
        sourceFile,
        "Semantic storage persists knowledge units durably for operator review and publication.",
        "utf-8",
      );
      const dbPath = join(dataRoot, "semantic.db");

      const semanticProgram = new Command();
      semanticProgram.exitOverride();
      registerSemanticCommand(semanticProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "store", sourceFile, "--db", dbPath,
      ]);
      await semanticProgram.parseAsync([
        "node", "test", "semantic", "bundles", "--db", dbPath,
      ]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("semantic.db");
      expect(output).toContain("status=pending");
    });

    it("approve-store persists approved review and show reflects it", async () => {
      const sourceFile = join(sourceDir, "policy.txt");
      writeFileSync(
        sourceFile,
        "Enterprise AI governance policies must be versioned, auditable, and reproducible across deployments.",
        "utf-8",
      );
      const dbPath = join(dataRoot, "semantic-approve.db");

      const semanticProgram = new Command();
      semanticProgram.exitOverride();
      registerSemanticCommand(semanticProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "store", sourceFile, "--db", dbPath,
      ]);

      const store = new SemanticStore(dbPath);
      const summaries = store.listBundles();
      const bundleId = summaries[0]!.bundleId;
      store.close();

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "approve-store", bundleId,
        "--reviewer", "test-reviewer",
        "--min-quality", "0.1",
        "--duplicate-policy", "warn",
        "--db", dbPath,
      ]);

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "show", bundleId, "--db", dbPath,
      ]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("approved");
      expect(output).toContain("test-reviewer");
    });

    it("publish pushes an approved bundle into AkiDB and marks it published", async () => {
      const sourceFile = join(sourceDir, "spec.txt");
      writeFileSync(
        sourceFile,
        "The publish workflow embeds semantic units and indexes them in AkiDB for retrieval serving.",
        "utf-8",
      );
      const dbPath = join(dataRoot, "semantic-publish.db");

      const semanticProgram = new Command();
      semanticProgram.exitOverride();
      registerSemanticCommand(semanticProgram);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "store", sourceFile, "--db", dbPath,
      ]);

      const store = new SemanticStore(dbPath);
      const summaries = store.listBundles();
      const bundleId = summaries[0]!.bundleId;
      store.close();

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "approve-store", bundleId,
        "--reviewer", "ci",
        "--min-quality", "0.1",
        "--duplicate-policy", "warn",
        "--db", dbPath,
      ]);

      await semanticProgram.parseAsync([
        "node", "test", "semantic", "publish", bundleId,
        "--db", dbPath,
        "--collection", "test-col-semantic",
      ]);

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(output).toContain("Published semantic bundle");
      expect(output).toContain("test-col-semantic");

      // verify publication state is persisted in the store
      const verifyStore = new SemanticStore(dbPath);
      const finalSummaries = verifyStore.listBundles();
      verifyStore.close();
      expect(finalSummaries[0]!.publishedCollectionId).toBe("test-col-semantic");
      expect(finalSummaries[0]!.publishedManifestVersion).toBeTypeOf("number");
    });
  });
});
