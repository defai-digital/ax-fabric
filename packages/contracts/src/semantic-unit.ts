import { z } from "zod";

import { ChunkLabelSchema, RecordMetadataSchema } from "./record.js";

export const SemanticDistillStrategySchema = z.enum([
  "extractive-v1",
]);

export type SemanticDistillStrategy = z.infer<typeof SemanticDistillStrategySchema>;

export const SemanticSourceSpanSchema = z.object({
  source_uri: z.string(),
  content_type: RecordMetadataSchema.shape.content_type,
  page_range: z.string().nullable(),
  table_ref: z.string().nullable(),
  offset_start: z.number().int().nonnegative(),
  offset_end: z.number().int().nonnegative(),
  chunk_id: z.string().min(1),
  chunk_hash: z.string().min(1),
  chunk_label: ChunkLabelSchema,
});

export type SemanticSourceSpan = z.infer<typeof SemanticSourceSpanSchema>;

export const SemanticUnitSchema = z.object({
  unit_id: z.string().min(1),
  doc_id: z.string().min(1),
  doc_version: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  summary: z.string().min(1),
  answer: z.string().min(1),
  keywords: z.array(z.string().min(1)).max(12),
  entities: z.array(z.string().min(1)).max(12),
  quality_score: z.number().min(0).max(1),
  distill_strategy: SemanticDistillStrategySchema,
  duplicate_group_id: z.string().min(1).optional(),
  duplicate_group_size: z.number().int().positive().optional(),
  source_spans: z.array(SemanticSourceSpanSchema).min(1),
});

export type SemanticUnit = z.infer<typeof SemanticUnitSchema>;
