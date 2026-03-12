import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerBenchmarkCommand } from "./benchmark.js";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerBenchmarkCommand(program);
  return program;
}

describe("benchmark CLI", () => {
  it("runs the search benchmark and prints JSON output", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync([
        "node",
        "test",
        "benchmark",
        "search",
        "--docs",
        "8",
        "--runs",
        "2",
        "--warmup",
        "1",
        "--top-k",
        "3",
        "--mode",
        "hybrid",
        "--json",
      ]);

      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      const parsed = JSON.parse(String(output)) as {
        benchmark: string;
        corpusDocs: number;
        latency: { runs: number };
      };
      expect(parsed.benchmark).toBe("search");
      expect(parsed.corpusDocs).toBe(8);
      expect(parsed.latency.runs).toBe(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("runs the semantic publish benchmark and prints JSON output", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync([
        "node",
        "test",
        "benchmark",
        "semantic-publish",
        "--sections",
        "6",
        "--json",
      ]);

      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      const parsed = JSON.parse(String(output)) as {
        benchmark: string;
        sections: number;
        units: number;
      };
      expect(parsed.benchmark).toBe("semantic-publish");
      expect(parsed.sections).toBe(6);
      expect(parsed.units).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("runs the eval benchmark and prints JSON output", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync([
        "node",
        "test",
        "benchmark",
        "eval",
        "--docs",
        "12",
        "--cases",
        "4",
        "--top-k",
        "3",
        "--compare-semantic",
        "--json",
      ]);

      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      const parsed = JSON.parse(String(output)) as {
        benchmark: string;
        corpusDocs: number;
        cases: number;
        compareSemantic: boolean;
        passes: {
          raw?: unknown;
          semantic?: unknown;
          compare?: { delta?: Record<string, unknown> };
        };
        delta?: Record<string, unknown> | null;
      };
      expect(parsed.benchmark).toBe("eval");
      expect(parsed.corpusDocs).toBe(12);
      expect(parsed.cases).toBe(4);
      expect(parsed.compareSemantic).toBe(true);
      expect(parsed.passes).toHaveProperty("raw");
      expect(parsed.passes).toHaveProperty("semantic");
      expect(parsed.passes).toHaveProperty("compare");
      expect(parsed.passes.compare?.delta).toHaveProperty("hybrid");
      expect(parsed.delta).toHaveProperty("hybrid");
    } finally {
      logSpy.mockRestore();
    }
  });
});
