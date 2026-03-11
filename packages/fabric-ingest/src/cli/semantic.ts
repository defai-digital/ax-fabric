import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { Command } from "commander";
import { AkiDB } from "@ax-fabric/akidb";
import type { Record as AkiRecord, SemanticBundle } from "@ax-fabric/contracts";

import { SemanticDistiller } from "../semantic/index.js";
import { SemanticReviewEngine } from "../semantic/index.js";
import { SemanticStore } from "../semantic/index.js";

import { createEmbedderFromConfig } from "./create-embedder.js";
import { loadConfig, resolveConfigPath, resolveDataRoot, type FabricConfig } from "./config-loader.js";

export function registerSemanticCommand(program: Command): void {
  const semantic = program
    .command("semantic")
    .description("Preview and export semantic units for a single file");

  semantic
    .command("preview <file>")
    .description("Preview grounded semantic units for a file")
    .option("--json", "Print machine-readable JSON output")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .option("--limit <number>", "Limit displayed semantic units", "10")
    .action(async (file: string, opts: PreviewOptions) => {
      const result = await distillFromCli(file, opts);
      const limit = parsePositiveInteger(opts.limit, "--limit");
      const units = result.units.slice(0, limit);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, units }, null, 2));
        return;
      }

      console.log(`\nSemantic preview: ${result.sourcePath}\n`);
      console.log(`  Units:            ${String(result.units.length)}`);
      console.log(`  Distill strategy: ${result.distillStrategy}`);
      console.log(`  Content type:     ${result.contentType}`);
      console.log("");

      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index]!;
        const span = unit.source_spans[0]!;
        console.log(`  ${String(index + 1).padStart(2, " ")}. ${unit.title}`);
        console.log(`      question: ${unit.question}`);
        console.log(`      summary:  ${unit.summary}`);
        console.log(`      answer:   ${unit.answer}`);
        console.log(`      quality:  ${unit.quality_score.toFixed(2)}`);
        console.log(`      source:   ${span.source_uri}:${String(span.offset_start)}-${String(span.offset_end)}`);
        if (unit.keywords.length > 0) {
          console.log(`      keywords: ${unit.keywords.join(", ")}`);
        }
        if (unit.entities.length > 0) {
          console.log(`      entities: ${unit.entities.join(", ")}`);
        }
        if (unit.duplicate_group_size && unit.duplicate_group_size > 1) {
          console.log(`      duplicates: group=${unit.duplicate_group_id} size=${String(unit.duplicate_group_size)}`);
        }
        console.log("");
      }
    });

  semantic
    .command("export <file>")
    .description("Export semantic units for a file to JSON")
    .requiredOption("-o, --output <path>", "Output JSON path")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .action(async (file: string, opts: ExportOptions) => {
      const result = await distillFromCli(file, opts);
      const outputPath = resolve(opts.output);
      new SemanticDistiller().exportToFile(result, outputPath);
      console.log(`Exported ${String(result.units.length)} semantic units to ${outputPath}`);
    });

  semantic
    .command("review <file>")
    .description("Generate a reviewable semantic bundle with diagnostics")
    .option("--json", "Print machine-readable JSON output")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .option("--low-quality-threshold <number>", "Flag units below this quality score", "0.6")
    .action(async (file: string, opts: ReviewOptions) => {
      const bundle = await createBundleFromCli(file, opts);

      if (opts.json) {
        console.log(JSON.stringify(bundle, null, 2));
        return;
      }

      printBundleDiagnostics(bundle);
    });

  semantic
    .command("bundle <file>")
    .description("Export a reviewable semantic bundle to JSON")
    .requiredOption("-o, --output <path>", "Output JSON path")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .option("--low-quality-threshold <number>", "Flag units below this quality score", "0.6")
    .action(async (file: string, opts: BundleOptions) => {
      const bundle = await createBundleFromCli(file, opts);
      const outputPath = resolve(opts.output);
      new SemanticReviewEngine().exportBundle(bundle, outputPath);
      console.log(`Exported semantic bundle to ${outputPath}`);
    });

  semantic
    .command("inspect <bundle>")
    .description("Inspect a semantic review bundle from disk")
    .option("--json", "Print machine-readable JSON output")
    .action(async (bundlePath: string, opts: InspectOptions) => {
      const engine = new SemanticReviewEngine();
      const bundle = engine.loadBundle(resolve(bundlePath));

      if (opts.json) {
        console.log(JSON.stringify(bundle, null, 2));
        return;
      }

      printBundleDiagnostics(bundle);
      if (bundle.review) {
        console.log(`  Review status:    ${bundle.review.status}`);
        console.log(`  Reviewer:         ${bundle.review.reviewer}`);
      }
    });

  semantic
    .command("approve <bundle>")
    .description("Approve or reject a semantic bundle under the configured policy")
    .requiredOption("--reviewer <name>", "Reviewer identity to attach to the approval")
    .option("-o, --output <path>", "Output reviewed bundle path")
    .option("--min-quality <number>", "Minimum quality score required for approval", "0.7")
    .option("--duplicate-policy <policy>", "Duplicate policy: warn | reject", "reject")
    .option("--notes <text>", "Optional review notes")
    .action(async (bundlePath: string, opts: ApproveOptions) => {
      const engine = new SemanticReviewEngine();
      const bundle = engine.loadBundle(resolve(bundlePath));
      const reviewed = engine.approveBundle(bundle, {
        reviewer: opts.reviewer,
        minQualityScore: parseUnitInterval(opts.minQuality, "--min-quality"),
        duplicatePolicy: parseDuplicatePolicy(opts.duplicatePolicy),
        notes: opts.notes,
      });

      const outputPath = resolve(opts.output ?? defaultReviewedBundlePath(bundlePath));
      engine.exportBundle(reviewed, outputPath);
      console.log(`Review status: ${reviewed.review?.status}`);
      console.log(`Reviewed bundle written to ${outputPath}`);
      if ((reviewed.review?.blocking_issues.length ?? 0) > 0) {
        for (const issue of reviewed.review?.blocking_issues ?? []) {
          console.log(`  blocking: ${issue}`);
        }
      }
    });

  semantic
    .command("store <file>")
    .description("Create a semantic bundle from a file and store it in the canonical SQLite store")
    .option("--db <path>", "Override semantic.db path")
    .option("--strategy <strategy>", "Chunking strategy: auto | fixed | markdown | structured")
    .option("--chunk-size <number>", "Override semantic distill chunk size")
    .option("--overlap <ratio>", "Override semantic distill overlap ratio")
    .option("--low-quality-threshold <number>", "Flag units below this quality score", "0.6")
    .action(async (file: string, opts: StoredBundleOptions) => {
      const { store, bundle } = await createStoredBundleFromCli(file, opts);
      try {
        store.upsertBundle(bundle);
        console.log(`Stored semantic bundle ${bundle.bundle_id} in ${resolveSemanticDbPathFromConfig(opts.db)}`);
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
      const store = openSemanticStore(opts.db);
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
      const store = openSemanticStore(opts.db);
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
    .option("--min-quality <number>", "Minimum quality score required for approval", "0.7")
    .option("--duplicate-policy <policy>", "Duplicate policy: warn | reject", "reject")
    .option("--notes <text>", "Optional review notes")
    .action((bundleId: string, opts: ApproveStoreOptions) => {
      const store = openSemanticStore(opts.db);
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
        console.log(`Stored review status: ${reviewed.review?.status}`);
      } finally {
        store.close();
      }
    });

  semantic
    .command("publish <bundleId>")
    .description("Publish an approved stored semantic bundle into AkiDB")
    .option("--db <path>", "Override semantic.db path")
    .option("--collection <id>", "Target AkiDB collection (default: <config.collection>-semantic)")
    .action(async (bundleId: string, opts: PublishOptions) => {
      const config = loadConfig(resolveConfigPath());
      const store = openSemanticStore(opts.db);
      const embedder = createEmbedderFromConfig(config);
      const akidbRoot = expandTilde(config.akidb.root);
      const db = new AkiDB({ storagePath: akidbRoot });

      try {
        const bundle = store.getBundle(bundleId);
        if (!bundle) {
          throw new Error(`Semantic bundle "${bundleId}" not found`);
        }
        if (bundle.review?.status !== "approved") {
          throw new Error(`Semantic bundle "${bundleId}" is not approved`);
        }

        const collectionId = opts.collection ?? `${config.akidb.collection}-semantic`;
        ensureCollection(db, config, collectionId);
        const records = await buildSemanticRecords(bundle, config, embedder);
        await db.upsertBatch(collectionId, records);
        const manifest = await db.publish(collectionId, {
          embeddingModelId: config.embedder.model_id,
          pipelineSignature: semanticPipelineSignature(bundle),
        });
        store.markPublished(bundleId, {
          collectionId,
          manifestVersion: manifest.version,
          publishedAt: new Date().toISOString(),
        });
        console.log(`Published semantic bundle ${bundleId} to ${collectionId} manifest=${String(manifest.version)}`);
      } finally {
        db.close();
        await embedder.close?.();
        store.close();
      }
    });
}

interface PreviewOptions {
  json?: boolean;
  strategy?: string;
  chunkSize?: string;
  overlap?: string;
  limit: string;
}

interface ExportOptions {
  output: string;
  strategy?: string;
  chunkSize?: string;
  overlap?: string;
}

interface ReviewOptions {
  json?: boolean;
  strategy?: string;
  chunkSize?: string;
  overlap?: string;
  lowQualityThreshold: string;
}

interface BundleOptions extends ReviewOptions {
  output: string;
}

interface InspectOptions {
  json?: boolean;
}

interface ApproveOptions {
  reviewer: string;
  output?: string;
  minQuality: string;
  duplicatePolicy: string;
  notes?: string;
}

interface StoredBundleOptions extends ReviewOptions {
  db?: string;
}

interface StoreInspectOptions {
  db?: string;
  json?: boolean;
}

interface ApproveStoreOptions {
  reviewer: string;
  db?: string;
  minQuality: string;
  duplicatePolicy: string;
  notes?: string;
}

interface PublishOptions {
  db?: string;
  collection?: string;
}

async function distillFromCli(
  file: string,
  opts: { strategy?: string; chunkSize?: string; overlap?: string },
) {
  const config = loadConfig(resolveConfigPath());
  const strategy = parseStrategy(opts.strategy ?? config.ingest.chunking.strategy);
  const chunkSize = opts.chunkSize
    ? parsePositiveInteger(opts.chunkSize, "--chunk-size")
    : config.ingest.chunking.chunk_size;
  const overlapRatio = opts.overlap
    ? parseOverlap(opts.overlap)
    : config.ingest.chunking.overlap;

  const distiller = new SemanticDistiller();
  return distiller.distillFile(resolve(file), {
    strategy,
    chunkSize,
    overlapRatio,
  });
}

async function createBundleFromCli(
  file: string,
  opts: { strategy?: string; chunkSize?: string; overlap?: string; lowQualityThreshold: string },
) {
  const config = loadConfig(resolveConfigPath());
  const strategy = parseStrategy(opts.strategy ?? config.ingest.chunking.strategy);
  const chunkSize = opts.chunkSize
    ? parsePositiveInteger(opts.chunkSize, "--chunk-size")
    : config.ingest.chunking.chunk_size;
  const overlapRatio = opts.overlap
    ? parseOverlap(opts.overlap)
    : config.ingest.chunking.overlap;

  const engine = new SemanticReviewEngine();
  return engine.createBundle(resolve(file), {
    strategy,
    chunkSize,
    overlapRatio,
    lowQualityThreshold: parseUnitInterval(opts.lowQualityThreshold, "--low-quality-threshold"),
  });
}

async function createStoredBundleFromCli(
  file: string,
  opts: StoredBundleOptions,
): Promise<{ store: SemanticStore; bundle: SemanticBundle }> {
  const bundle = await createBundleFromCli(file, opts);
  return {
    store: openSemanticStore(opts.db),
    bundle,
  };
}

function parsePositiveInteger(raw: string, flagName: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return value;
}

function parseOverlap(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("--overlap must be between 0 and 1");
  }
  return value;
}

