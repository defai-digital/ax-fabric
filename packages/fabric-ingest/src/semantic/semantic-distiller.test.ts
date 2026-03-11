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
      expect(result.units[0]!.themes?.length ?? 0).toBeGreaterThan(0);
      expect(result.units[0]!.quality_signals?.confidence).toBe(result.units[0]!.quality_score);
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

  it("prefers informative sentences in summaries and answers", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-summary-"));
    const filePath = join(workdir, "guide.txt");
    writeFileSync(
      filePath,
      [
        "Overview.",
        "AX Fabric provides grounded semantic retrieval for offline workflows.",
        "It preserves provenance and supports reviewable publication into retrieval.",
        "Thanks.",
      ].join(" "),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distiller.distillFile(filePath, {
        strategy: "fixed",
        chunkSize: 400,
        overlapRatio: 0,
      });

      expect(result.units).toHaveLength(1);
      expect(result.units[0]!.summary).toContain("AX Fabric provides grounded semantic retrieval");
      expect(result.units[0]!.answer).toContain("preserves provenance");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("normalizes list-style duplicates into the same duplicate group", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-list-dup-"));
    const filePath = join(workdir, "duplicate.txt");
    writeFileSync(
      filePath,
      [
        "# Release Checklist",
        "",
        "1. Semantic publication supports reviewable bundles and provenance.",
        "",
        "# Release Checklist",
        "",
        "2) Semantic publication supports reviewable bundles and provenance.",
      ].join("\n"),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distiller.distillFile(filePath, {
        strategy: "markdown",
      });

      const duplicates = result.units.filter((unit) => unit.duplicate_group_size !== undefined);
      expect(duplicates.length).toBeGreaterThan(0);
      expect(new Set(duplicates.map((unit) => unit.duplicate_group_id)).size).toBe(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("penalizes noisy repeated text in quality scoring", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-noise-"));
    const cleanPath = join(workdir, "clean.txt");
    const noisyPath = join(workdir, "noisy.txt");
    writeFileSync(
      cleanPath,
      "AX Fabric preserves provenance, supports reviewable semantic workflows, and improves grounded retrieval quality.",
      "utf8",
    );
    writeFileSync(
      noisyPath,
      [
        "WARNING WARNING WARNING !!! 12345 67890",
        "WARNING WARNING WARNING !!! 12345 67890",
      ].join("\n"),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const clean = await distiller.distillFile(cleanPath, {
        strategy: "fixed",
        chunkSize: 300,
        overlapRatio: 0,
      });
      const noisy = await distiller.distillFile(noisyPath, {
        strategy: "fixed",
        chunkSize: 300,
        overlapRatio: 0,
      });

      expect(clean.units[0]!.quality_score).toBeGreaterThan(noisy.units[0]!.quality_score);
      expect(noisy.units[0]!.quality_signals?.flags).toContain("repeated_lines");
      expect(noisy.units[0]!.quality_signals?.flags).toContain("noisy_content");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("emits themes and structured quality signals for retrieval and review", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-distill-metadata-"));
    const filePath = join(workdir, "workflow.md");
    writeFileSync(
      filePath,
      [
        "# Publication Workflow",
        "",
        "AX Fabric semantic publication supports review approval, replacement publishing, and provenance-aware retrieval.",
        "Semantic workflow diagnostics help operators judge quality and noise before publication.",
      ].join("\n"),
      "utf8",
    );

    try {
      const distiller = new SemanticDistiller();
      const result = await distillFileWithSingleChunk(distiller, filePath);

      expect(result.units[0]!.themes).toContain("publication workflow");
      expect(result.units[0]!.quality_signals).toMatchObject({
        coverage: expect.any(Number),
        density: expect.any(Number),
        structure: expect.any(Number),
        noise_penalty: expect.any(Number),
        confidence: expect.any(Number),
      });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

async function distillFileWithSingleChunk(
  distiller: SemanticDistiller,
  filePath: string,
) {
  return distiller.distillFile(filePath, {
    strategy: "markdown",
    chunkSize: 400,
    overlapRatio: 0,
  });
}
