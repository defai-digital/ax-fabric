import { z } from "zod";

export const ChunkLabelSchema = z.enum([
  "paragraph",
  "heading",
  "table",
  "code",
  "list",
  "text",
]);

export type ChunkLabel = z.infer<typeof ChunkLabelSchema>;

export const RecordMetadataSchema = z.object({
  source_uri: z.string(),
  content_type: z.enum([
    "txt",
    "md",
    "pdf",
    "docx",
    "pptx",
    "xlsx",
    "csv",
    "tsv",
    "json",
    "jsonl",
    "yaml",
    "html",
    "rtf",
    "sql",
    "log",
  ]),
  page_range: z.string().nullable(),
  offset: z.number().int().nonnegative(),
  table_ref: z.string().nullable(),
  chunk_label: ChunkLabelSchema.optional(),
  created_at: z.string().datetime(),
});

export type RecordMetadata = z.infer<typeof RecordMetadataSchema>;

export const RecordSchema = z.object({
  chunk_id: z.string().min(1),
  doc_id: z.string().min(1),
  doc_version: z.string().min(1),
  chunk_hash: z.string().min(1),
  pipeline_signature: z.string().min(1),
  embedding_model_id: z.string().min(1),
  vector: z.array(z.number()),
  metadata: RecordMetadataSchema,
  chunk_text: z.string().optional(),
});

export type Record = z.infer<typeof RecordSchema>;
