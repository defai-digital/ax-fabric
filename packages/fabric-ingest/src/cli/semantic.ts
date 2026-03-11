import { resolve } from "node:path";

import type { Command } from "commander";

import { SemanticDistiller } from "../semantic/index.js";
import { SemanticReviewEngine } from "../semantic/index.js";

import { loadConfig, resolveConfigPath } from "./config-loader.js";

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
