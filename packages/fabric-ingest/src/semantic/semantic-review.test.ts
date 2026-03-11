import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SemanticReviewEngine } from "./semantic-review.js";

describe("SemanticReviewEngine", () => {
  it("creates bundles with diagnostics", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-review-"));
    const filePath = join(workdir, "guide.md");
    writeFileSync(
      filePath,
      "# Review\n\nSemantic review should surface diagnostics and grounded provenance for approval workflows.",
      "utf8",
    );

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath, { strategy: "markdown" });

      expect(bundle.bundle_id).toBeTruthy();
      expect(bundle.diagnostics.total_units).toBeGreaterThan(0);
      expect(bundle.review).toBeUndefined();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("rejects bundles with blocking duplicate issues by default", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-review-dup-"));
    const filePath = join(workdir, "dup.txt");
    writeFileSync(
      filePath,
      "Semantic approval requires review of duplicate semantic material before publication.",
      "utf8",
    );

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const baseUnit = bundle.units[0]!;
      const duplicateId = "dup-group-1";
      bundle.units = [
        {
          ...baseUnit,
          duplicate_group_id: duplicateId,
          duplicate_group_size: 2,
        },
        {
          ...baseUnit,
          unit_id: `${baseUnit.unit_id}-copy`,
          duplicate_group_id: duplicateId,
          duplicate_group_size: 2,
        },
      ];
      const reviewed = engine.approveBundle(bundle, {
        reviewer: "akira",
      });

      expect(reviewed.review?.status).toBe("rejected");
      expect(reviewed.review?.blocking_issues[0]).toContain("Duplicate semantic groups");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("approves bundles when diagnostics satisfy the approval policy", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-review-approve-"));
    const filePath = join(workdir, "clean.txt");
    writeFileSync(
      filePath,
      "Semantic approval allows clean bundles with grounded, non-duplicate semantic units and acceptable quality scores.",
      "utf8",
    );

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const reviewed = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.5,
        duplicatePolicy: "warn",
      });

      expect(reviewed.review?.status).toBe("approved");
      expect(reviewed.review?.blocking_issues).toEqual([]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("rejects units below the approval threshold even when diagnostics use a lower review threshold", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-review-threshold-"));
    const filePath = join(workdir, "threshold.txt");
    writeFileSync(
      filePath,
      "Semantic approval should reject units that fall below the explicit approval threshold.",
      "utf8",
    );

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      bundle.units = bundle.units.map((unit) => ({ ...unit, quality_score: 0.65 }));

      const reviewed = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.7,
        lowQualityThreshold: 0.6,
        duplicatePolicy: "warn",
      });

      expect(reviewed.review?.status).toBe("rejected");
      expect(reviewed.review?.blocking_issues[0]).toContain("minimum approval quality score");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
