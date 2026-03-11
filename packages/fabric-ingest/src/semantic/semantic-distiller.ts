import { mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";

import type {
  ChunkLabel,
  RecordMetadata,
  SemanticQualitySignals,
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
const DEFAULT_MAX_ANSWER_SENTENCES = 3;

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
      const summarySentences = summarizeSentences(
        chunk.text,
        options?.maxSummarySentences ?? DEFAULT_MAX_SUMMARY_SENTENCES,
      );
      const summary = truncate(summarySentences.join(" "), 320);
      const answer = deriveAnswer(chunk.text, summarySentences);
      const keywords = extractKeywords(
        chunk.text,
        options?.maxKeywords ?? DEFAULT_MAX_KEYWORDS,
      );
      const entities = extractEntities(
        chunk.text,
        options?.maxEntities ?? DEFAULT_MAX_ENTITIES,
      );
      const themes = extractThemes(title, chunk.text, keywords, entities);
      const qualitySignals = computeQualitySignals(chunk.text, chunk.label, keywords, entities);
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
        themes,
        quality_score: qualitySignals.confidence,
        quality_signals: qualitySignals,
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
        dedupKey: digest(canonicalizeForDedup(chunk.text, title)),
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
      return "txt";
    case ".md":
    case ".markdown":
      return "md";
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
    case ".tsv":
      return "tsv";
    case ".json":
      return "json";
    case ".jsonl":
      return "jsonl";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".html":
    case ".htm":
      return "html";
    case ".rtf":
      return "rtf";
    case ".sql":
      return "sql";
    case ".log":
      return "log";
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

function summarizeSentences(text: string, maxSentences: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    const ranked = rankSummarySentences(sentences);
    const limited = ranked
      .slice(0, Math.max(1, maxSentences))
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.text);
    return limited.length > 0 ? limited : [truncate(normalizeWhitespace(text), 320)];
  }
  return [truncate(normalizeWhitespace(text), 320)];
}

function deriveAnswer(text: string, summarySentences: string[]): string {
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    const normalizedSummary = new Set(summarySentences.map((sentence) => normalizeWhitespace(sentence)));
    const answerSentences = [
      ...summarySentences,
      ...sentences.filter((sentence) => !normalizedSummary.has(normalizeWhitespace(sentence))),
    ].slice(0, DEFAULT_MAX_ANSWER_SENTENCES);
    return truncate(answerSentences.join(" "), 480);
  }
  return truncate(normalizeWhitespace(text), 480);
}

