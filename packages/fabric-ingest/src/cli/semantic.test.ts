import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerSemanticCommand } from "./semantic.js";

let mockConfigPath = "";
let mockConfig: Record<string, unknown> = {};

vi.mock("./config-loader.js", () => ({
  resolveConfigPath: () => mockConfigPath,
  loadConfig: () => mockConfig,
}));

describe("semantic CLI", () => {
  beforeEach(() => {
    mockConfigPath = "/tmp/test-config.yaml";
    mockConfig = {
      ingest: {
        chunking: {
          chunk_size: 512,
          overlap: 0.15,
          strategy: "auto",
        },
      },
    };
  });

  function makeProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerSemanticCommand(program);
    return program;
  }

  it("prints preview output", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-preview-"));
    const filePath = join(workdir, "guide.md");
    writeFileSync(
      filePath,
      "# Preview\n\nSemantic distillation previews semantic units with source provenance.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "preview", filePath, "--limit", "1"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Semantic preview:");
      expect(output).toContain("question:");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("exports semantic units to a JSON file", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-export-"));
    const filePath = join(workdir, "guide.txt");
    const outputPath = join(workdir, "semantic", "units.json");
    writeFileSync(
      filePath,
      "Semantic export writes grounded semantic units to disk for downstream workflows.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "export", filePath, "--output", outputPath]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Exported");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
