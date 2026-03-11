import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SemanticDistiller } from "./semantic-distiller.js";

describe("SemanticDistiller", () => {
  it("generates semantic units with grounded provenance", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-"));
    const filePath = join(workdir, "guide.md");
    writeFileSync(
      filePath,
      [
        "# Semantic Distillation",
        "",
        "Semantic distillation turns extracted source text into reviewable semantic units.",
        "It preserves provenance and keeps retrieval grounded in the original material.",
        "",
        "## Provenance",
        "",
        "Every semantic unit should reference exact source spans and source metadata.",
      ].join("\n"),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distiller.distillFile(filePath, {
        strategy: "markdown",
      });

      expect(result.units.length).toBeGreaterThan(0);
      expect(result.units[0]!.distill_strategy).toBe("extractive-v1");
      expect(result.units[0]!.source_spans[0]!.source_uri).toBe(filePath);
      expect(result.units[0]!.source_spans[0]!.offset_end).toBeGreaterThan(
        result.units[0]!.source_spans[0]!.offset_start,
      );
      expect(result.units[0]!.question).toContain("What is the key point");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("marks exact duplicate semantic units with a duplicate group", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-dup-"));
    const filePath = join(workdir, "duplicate.txt");
    writeFileSync(
      filePath,
      [
        "Release Overview",
        "",
        "Semantic distillation preserves provenance and exportable semantic units.",
        "",
        "Release Overview",
        "",
        "Semantic distillation preserves provenance and exportable semantic units.",
      ].join("\n"),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distiller.distillFile(filePath, {
        strategy: "fixed",
        chunkSize: 110,
        overlapRatio: 0,
      });

      const duplicates = result.units.filter((unit) => unit.duplicate_group_size !== undefined);
      expect(duplicates.length).toBeGreaterThan(0);
      expect(duplicates[0]!.duplicate_group_size).toBeGreaterThan(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("exports semantic units as JSON", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-export-"));
    const sourcePath = join(workdir, "note.txt");
    const outputPath = join(workdir, "out", "semantic.json");
    writeFileSync(
      sourcePath,
      "AX Fabric semantic distillation keeps semantic artifacts grounded in source text.",
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distiller.distillFile(sourcePath);
      distiller.exportToFile(result, outputPath);

      const exported = JSON.parse(readFileSync(outputPath, "utf8")) as { units: Array<{ unit_id: string }> };
      expect(exported.units.length).toBeGreaterThan(0);
      expect(exported.units[0]!.unit_id).toBeTruthy();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
