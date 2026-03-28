/**
 * Semantic store CLI commands — store, bundles, show, approve-store.
 *
 * Extracted from semantic.ts as part of v3.1 CLI modularization (C-2).
 */

import { resolve } from "node:path";

import type { Command } from "commander";

import { SemanticReviewEngine } from "../semantic/index.js";
import { DEFAULT_LOW_QUALITY_THRESHOLD } from "../constants.js";

import { loadFabricRuntime, openRuntimeSemanticStore } from "./runtime.js";
import {
  createBundleFromCli,
  parseDuplicatePolicy,
  parseUnitInterval,
  printBundleDiagnostics,
} from "./semantic-helpers.js";

export function registerSemanticStoreCommands(semantic: Command): void {
  semantic
    .command("store <file>")
    .description("Create a semantic bundle from a file and store it in the canonical SQLite store")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .option("--low-quality-threshold <number>", "Flag units below this quality score", String(DEFAULT_LOW_QUALITY_THRESHOLD))
    .action(async (file: string, opts: StoredBundleOptions) => {
      const bundle = await createBundleFromCli(file, opts);
      const runtime = loadFabricRuntime();
      const store = openRuntimeSemanticStore(runtime, opts.db);
      try {
        store.upsertBundle(bundle);
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: bundle.bundle_id,
            source_path: bundle.source_path,
            total_units: bundle.diagnostics.total_units,
            average_quality_score: bundle.diagnostics.average_quality_score,
            review_status: bundle.review?.status ?? "pending",
          }, null, 2));
          return;
        }
        const dbPath = opts.db ? resolve(opts.db) : runtime.paths.semanticDbPath;
        console.log(`Stored semantic bundle ${bundle.bundle_id} in ${dbPath}`);
      } finally {
        store.close();
      }
    });

  semantic
    .command("bundles")
    .description("List semantic bundles stored in the canonical SQLite store")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .action((opts: StoreInspectOptions) => {
      const store = openRuntimeSemanticStore(loadFabricRuntime(), opts.db);
      try {
        const summaries = store.listBundles();
        if (opts.json) {
          console.log(JSON.stringify(summaries, null, 2));
          return;
        }
        for (const summary of summaries) {
          console.log(
            `${summary.bundleId} status=${summary.reviewStatus} units=${String(summary.totalUnits)} `
            + `avg_quality=${summary.averageQualityScore.toFixed(3)} published=${summary.publishedCollectionId ?? "no"}`,
          );
        }
      } finally {
        store.close();
      }
    });

  semantic
    .command("show <bundleId>")
    .description("Show a stored semantic bundle from the canonical SQLite store")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .action((bundleId: string, opts: StoreInspectOptions) => {
      const store = openRuntimeSemanticStore(loadFabricRuntime(), opts.db);
      try {
        const stored = store.getStoredBundle(bundleId);
        if (!stored) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        if (opts.json) {
          console.log(JSON.stringify(stored, null, 2));
          return;
        }
        const bundle = stored.bundle;
        printBundleDiagnostics(bundle);
        if (bundle.review) {
          console.log(`  Review status:    ${bundle.review.status}`);
          console.log(`  Reviewer:         ${bundle.review.reviewer}`);
        }
        console.log(`  Published:        ${stored.publication ? "yes" : "no"}`);
        if (stored.publication) {
          console.log(`  Collection:       ${stored.publication.collectionId}`);
          console.log(`  Manifest version: ${String(stored.publication.manifestVersion)}`);
          console.log(`  Published at:     ${stored.publication.publishedAt}`);
        }
      } finally {
        store.close();
      }
    });

  semantic
    .command("approve-store <bundleId>")
    .description("Approve or reject a stored semantic bundle and persist the decision")
    .requiredOption("--reviewer <name>", "Reviewer identity to attach to the approval")
    .option("--db <path>", "Override semantic.db path")
    .option("--json", "Print machine-readable JSON output")
    .option("--min-quality <number>", "Minimum quality score required for approval", "0.7")
    .option("--duplicate-policy <policy>", "Duplicate policy: warn | reject", "reject")
    .option("--notes <text>", "Optional review notes")
    .action((bundleId: string, opts: ApproveStoreOptions) => {
      const store = openRuntimeSemanticStore(loadFabricRuntime(), opts.db);
      try {
        const bundle = store.getBundle(bundleId);
        if (!bundle) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        const engine = new SemanticReviewEngine();
        const reviewed = engine.approveBundle(bundle, {
          reviewer: opts.reviewer,
          minQualityScore: parseUnitInterval(opts.minQuality, "--min-quality"),
          duplicatePolicy: parseDuplicatePolicy(opts.duplicatePolicy),
          notes: opts.notes,
        });
        store.upsertBundle(reviewed);
        if (opts.json) {
          console.log(JSON.stringify({
            bundle_id: reviewed.bundle_id,
            review: reviewed.review,
            diagnostics: reviewed.diagnostics,
          }, null, 2));
          return;
        }
        console.log(`Stored review status: ${reviewed.review?.status}`);
      } finally {
        store.close();
      }
    });

  semantic
    .command("audit-export")
    .description("Export the full governance audit trail as machine-readable JSON")
    .option("--db <path>", "Override semantic.db path")
    .action((opts: { db?: string }) => {
      const store = openRuntimeSemanticStore(loadFabricRuntime(), opts.db);
      try {
        console.log(JSON.stringify(store.exportAuditTrail(), null, 2));
      } finally {
        store.close();
      }
    });
}

interface StoredBundleOptions {
  db?: string;
  json?: boolean;
  strategy?: string;
  chunkSize?: string;
  overlap?: string;
  lowQualityThreshold: string;
}

interface StoreInspectOptions {
  db?: string;
  json?: boolean;
}

interface ApproveStoreOptions {
  reviewer: string;
  db?: string;
  json?: boolean;
  minQuality: string;
  duplicatePolicy: string;
  notes?: string;
}
