import { resolve } from "node:path";

import type { Command } from "commander";

import { SemanticDistiller } from "../semantic/index.js";

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

function parseStrategy(raw: string): "auto" | "fixed" | "markdown" | "structured" {
  if (raw === "auto" || raw === "fixed" || raw === "markdown" || raw === "structured") {
    return raw;
  }
  throw new Error("--strategy must be one of: auto, fixed, markdown, structured");
}
