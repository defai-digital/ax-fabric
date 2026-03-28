/**
 * Semantic file-based CLI commands — preview, export, review, bundle, inspect, approve.
 *
 * Extracted from semantic.ts as part of v3.1 CLI modularization.
 */

import { resolve } from "node:path";

import type { Command } from "commander";

import { SemanticDistiller, SemanticReviewEngine } from "../semantic/index.js";
import { DEFAULT_LOW_QUALITY_THRESHOLD } from "../constants.js";

import {
  distillFromCli,
  createBundleFromCli,
  parsePositiveInteger,
  parseUnitInterval,
  parseDuplicatePolicy,
  printBundleDiagnostics,
} from "./semantic-helpers.js";

export function registerSemanticFileCommands(semantic: Command): void {
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
        if (unit.themes && unit.themes.length > 0) {
          console.log(`      themes:   ${unit.themes.join(", ")}`);
        }
        if (unit.keywords.length > 0) {
          console.log(`      keywords: ${unit.keywords.join(", ")}`);
        }
        if (unit.entities.length > 0) {
          console.log(`      entities: ${unit.entities.join(", ")}`);
        }
        if (unit.quality_signals) {
          console.log(
            `      signals:  coverage=${unit.quality_signals.coverage.toFixed(2)} `
            + `density=${unit.quality_signals.density.toFixed(2)} `
            + `structure=${unit.quality_signals.structure.toFixed(2)} `
            + `noise=${unit.quality_signals.noise_penalty.toFixed(2)}`,
          );
          if (unit.quality_signals.flags.length > 0) {
            console.log(`      flags:    ${unit.quality_signals.flags.join(", ")}`);
          }
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
    .option("--low-quality-threshold <number>", "Flag units below this quality score", String(DEFAULT_LOW_QUALITY_THRESHOLD))
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
    .option("--low-quality-threshold <number>", "Flag units below this quality score", String(DEFAULT_LOW_QUALITY_THRESHOLD))
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

function defaultReviewedBundlePath(bundlePath: string): string {
  if (bundlePath.endsWith(".json")) {
    return `${bundlePath.slice(0, -5)}.reviewed.json`;
  }
  return `${bundlePath}.reviewed.json`;
}
