import { mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";

import type {
  ChunkLabel,
  RecordMetadata,
  SemanticUnit,
} from "@ax-fabric/contracts";
import { SemanticUnitSchema } from "@ax-fabric/contracts";

import { createDefaultRegistry } from "../extractor/index.js";
import { normalize } from "../normalizer/index.js";
import { stageChunk } from "../pipeline/stages.js";
import { fingerprintAsync } from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";

export interface SemanticDistillOptions {
  chunkSize?: number;
  overlapRatio?: number;
  strategy?: "auto" | "fixed" | "markdown" | "structured";
  maxKeywords?: number;
  maxEntities?: number;
  maxSummarySentences?: number;
}

export interface SemanticDistillResult {
  docId: string;
  docVersion: string;
  sourcePath: string;
  contentType: RecordMetadata["content_type"];
  distillStrategy: "extractive-v1";
  units: SemanticUnit[];
}

const DEFAULT_MAX_KEYWORDS = 6;
const DEFAULT_MAX_ENTITIES = 6;
const DEFAULT_MAX_SUMMARY_SENTENCES = 2;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "for", "from", "had", "has", "have", "if", "in", "into", "is", "it", "its",
  "of", "on", "or", "that", "the", "their", "then", "there", "these", "this",
  "to", "was", "were", "will", "with", "within", "without", "you", "your",
]);

const ENTITY_RE = /\b(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)*|[A-Z]{2,}(?:-[A-Z0-9]+)*)\b/g;

export class SemanticDistiller {
  async distillFile(
    filePath: string,
    options?: SemanticDistillOptions,
  ): Promise<SemanticDistillResult> {
    const scan = await scanSingleFile(filePath);
    const extractorRegistry = createDefaultRegistry();
    const extractor = extractorRegistry.getExtractor(filePath);

    if (!extractor) {
      throw new Error(`No extractor registered for: ${filePath}`);
    }

    const extracted = await extractor.extract(filePath);
    const normalizedText = normalize(extracted.text);
    if (normalizedText.trim().length === 0) {
      throw new Error(`No extractable text found in ${filePath}`);
    }

    const chunked = stageChunk(
      { normalizedText },
      scan,
      {
        chunkSize: options?.chunkSize,
        overlapRatio: options?.overlapRatio,
        strategy: options?.strategy,
      },
    );

    if (!chunked) {
      throw new Error(`No semantic units could be generated for ${filePath}`);
    }

    const units = chunked.chunks.map((chunk) => {
      const title = deriveTitle(chunk.text, chunk.label);
      const summary = summarizeText(
        chunk.text,
        options?.maxSummarySentences ?? DEFAULT_MAX_SUMMARY_SENTENCES,
      );
      const answer = deriveAnswer(chunk.text);
      const keywords = extractKeywords(
        chunk.text,
        options?.maxKeywords ?? DEFAULT_MAX_KEYWORDS,
      );
      const entities = extractEntities(
        chunk.text,
        options?.maxEntities ?? DEFAULT_MAX_ENTITIES,
      );
      const canonicalText = normalizeForHash(`${title}\n${summary}\n${answer}`);

      const unit: SemanticUnit = {
        unit_id: digest(`${chunked.docId}:${chunk.chunkId}:${canonicalText}`),
        doc_id: chunked.docId,
        doc_version: chunked.docVersion,
        title,
        question: deriveQuestion(title, keywords),
        summary,
        answer,
        keywords,
        entities,
        quality_score: computeQualityScore(chunk.text, chunk.label, keywords, entities),
        distill_strategy: "extractive-v1",
        source_spans: [
          {
            source_uri: scan.sourcePath,
            content_type: scan.contentType,
            page_range: extracted.pageRange ?? null,
            table_ref: extracted.tableRef ?? null,
            offset_start: chunk.offset,
            offset_end: chunk.offset + chunk.text.length,
            chunk_id: chunk.chunkId,
            chunk_hash: chunk.chunkHash,
            chunk_label: chunk.label,
          },
        ],
      };

      return {
        unit: SemanticUnitSchema.parse(unit),
        dedupKey: digest(canonicalText),
      };
    });

    const duplicateGroupSizes = new Map<string, number>();
    for (const entry of units) {
      duplicateGroupSizes.set(entry.dedupKey, (duplicateGroupSizes.get(entry.dedupKey) ?? 0) + 1);
    }

    const finalizedUnits = units.map(({ unit, dedupKey }) => {
      const size = duplicateGroupSizes.get(dedupKey) ?? 1;
      if (size > 1) {
        return {
          ...unit,
          duplicate_group_id: dedupKey,
          duplicate_group_size: size,
        };
      }
      return unit;
    });

    return {
      docId: chunked.docId,
      docVersion: chunked.docVersion,
      sourcePath: scan.sourcePath,
      contentType: scan.contentType,
      distillStrategy: "extractive-v1",
      units: finalizedUnits,
    };
  }