function parseUnitInterval(raw: string, flagName: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${flagName} must be between 0 and 1`);
  }
  return value;
}

function parseStrategy(raw: string): "auto" | "fixed" | "markdown" | "structured" {
  if (raw === "auto" || raw === "fixed" || raw === "markdown" || raw === "structured") {
    return raw;
  }
  throw new Error("--strategy must be one of: auto, fixed, markdown, structured");
}

function parseDuplicatePolicy(raw: string): "warn" | "reject" {
  if (raw === "warn" || raw === "reject") {
    return raw;
  }
  throw new Error("--duplicate-policy must be one of: warn, reject");
}

function printBundleDiagnostics(bundle: {
  source_path: string;
  units: Array<{ unit_id: string }>;
  diagnostics: {
    total_units: number;
    average_quality_score: number;
    low_quality_unit_ids: string[];
    flagged_unit_ids: string[];
    duplicate_groups: Array<{ group_id: string; size: number }>;
  };
}): void {
  console.log(`\nSemantic review: ${bundle.source_path}\n`);
  console.log(`  Units:              ${String(bundle.diagnostics.total_units)}`);
  console.log(`  Avg quality:        ${bundle.diagnostics.average_quality_score.toFixed(3)}`);
  console.log(`  Low-quality units:  ${String(bundle.diagnostics.low_quality_unit_ids.length)}`);
  console.log(`  Flagged units:      ${String(bundle.diagnostics.flagged_unit_ids.length)}`);
  console.log(`  Duplicate groups:   ${String(bundle.diagnostics.duplicate_groups.length)}`);
  if (bundle.diagnostics.duplicate_groups.length > 0) {
    const summary = bundle.diagnostics.duplicate_groups
      .map((group) => `${group.group_id}:${String(group.size)}`)
      .join(", ");
    console.log(`  Duplicate detail:   ${summary}`);
  }
  console.log("");
}

function defaultReviewedBundlePath(bundlePath: string): string {
  if (bundlePath.endsWith(".json")) {
    return `${bundlePath.slice(0, -5)}.reviewed.json`;
  }
  return `${bundlePath}.reviewed.json`;
}

function openSemanticStore(dbPath?: string): SemanticStore {
  return new SemanticStore(resolveSemanticDbPathFromConfig(dbPath));
}

function resolveSemanticDbPathFromConfig(dbPath?: string): string {
  if (dbPath) {
    return resolve(dbPath);
  }
  const config = loadConfig(resolveConfigPath());
  return join(resolveDataRoot(config), "semantic.db");
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function ensureCollection(db: AkiDB, config: FabricConfig, collectionId: string): void {
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

async function buildSemanticRecords(
  bundle: SemanticBundle,
  config: FabricConfig,
  embedder: ReturnType<typeof createEmbedderFromConfig>,
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

function semanticUnitText(unit: SemanticBundle["units"][number]): string {
  return `${unit.title}\n\n${unit.summary}\n\n${unit.answer}`;
}

function semanticPipelineSignature(bundle: SemanticBundle): string {
  return `semantic-store:${bundle.distill_strategy}:${bundle.review?.status ?? "pending"}`;
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
