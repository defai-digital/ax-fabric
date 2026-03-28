import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider, SemanticBundle } from "@ax-fabric/contracts";

import type { FabricConfig } from "../cli/config-loader.js";

import type { SemanticStore } from "./semantic-store.js";
import {
  buildSemanticRecords,
  ensureSemanticCollection,
  semanticChunkIds,
  semanticPipelineSignature,
} from "./publish-support.js";

export type SemanticPublicationManifest = Awaited<ReturnType<AkiDB["publish"]>>;

export async function publishSemanticBundleToCollection(args: {
  bundleId: string;
  bundle: SemanticBundle;
  store: SemanticStore;
  db: AkiDB;
  config: FabricConfig;
  embedder: Pick<EmbedderProvider, "embed">;
  collectionId: string;
  replaceExisting: boolean;
  action?: "publish" | "republish" | "rollback";
  actor?: string;
}): Promise<SemanticPublicationManifest> {
  if (args.bundle.review?.status !== "approved") {
    throw new Error(`Semantic bundle "${args.bundleId}" is not approved`);
  }

  const existingPublication = args.store.findPublishedBundleForDoc(args.bundle.doc_id, args.collectionId);
  if ((args.action ?? "publish") === "rollback") {
    if (!existingPublication) {
      throw new Error(
        `Semantic collection "${args.collectionId}" has no active published bundle for doc_id "${args.bundle.doc_id}" to roll back`,
      );
    }
    if (existingPublication.bundleId === args.bundle.bundle_id) {
      throw new Error(
        `Semantic bundle "${args.bundleId}" is already the active published bundle for doc_id "${args.bundle.doc_id}"`,
      );
    }
  }
  if (existingPublication && existingPublication.bundleId !== args.bundle.bundle_id) {
    if (args.replaceExisting !== true) {
      throw new Error(
        `Semantic collection "${args.collectionId}" already has an active published bundle for doc_id "${args.bundle.doc_id}" `
        + `(${existingPublication.bundleId}). Publish into a different collection or rerun with replace enabled.`,
      );
    }

    const existingBundle = args.store.getBundle(existingPublication.bundleId);
    if (!existingBundle) {
      throw new Error(`Published semantic bundle "${existingPublication.bundleId}" not found in canonical store`);
    }
    revokeBundleChunks({
      bundle: existingBundle,
      collectionId: args.collectionId,
      db: args.db,
    });
  }

  ensureSemanticCollection(args.db, args.config, args.collectionId);
  const records = await buildSemanticRecords(args.bundle, args.config, args.embedder);
  await args.db.upsertBatch(args.collectionId, records);
  const manifest = await args.db.publish(args.collectionId, {
    embeddingModelId: args.config.embedder.model_id,
    pipelineSignature: semanticPipelineSignature(args.bundle),
  });

  args.store.markPublished(args.bundleId, {
    collectionId: args.collectionId,
    manifestVersion: manifest.version,
    publishedAt: new Date().toISOString(),
  });
  if (existingPublication && existingPublication.bundleId !== args.bundle.bundle_id) {
    args.store.clearPublished(existingPublication.bundleId);
  }

  args.store.logPublicationEvent({
    bundleId: args.bundleId,
    collectionId: args.collectionId,
    action: args.action ?? "publish",
    manifestVersion: manifest.version,
    replacedBundleId: existingPublication && existingPublication.bundleId !== args.bundle.bundle_id
      ? existingPublication.bundleId
      : null,
    actor: args.actor,
  });

  return manifest;
}

export async function unpublishSemanticBundleFromCollection(args: {
  bundleId: string;
  bundle: SemanticBundle;
  collectionId: string;
  store: SemanticStore;
  db: AkiDB;
  config: FabricConfig;
  actor?: string;
}): Promise<SemanticPublicationManifest | null> {
  const deleted = revokeBundleChunks({
    bundle: args.bundle,
    collectionId: args.collectionId,
    db: args.db,
  });
  if (!deleted) {
    args.store.clearPublished(args.bundleId);
    args.store.logPublicationEvent({
      bundleId: args.bundleId,
      collectionId: args.collectionId,
      action: "unpublish",
      actor: args.actor,
    });
    return null;
  }

  const manifest = await args.db.publish(args.collectionId, {
    embeddingModelId: args.config.embedder.model_id,
    pipelineSignature: semanticPipelineSignature(args.bundle),
  });
  args.store.clearPublished(args.bundleId);

  args.store.logPublicationEvent({
    bundleId: args.bundleId,
    collectionId: args.collectionId,
    action: "unpublish",
    manifestVersion: manifest.version,
    actor: args.actor,
  });

  return manifest;
}

function revokeBundleChunks(args: {
  bundle: SemanticBundle;
  collectionId: string;
  db: AkiDB;
}): boolean {
  const chunkIds = semanticChunkIds(args.bundle);
  if (chunkIds.length === 0) {
    return false;
  }
  args.db.deleteChunks(args.collectionId, chunkIds, "manual_revoke");
  return true;
}
