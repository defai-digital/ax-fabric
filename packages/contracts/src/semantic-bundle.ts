import { z } from "zod";

import {
  SemanticDistillStrategySchema,
  SemanticUnitSchema,
} from "./semantic-unit.js";
import { RecordMetadataSchema } from "./record.js";

export const SemanticDuplicateGroupSchema = z.object({
  group_id: z.string().min(1),
  size: z.number().int().positive(),
  unit_ids: z.array(z.string().min(1)).min(2),
});

export type SemanticDuplicateGroup = z.infer<typeof SemanticDuplicateGroupSchema>;

export const SemanticBundleDiagnosticsSchema = z.object({
  total_units: z.number().int().nonnegative(),
  average_quality_score: z.number().min(0).max(1),
  low_quality_unit_ids: z.array(z.string().min(1)),
  flagged_unit_ids: z.array(z.string().min(1)),
  duplicate_groups: z.array(SemanticDuplicateGroupSchema),
});

export type SemanticBundleDiagnostics = z.infer<typeof SemanticBundleDiagnosticsSchema>;

export const SemanticReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

export type SemanticReviewStatus = z.infer<typeof SemanticReviewStatusSchema>;

export const SemanticReviewDecisionSchema = z.object({
  status: SemanticReviewStatusSchema,
  reviewer: z.string().min(1),
  reviewed_at: z.string().datetime(),
  min_quality_score: z.number().min(0).max(1),
  duplicate_policy: z.enum(["warn", "reject"]),
  blocking_issues: z.array(z.string().min(1)),
  notes: z.string().optional(),
});

export type SemanticReviewDecision = z.infer<typeof SemanticReviewDecisionSchema>;

export const SemanticBundleSchema = z.object({
  bundle_id: z.string().min(1),
  source_path: z.string().min(1),
  doc_id: z.string().min(1),
  doc_version: z.string().min(1),
  content_type: RecordMetadataSchema.shape.content_type,
  distill_strategy: SemanticDistillStrategySchema,
  generated_at: z.string().datetime(),
  units: z.array(SemanticUnitSchema),
  diagnostics: SemanticBundleDiagnosticsSchema,
  review: SemanticReviewDecisionSchema.optional(),
});

export type SemanticBundle = z.infer<typeof SemanticBundleSchema>;
