import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AkiDB } from "@ax-fabric/akidb";
import type { EmbedderProvider } from "@ax-fabric/contracts";

import type { FabricConfig } from "../cli/config-loader.js";
import {
  DEFAULT_LOW_QUALITY_THRESHOLD,
  DEFAULT_SEMANTIC_APPROVAL_THRESHOLD,
} from "../constants.js";
import { publishSemanticBundleToCollection } from "../semantic/publication-service.js";
import {
  SemanticReviewEngine,
  SemanticStore,
} from "../semantic/index.js";

export interface SemanticToolsDeps {
  db: AkiDB;
  embedder: EmbedderProvider;
  config: FabricConfig;
  semanticDbPath: string;
}

export function registerSemanticTools(server: McpServer, deps: SemanticToolsDeps): void {
  const { db, embedder, config, semanticDbPath } = deps;

  server.tool(
    "fabric_semantic_store_bundle",
    "Create a semantic bundle from a file and store it in the canonical semantic store",
    {
      file_path: z.string().describe("Path to the source file"),
      low_quality_threshold: z.number().min(0).max(1).optional().default(DEFAULT_LOW_QUALITY_THRESHOLD).describe("Flag units below this score"),
      strategy: z.enum(["auto", "fixed", "markdown", "structured"]).optional().describe("Chunking strategy override"),
    },
    async (args) => {
      try {
        const engine = new SemanticReviewEngine();
        const bundle = await engine.createBundle(args.file_path, {
          strategy: args.strategy,
          chunkSize: config.ingest.chunking.chunk_size,
          overlapRatio: config.ingest.chunking.overlap,
          lowQualityThreshold: args.low_quality_threshold,
        });
        const store = new SemanticStore(semanticDbPath);
        try {
          store.upsertBundle(bundle);
        } finally {
          store.close();
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bundle_id: bundle.bundle_id,
              source_path: bundle.source_path,
              total_units: bundle.diagnostics.total_units,
              average_quality_score: bundle.diagnostics.average_quality_score,
              review_status: bundle.review?.status ?? "pending",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_semantic_list_bundles",
    "List semantic bundles from the canonical semantic store",
    {},
    async () => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundles = store.listBundles();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ bundles }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_semantic_inspect_bundle",
    "Inspect a semantic bundle and its publication state from the canonical semantic store",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const stored = store.getStoredBundle(args.bundle_id);
          if (!stored) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(stored, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_semantic_approve_bundle",
    "Approve or reject a stored semantic bundle under the configured review policy",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
      reviewer: z.string().min(1).describe("Reviewer identity"),
      min_quality_score: z.number().min(0).max(1).optional().default(DEFAULT_SEMANTIC_APPROVAL_THRESHOLD).describe("Minimum quality score"),
      duplicate_policy: z.enum(["warn", "reject"]).optional().default("reject").describe("Duplicate handling policy"),
      notes: z.string().optional().describe("Optional review notes"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundle = store.getBundle(args.bundle_id);
          if (!bundle) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          const engine = new SemanticReviewEngine();
          const reviewed = engine.approveBundle(bundle, {
            reviewer: args.reviewer,
            minQualityScore: args.min_quality_score,
            duplicatePolicy: args.duplicate_policy,
            notes: args.notes,
          });
          store.upsertBundle(reviewed);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                bundle_id: reviewed.bundle_id,
                review: reviewed.review,
                diagnostics: reviewed.diagnostics,
              }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_semantic_publish_bundle",
    "Publish an approved semantic bundle into the semantic AkiDB collection",
    {
      bundle_id: z.string().describe("Semantic bundle ID"),
      collection_id: z.string().optional().describe("Override semantic collection ID"),
      replace_existing: z.boolean().optional().default(false).describe("Replace the active bundle for the same doc"),
      actor: z.string().min(1).optional().describe("Actor identity to attach to the publication audit trail"),
    },
    async (args) => {
      try {
        const store = new SemanticStore(semanticDbPath);
        try {
          const bundle = store.getBundle(args.bundle_id);
          if (!bundle) {
            return { content: [{ type: "text" as const, text: `Error: Semantic bundle not found: ${args.bundle_id}` }], isError: true };
          }
          const collectionId = args.collection_id ?? `${config.akidb.collection}${config.retrieval.semantic_collection_suffix}`;
          const manifest = await publishSemanticBundleToCollection({
            bundleId: args.bundle_id,
            bundle,
            store,
            db,
            embedder,
            config,
            collectionId,
            replaceExisting: args.replace_existing === true,
            actor: args.actor ?? "mcp",
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                bundle_id: args.bundle_id,
                collection_id: collectionId,
                manifest_version: manifest.version,
              }, null, 2),
            }],
          };
        } finally {
          store.close();
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
