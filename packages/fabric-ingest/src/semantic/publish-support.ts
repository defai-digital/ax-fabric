import { createHash } from "node:crypto";

import type { EmbedderProvider, Record as AkiRecord, SemanticBundle } from "@ax-fabric/contracts";
import type { AkiDB } from "@ax-fabric/akidb";

import type { FabricConfig } from "../cli/config-loader.js";

export function ensureSemanticCollection(db: AkiDB, config: FabricConfig, collectionId: string): void {
  try {
    db.getCollection(collectionId);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("not found"))) {
      throw error;
    }
    db.createCollection({
      collectionId,
      dimension: config.akidb.dimension,
      metric: config.akidb.metric,
      embeddingModelId: config.embedder.model_id,
    });
  }
}

export async function buildSemanticRecords(
  bundle: SemanticBundle,
  config: FabricConfig,
  embedder: Pick<EmbedderProvider, "embed">,
): Promise<AkiRecord[]> {
  const texts = bundle.units.map((unit) => semanticUnitText(unit));
  const vectors = await embedder.embed(texts);
  const createdAt = new Date().toISOString();

  return bundle.units.map((unit, index) => {
    const text = texts[index]!;
    const vector = vectors[index]!;
    const span = unit.source_spans[0]!;
    return {
      chunk_id: `semantic:${unit.unit_id}`,
      doc_id: bundle.doc_id,
      doc_version: bundle.doc_version,
      chunk_hash: digest(text),
      pipeline_signature: semanticPipelineSignature(bundle),
      embedding_model_id: config.embedder.model_id,
      vector,
      metadata: {
        source_uri: span.source_uri,
        content_type: span.content_type,
        page_range: span.page_range,
        offset: span.offset_start,
        table_ref: span.table_ref,
        chunk_label: span.chunk_label,
        created_at: createdAt,
      },
      chunk_text: text,
    };
  });
}

export function semanticChunkIds(bundle: SemanticBundle): string[] {
  return bundle.units.map((unit) => `semantic:${unit.unit_id}`);
}

export function semanticPipelineSignature(bundle: SemanticBundle): string {
  return `semantic-store:${bundle.distill_strategy}:${bundle.review?.status ?? "pending"}`;
}

function semanticUnitText(unit: SemanticBundle["units"][number]): string {
  return `${unit.title}\n\n${unit.summary}\n\n${unit.answer}`;
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
