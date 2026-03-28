/**
 * Semantic publication CLI commands — publish, unpublish, republish, rollback.
 *
 * Extracted from semantic.ts as part of v3.1 CLI modularization (C-1).
 */

import type { Command } from "commander";

import {
  publishSemanticBundleToCollection,
  unpublishSemanticBundleFromCollection,
} from "../semantic/publication-service.js";

import { createEmbedderFromConfig } from "./create-embedder.js";
import { loadFabricRuntime, openRuntimeAkiDb, openRuntimeSemanticStore } from "./runtime.js";

export function registerSemanticPublishCommands(semantic: Command): void {
  semantic
    .command("publish <bundleId>")
    .description("Publish an approved stored semantic bundle into AkiDB")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--actor <name>", "Actor identity to attach to the publication audit trail")
    .option("--collection <id>", "Target AkiDB collection (default: <config.collection>-semantic)")
    .option("--replace", "Replace the currently published bundle for the same doc and collection")
    .action(async (bundleId: string, opts: PublishOptions) => {
      const runtime = loadFabricRuntime();
      const { config } = runtime;
      const store = openRuntimeSemanticStore(runtime, opts.db);
      const embedder = createEmbedderFromConfig(config);
      const db = openRuntimeAkiDb(runtime);

      try {
        const bundle = store.getBundle(bundleId);
        if (!bundle) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        const collectionId = opts.collection ?? runtime.collections.semantic;
        const manifest = await publishSemanticBundleToCollection({
          bundle,
          bundleId,
          store,
          db,
          config,
          embedder,
          collectionId,
          replaceExisting: opts.replace === true,
          action: "publish",
          actor: resolvePublicationActor(opts.actor),
        });
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: bundleId,
            collection_id: collectionId,
            manifest_version: manifest.version,
            action: "publish",
          }, null, 2));
          return;
        }
        console.log(`Published semantic bundle ${bundleId} to ${collectionId} manifest=${String(manifest.version)}`);
      } finally {
        db.close();
        await embedder.close?.();
        store.close();
      }
    });

  semantic
    .command("unpublish <bundleId>")
    .description("Remove a published semantic bundle from its AkiDB collection and clear publication state")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--actor <name>", "Actor identity to attach to the publication audit trail")
    .action(async (bundleId: string, opts: UnpublishOptions) => {
      const runtime = loadFabricRuntime();
      const store = openRuntimeSemanticStore(runtime, opts.db);
      const db = openRuntimeAkiDb(runtime);

      try {
        const stored = store.getStoredBundle(bundleId);
        if (!stored) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        if (!stored.publication) {
          throw new Error(`Semantic bundle "${bundleId}" is not currently published`);
        }
        const collectionId = stored.publication.collectionId;
        const manifest = await unpublishSemanticBundleFromCollection({
          bundleId,
          bundle: stored.bundle,
          collectionId,
          store,
          db,
          config: runtime.config,
          actor: resolvePublicationActor(opts.actor),
        });
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: bundleId,
            collection_id: collectionId,
            manifest_version: manifest?.version ?? null,
            action: "unpublish",
          }, null, 2));
          return;
        }
        if (manifest) {
          console.log(
            `Unpublished semantic bundle ${bundleId} from ${collectionId} `
            + `manifest=${String(manifest.version)}`,
          );
        } else {
          console.log(`Cleared publication state for semantic bundle ${bundleId}`);
        }
      } finally {
        db.close();
        store.close();
      }
    });

  semantic
    .command("republish <bundleId>")
    .description("Republish an already published semantic bundle into its current AkiDB collection")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--actor <name>", "Actor identity to attach to the publication audit trail")
    .action(async (bundleId: string, opts: UnpublishOptions) => {
      const runtime = loadFabricRuntime();
      const { config } = runtime;
      const store = openRuntimeSemanticStore(runtime, opts.db);
      const embedder = createEmbedderFromConfig(config);
      const db = openRuntimeAkiDb(runtime);

      try {
        const stored = store.getStoredBundle(bundleId);
        if (!stored) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        if (!stored.publication) {
          throw new Error(`Semantic bundle "${bundleId}" is not currently published`);
        }
        const collectionId = stored.publication.collectionId;
        const manifest = await publishSemanticBundleToCollection({
          bundle: stored.bundle,
          bundleId,
          store,
          db,
          config,
          embedder,
          collectionId,
          replaceExisting: true,
          action: "republish",
          actor: resolvePublicationActor(opts.actor),
        });
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: bundleId,
            collection_id: collectionId,
            manifest_version: manifest.version,
            action: "republish",
          }, null, 2));
          return;
        }
        console.log(`Republished semantic bundle ${bundleId} to ${collectionId} manifest=${String(manifest.version)}`);
      } finally {
        db.close();
        await embedder.close?.();
        store.close();
      }
    });

  semantic
    .command("rollback <bundleId>")
    .description("Rollback the active published semantic bundle for the same document to a specific approved bundle")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--actor <name>", "Actor identity to attach to the publication audit trail")
    .option("--collection <id>", "Target AkiDB collection (default: <config.collection>-semantic)")
    .action(async (bundleId: string, opts: PublishOptions) => {
      const runtime = loadFabricRuntime();
      const { config } = runtime;
      const store = openRuntimeSemanticStore(runtime, opts.db);
      const embedder = createEmbedderFromConfig(config);
      const db = openRuntimeAkiDb(runtime);

      try {
        const bundle = store.getBundle(bundleId);
        if (!bundle) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        const collectionId = opts.collection ?? runtime.collections.semantic;
        const manifest = await publishSemanticBundleToCollection({
          bundle,
          bundleId,
          store,
          db,
          config,
          embedder,
          collectionId,
          replaceExisting: true,
          action: "rollback",
          actor: resolvePublicationActor(opts.actor),
        });
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: bundleId,
            collection_id: collectionId,
            manifest_version: manifest.version,
            action: "rollback",
          }, null, 2));
          return;
        }
        console.log(`Rolled back semantic bundle ${bundleId} into ${collectionId} manifest=${String(manifest.version)}`);
      } finally {
        db.close();
        await embedder.close?.();
        store.close();
      }
    });
}

interface PublishOptions {
  db?: string;
  json?: boolean;
  actor?: string;
  collection?: string;
  replace?: boolean;
}

interface UnpublishOptions {
  db?: string;
  json?: boolean;
  actor?: string;
}

function resolvePublicationActor(actor?: string): string {
  if (actor && actor.trim().length > 0) {
    return actor.trim();
  }
  const user = process.env["USER"] ?? process.env["USERNAME"];
  return user && user.trim().length > 0 ? `cli:${user.trim()}` : "cli";
}