function deriveQuestion(title: string, keywords: string[]): string {
  if (title.endsWith("?")) {
    return title;
  }
  const normalizedTitle = title.trim();
  if (/^(what|why|how|when|where|who)\b/i.test(normalizedTitle)) {
    return `${normalizedTitle.replace(/[.]+$/, "")}?`;
  }
  const subject = normalizedTitle || keywords[0] || "this section";
  if (/^(overview|summary|introduction|background)$/i.test(subject)) {
    return `What does ${subject.toLowerCase()} cover?`;
  }
  return `What is the key point about ${subject.replace(/[.]+$/, "")}?`;
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

function extractThemes(
  title: string,
  text: string,
  keywords: string[],
  entities: string[],
): string[] {
  const candidates = new Set<string>();
  const normalizedTitle = normalizeWhitespace(title).toLowerCase();
  if (normalizedTitle.length >= 4) {
    candidates.add(normalizedTitle);
  }

  const topicMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  for (const match of topicMatches) {
    const candidate = normalizeWhitespace(match).toLowerCase();
    if (candidate.length >= 4) {
      candidates.add(candidate);
    }
  }

  for (const entity of entities) {
    candidates.add(normalizeWhitespace(entity).toLowerCase());
  }

  for (const keyword of keywords) {
    if (keyword.length >= 4) {
      candidates.add(keyword);
    }
  }

  return Array.from(candidates)
    .filter((candidate) => !STOPWORDS.has(candidate))
    .slice(0, 8);
}

function computeQualitySignals(
  text: string,
  label: ChunkLabel,
  keywords: string[],
  entities: string[],
): SemanticQualitySignals {
  const normalized = normalizeWhitespace(text);
  const length = normalized.length;
  const sentenceList = splitSentences(text);
  const sentences = sentenceList.length;
  const flags: string[] = [];
  const coverage = clamp01(
    length >= 120 && length <= 2200 ? 0.82
      : length >= 60 ? 0.68
      : 0.48,
  );
  const density = clamp01(
    0.42
      + (keywords.length >= 4 ? 0.24 : keywords.length >= 2 ? 0.14 : 0)
      + (entities.length > 0 ? 0.1 : 0)
      + (sentences >= 2 ? 0.1 : sentences === 1 ? 0.04 : 0),
  );
  const structure = clamp01(
    0.48
      + ((label === "heading" || label === "paragraph") ? 0.24 : 0.12)
      + (sentences >= 2 ? 0.14 : 0)
      + (averageSentenceLength(sentenceList) >= 24 ? 0.08 : 0),
  );

  let noisePenalty = 0;
  if (hasRepeatedLines(text)) {
    noisePenalty += 0.12;
    flags.push("repeated_lines");
  }
  if (looksNoisy(normalized)) {
    noisePenalty += 0.1;
    flags.push("noisy_content");
  }
  if (containsMostlyUppercaseWords(normalized)) {
    noisePenalty += 0.08;
    flags.push("uppercase_heavy");
  }
  if (sentences > 0 && averageSentenceLength(sentenceList) < 24) {
    noisePenalty += 0.05;
    flags.push("low_information_density");
  }

  const confidence = clamp01(
    Number((0.28 + coverage * 0.25 + density * 0.24 + structure * 0.23 - noisePenalty).toFixed(2)),
  );

  return {
    coverage: Number(coverage.toFixed(2)),
    density: Number(density.toFixed(2)),
    structure: Number(structure.toFixed(2)),
    noise_penalty: Number(Math.min(1, noisePenalty).toFixed(2)),
    confidence,
    flags: Array.from(new Set(flags)).slice(0, 8),
  };
}

function rankSummarySentences(sentences: string[]): Array<{ text: string; index: number; score: number }> {
  return sentences.map((sentence, index) => ({
    text: sentence,
    index,
    score: summarySentenceScore(sentence, index),
  })).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });
}

function summarySentenceScore(sentence: string, index: number): number {
  const normalized = normalizeWhitespace(sentence);
  const tokenCount = normalized.split(/\s+/).length;
  let score = 0;

  if (tokenCount >= 8 && tokenCount <= 28) score += 3;
  else if (tokenCount >= 5) score += 1.5;

  if (/[A-Z][a-z]/.test(sentence)) score += 0.8;
  if (/\b(must|should|provides|supports|requires|ensures|enables|preserves)\b/i.test(sentence)) score += 1.5;
  if (/\b(is|are|means|includes)\b/i.test(sentence)) score += 0.8;
  if (/[:;]/.test(sentence)) score += 0.3;

  score -= index * 0.1;
  return score;
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

function canonicalizeForDedup(text: string, title: string): string {
  const normalizedText = normalizeWhitespace(text)
    .toLowerCase()
    .replace(/^#+\s*/gm, "")
    .replace(/\b\d+[\.\)]\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedTitle = normalizeWhitespace(title)
    .toLowerCase()
    .replace(/^\d+[\.\)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${normalizedTitle}\n${normalizedText}`;
}

function hasRepeatedLines(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
  if (lines.length < 2) return false;

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line)) return true;
    seen.add(line);
  }
  return false;
}

function looksNoisy(text: string): boolean {
  const punctuationRuns = (text.match(/[^\w\s]{3,}/g) ?? []).length;
  const digits = (text.match(/\d/g) ?? []).length;
  return punctuationRuns > 1 || (text.length > 0 && digits / text.length > 0.2);
}

function containsMostlyUppercaseWords(text: string): boolean {
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  if (words.length === 0) return false;
  const uppercaseWords = words.filter((word) => word === word.toUpperCase());
  return uppercaseWords.length / words.length > 0.4;
}

function averageSentenceLength(sentences: string[]): number {
  if (sentences.length === 0) return 0;
  const totalWords = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
  return totalWords / sentences.length;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function digest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
