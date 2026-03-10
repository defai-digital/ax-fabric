import { z } from "zod";

/**
 * Pipeline signature tracks the exact version of each pipeline stage.
 * pipeline_signature = hash(extractor_version + normalize_version + chunker_version)
 */
export const PipelineVersionsSchema = z.object({
  extractor_version: z.string().min(1),
  normalize_version: z.string().min(1),
  chunker_version: z.string().min(1),
});

export type PipelineVersions = z.infer<typeof PipelineVersionsSchema>;
