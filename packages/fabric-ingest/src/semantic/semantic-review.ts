import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  SemanticBundle,
  SemanticBundleDiagnostics,
  SemanticDuplicateGroup,
  SemanticReviewDecision,
  SemanticReviewStatus,
} from "@ax-fabric/contracts";
import {
  SemanticBundleSchema,
  SemanticReviewDecisionSchema,
} from "@ax-fabric/contracts";

import type {
  SemanticDistillOptions,
  SemanticDistillResult,
} from "./semantic-distiller.js";
import { SemanticDistiller } from "./semantic-distiller.js";

export interface SemanticReviewOptions {
  lowQualityThreshold?: number;
}

export interface SemanticApprovalOptions extends SemanticReviewOptions {
  reviewer: string;
  minQualityScore?: number;
  duplicatePolicy?: "warn" | "reject";
  notes?: string;
}

const DEFAULT_LOW_QUALITY_THRESHOLD = 0.6;
const DEFAULT_APPROVAL_THRESHOLD = 0.7;

export class SemanticReviewEngine {
  private readonly distiller: SemanticDistiller;

  constructor(distiller = new SemanticDistiller()) {
    this.distiller = distiller;
  }

  async createBundle(
    filePath: string,
    options?: SemanticDistillOptions & SemanticReviewOptions,
  ): Promise<SemanticBundle> {
    const result = await this.distiller.distillFile(filePath, options);
    return this.bundleFromDistillResult(result, options);
  }

  bundleFromDistillResult(
    result: SemanticDistillResult,
    options?: SemanticReviewOptions,
  ): SemanticBundle {
    const diagnostics = this.computeDiagnostics(
      result.units,
      options?.lowQualityThreshold ?? DEFAULT_LOW_QUALITY_THRESHOLD,
    );

    return SemanticBundleSchema.parse({
      bundle_id: digest(`${result.docId}:${result.docVersion}:${result.sourcePath}`),
      source_path: result.sourcePath,
      doc_id: result.docId,
      doc_version: result.docVersion,
      content_type: result.contentType,
      distill_strategy: result.distillStrategy,
      generated_at: new Date().toISOString(),
      units: result.units,
      diagnostics,
      review: undefined,
    });
  }

  inspectBundle(bundle: SemanticBundle): SemanticBundleDiagnostics {
    return bundle.diagnostics;
  }

  approveBundle(
    bundle: SemanticBundle,
    options: SemanticApprovalOptions,
  ): SemanticBundle {
    const minQualityScore = options.minQualityScore ?? DEFAULT_APPROVAL_THRESHOLD;
    const diagnostics = this.computeDiagnostics(
      bundle.units,
      options.lowQualityThreshold ?? DEFAULT_LOW_QUALITY_THRESHOLD,
    );
    const duplicatePolicy = options.duplicatePolicy ?? "reject";
    const blockingIssues: string[] = [];

    if (bundle.units.some((unit) => unit.quality_score < minQualityScore)) {
      blockingIssues.push(
        `Found semantic units below the minimum approval quality score of ${minQualityScore.toFixed(2)}`,
      );
    }

    if (duplicatePolicy === "reject" && diagnostics.duplicate_groups.length > 0) {
      blockingIssues.push("Duplicate semantic groups must be reviewed before approval");
    }

    const status: SemanticReviewStatus = blockingIssues.length > 0 ? "rejected" : "approved";
    const review = SemanticReviewDecisionSchema.parse({
      status,
      reviewer: options.reviewer,
      reviewed_at: new Date().toISOString(),
      min_quality_score: minQualityScore,
      duplicate_policy: duplicatePolicy,
      blocking_issues: blockingIssues,
      notes: options.notes,
    } satisfies SemanticReviewDecision);

    return SemanticBundleSchema.parse({
      ...bundle,
      diagnostics,
      review,
    });
  }

  loadBundle(bundlePath: string): SemanticBundle {
    const parsed = JSON.parse(readFileSync(bundlePath, "utf8")) as unknown;
    return SemanticBundleSchema.parse(parsed);
  }

  exportBundle(bundle: SemanticBundle, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }

  private computeDiagnostics(
    units: SemanticBundle["units"],
    lowQualityThreshold: number,
  ): SemanticBundleDiagnostics {
    const duplicateGroups = new Map<string, SemanticDuplicateGroup>();
    const lowQualityUnitIds: string[] = [];

    for (const unit of units) {
      if (unit.quality_score < lowQualityThreshold) {
        lowQualityUnitIds.push(unit.unit_id);
      }
      if (unit.duplicate_group_id && unit.duplicate_group_size && unit.duplicate_group_size > 1) {
        const current = duplicateGroups.get(unit.duplicate_group_id);
        if (current) {
          current.unit_ids.push(unit.unit_id);
        } else {
          duplicateGroups.set(unit.duplicate_group_id, {
            group_id: unit.duplicate_group_id,
            size: unit.duplicate_group_size,
            unit_ids: [unit.unit_id],
          });
        }
      }
    }

    const flagged = new Set<string>(lowQualityUnitIds);
    for (const group of duplicateGroups.values()) {
      for (const unitId of group.unit_ids) {
        flagged.add(unitId);
      }
    }

    const averageQualityScore = units.length > 0
      ? units.reduce((sum, unit) => sum + unit.quality_score, 0) / units.length
      : 0;

    return {
      total_units: units.length,
      average_quality_score: Number(averageQualityScore.toFixed(3)),
      low_quality_unit_ids: lowQualityUnitIds,
      flagged_unit_ids: Array.from(flagged),
      duplicate_groups: Array.from(duplicateGroups.values()).sort((a, b) => b.size - a.size),
    };
  }
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
