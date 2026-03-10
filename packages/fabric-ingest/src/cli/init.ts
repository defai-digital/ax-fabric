/**
 * `ax-fabric init` — initialize a workspace with default config and AkiDB collection.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";

import { loadConfig } from "./config-loader.js";

// Default config using a real-world embedding dimension (1536 = OpenAI text-embedding-3-small).
// The mock embedder is clearly documented as testing-only.
const DEFAULT_CONFIG_YAML = `# ax-fabric configuration
fabric:
  data_root: ~/.ax-fabric/data

akidb:
  root: ~/.ax-fabric/data/akidb
  collection: default
  metric: cosine
  dimension: 1536

ingest:
  sources: []
  scan:
    mode: incremental
    fingerprint: sha256
  chunking:
    chunk_size: 2800
    overlap: 0.15

# Embedding provider — replace with a real embedder for production use.
# Examples:
#   type: http                       # OpenAI-compatible endpoint
#   base_url: "http://localhost:11434/v1"
#   model_id: "nomic-embed-text"
#   dimension: 768
#
#   type: cloudflare
#   account_id: "your-account-id"
#   api_key_env: CLOUDFLARE_API_TOKEN
#   model_id: "@cf/baai/bge-large-en-v1.5"
#   dimension: 1024
embedder:
  type: local
  model_id: mock-embed-v1   # TESTING ONLY — replace with a real embedder
  dimension: 1536
  batch_size: 64
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize an ax-fabric workspace")
    .action(async () => {
      const axHome = join(homedir(), ".ax-fabric");
      const dataDir = join(axHome, "data");
      const akidbDir = join(dataDir, "akidb");

      // Create directories
      if (!existsSync(axHome)) {
        mkdirSync(axHome, { recursive: true });
        console.log(`Created ${axHome}`);
      }

      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
        console.log(`Created ${dataDir}`);
      }

      if (!existsSync(akidbDir)) {
        mkdirSync(akidbDir, { recursive: true });
        console.log(`Created ${akidbDir}`);
      }

      // Write default config if it doesn't exist
      const configPath = join(axHome, "config.yaml");
      if (!existsSync(configPath)) {
        writeFileSync(configPath, DEFAULT_CONFIG_YAML, "utf-8");
        console.log(`Created default config at ${configPath}`);
      } else {
        console.log(`Config already exists at ${configPath}`);
      }

      // Read dimension and model from the config that is now on disk
      // (either the one we just wrote or the pre-existing one).
      let dimension = 1536;
      let metric: "cosine" | "l2" | "dot" = "cosine";
      let embeddingModelId = "mock-embed-v1";
      try {
        const cfg = loadConfig(configPath);
        dimension = cfg.akidb.dimension;
        metric = cfg.akidb.metric;
        embeddingModelId = cfg.embedder.model_id;
      } catch (err) {
        console.warn(`Warning: could not parse config (using defaults): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Create default AkiDB collection
      const storagePath = akidbDir;

      try {
        const db = new AkiDB({ storagePath });
        try {
          db.createCollection({
            collectionId: "default",
            dimension,
            metric,
            embeddingModelId,
          });
          console.log(`Created default AkiDB collection (dimension=${String(dimension)}, model=${embeddingModelId})`);
        } catch {
          // Collection may already exist — that's fine
          console.log("Default AkiDB collection already exists");
        }
        db.close();
      } catch (err) {
        console.error("Failed to initialize AkiDB:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      console.log("\nWorkspace initialized successfully.");
    });
}
