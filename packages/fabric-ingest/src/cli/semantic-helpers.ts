/**
 * Shared parse utilities and output formatting for semantic CLI commands.
 *
 * Extracted from semantic.ts as part of v3.1 CLI modularization (C-1/C-2).
 */

import { resolve } from "node:path";

import type { SemanticBundle } from "@ax-fabric/contracts";

import { SemanticDistiller, SemanticReviewEngine } from "../semantic/index.js";
import { loadConfig, resolveConfigPath } from "./config-loader.js";

// ─── Parse helpers ───────────────────────────────────────────────────────────

export function parsePositiveInteger(raw: string, flagName: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return value;
}

export function parseOverlap(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("--overlap must be between 0 and 1");
  }
  return value;
}

export function parseUnitInterval(raw: string, flagName: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${flagName} must be between 0 and 1`);
  }
  return value;
}

export function parseStrategy(raw: string): "auto" | "fixed" | "markdown" | "structured" {
  if (raw === "auto" || raw === "fixed" || raw === "markdown" || raw === "structured") {
    return raw;
  }
  throw new Error("--strategy must be one of: auto, fixed, markdown, structured");
}

export function parseDuplicatePolicy(raw: string): "warn" | "reject" {
  if (raw === "warn" || raw === "reject") {
    return raw;
  }
  throw new Error("--duplicate-policy must be one of: warn, reject");
}

// ─── Bundle creation ─────────────────────────────────────────────────────────

export async function distillFromCli(
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

export async function createBundleFromCli(
  file: string,
  opts: { strategy?: string; chunkSize?: string; overlap?: string; lowQualityThreshold: string },
): Promise<SemanticBundle> {
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

// ─── Output formatting ───────────────────────────────────────────────────────

export function printBundleDiagnostics(bundle: {
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