  exportToFile(result: SemanticDistillResult, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
}

async function scanSingleFile(filePath: string): Promise<ScanResult> {
  const resolvedPath = resolve(filePath);
  const fileStat = await stat(resolvedPath);
  const ext = extname(resolvedPath).toLowerCase();
  const contentType = contentTypeForExtension(ext);
  if (!contentType) {
    throw new Error(`Unsupported or missing source file: ${resolvedPath}`);
  }

  return {
    sourcePath: resolvedPath,
    fingerprint: await fingerprintAsync(resolvedPath),
    sizeBytes: fileStat.size,
    mtimeMs: Math.trunc(fileStat.mtimeMs),
    contentType,
  };
}

function contentTypeForExtension(
  ext: string,
): RecordMetadata["content_type"] | null {
  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown":
      return "txt";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".pptx":
      return "pptx";
    case ".xlsx":
      return "xlsx";
    case ".csv":
      return "csv";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return null;
  }
}

function deriveTitle(text: string, label: ChunkLabel): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const firstLine = lines[0] ?? "";
  if (firstLine.startsWith("#")) {
    return firstLine.replace(/^#+\s*/, "").trim();
  }

  if (label === "heading" && firstLine.length > 0) {
    return truncate(firstLine, 96);
  }

  const firstSentence = splitSentences(text)[0] ?? firstLine;
  return truncate(firstSentence.trim(), 96);
}

function summarizeText(text: string, maxSentences: number): string {
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    return truncate(sentences.slice(0, Math.max(1, maxSentences)).join(" "), 320);
  }
  return truncate(normalizeWhitespace(text), 320);
}

function deriveAnswer(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    return truncate(sentences.slice(0, 3).join(" "), 480);
  }
  return truncate(normalizeWhitespace(text), 480);
}

function deriveQuestion(title: string, keywords: string[]): string {
  if (title.endsWith("?")) {
    return title;
  }
  const subject = title.trim() || keywords[0] || "this section";
  return `What is the key point about ${subject}?`;
}

function extractKeywords(text: string, maxKeywords: number): string[] {
  const scores = new Map<string, number>();
  const tokens = normalizeWhitespace(text)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (STOPWORDS.has(token)) continue;
    const weight = index < 24 ? 2 : 1;
    scores.set(token, (scores.get(token) ?? 0) + weight);
  }

  return Array.from(scores.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, Math.max(1, maxKeywords))
    .map(([token]) => token);
}

function extractEntities(text: string, maxEntities: number): string[] {
  const matches = text.match(ENTITY_RE) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const candidate = match.trim();
    if (candidate.length < 2) continue;
    if (/^[A-Z]$/.test(candidate)) continue;
    unique.add(candidate);
    if (unique.size >= maxEntities) break;
  }
  return Array.from(unique);
}

function computeQualityScore(
  text: string,
  label: ChunkLabel,
  keywords: string[],
  entities: string[],
): number {
  const length = normalizeWhitespace(text).length;
  const sentences = splitSentences(text).length;
  let score = 0.35;

  if (length >= 120 && length <= 2200) score += 0.2;
  else if (length >= 60) score += 0.1;

  if (sentences >= 2) score += 0.15;
  else if (sentences === 1) score += 0.08;

  if (keywords.length >= 4) score += 0.15;
  else if (keywords.length >= 2) score += 0.1;

  if (entities.length > 0) score += 0.05;

  if (label === "heading" || label === "paragraph") score += 0.1;
  else score += 0.05;

  return Math.min(0.98, Number(score.toFixed(2)));
}

function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeForHash(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
