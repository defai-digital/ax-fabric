import { existsSync } from "node:fs";
import { join } from "node:path";

import { AkiDB } from "@ax-fabric/akidb";
import type { ExplainInfo, MetadataFilter, SearchResult as AkiSearchResult } from "@ax-fabric/akidb";

import { JobRegistry } from "../registry/index.js";
import { SemanticStore, type SemanticUnitLookup } from "../semantic/index.js";

export interface SearchResultMetadata {
  sourcePath: string;
  contentType: string;
  dedupeKey: string;
  title?: string;
  semanticQualityScore?: number;
}

export interface RenderedSearchResult {
  chunkId: string;
  score: number;
  sourcePath: string | null;
  contentType: string | null;
  explain: ExplainInfo | null | undefined;
  collection?: string;
  matchedLayers: Array<"raw" | "semantic">;
  provenanceChunkId: string;
  semanticTitle?: string;
  semanticQualityScore?: number;
}

export interface SearchExecutionResult {
  layer: "raw" | "semantic" | "fused";
  collectionId: string;
  manifestVersion: number | undefined;
  results: RenderedSearchResult[];
}

export function buildCliFilters(opts: {
  sourceUri?: string;
  contentType?: string;
  chunkLabel?: string;
}): MetadataFilter | undefined {
  const filters: Record<string, string> = {};
  if (opts.sourceUri) {
    filters["source_uri"] = opts.sourceUri;
  }
  if (opts.contentType) {
    validateContentType(opts.contentType);
    filters["content_type"] = opts.contentType;
  }
  if (opts.chunkLabel) {
    validateChunkLabel(opts.chunkLabel);
    filters["chunk_label"] = opts.chunkLabel;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

export function parseRequestedLayer(opts: {
  layer?: string;
  semantic?: boolean;
  fuse?: boolean;
}): "auto" | "raw" | "semantic" | "fused" {
  if (opts.fuse === true) return "fused";
  if (opts.semantic === true) return "semantic";
  if (!opts.layer) return "auto";
  if (opts.layer === "auto" || opts.layer === "raw" || opts.layer === "semantic" || opts.layer === "fused") {
    return opts.layer;
  }
  throw new Error("--layer must be one of: auto, raw, semantic, fused");
}

export async function executeSearch(args: {
  db: AkiDB;
  dataRoot: string;
  rawCollectionId: string;
  semanticCollectionId: string;
  requestedLayer: "auto" | "raw" | "semantic" | "fused";
  defaultLayer: "auto" | "raw" | "semantic" | "fused";
  queryVector: Float32Array;
  topK: number;
  mode: "vector" | "keyword" | "hybrid";
  queryText?: string;
  filters?: MetadataFilter;
  explain?: boolean;
  warn?: (message: string) => void;
}): Promise<SearchExecutionResult> {
  const activeLayer = resolveRetrievalLayer({
    requestedLayer: args.requestedLayer,
    defaultLayer: args.defaultLayer,
    dataRoot: args.dataRoot,
    semanticCollectionId: args.semanticCollectionId,
    db: args.db,
    warn: args.warn,
  });

  if (activeLayer === "fused") {
    return executeFusedSearch(args);
  }

  const collectionId = activeLayer === "semantic" ? args.semanticCollectionId : args.rawCollectionId;
  const searchResult = await args.db.search({
    collectionId,
    queryVector: args.queryVector,
    topK: args.topK,
    mode: args.mode,
    queryText: args.queryText,
    filters: args.filters,
    explain: args.explain,
  });
  const metadata = resolveSearchMetadata(
    args.dataRoot,
    searchResult.results.map((result) => result.chunkId),
    args.warn,
  );

  return {
    layer: activeLayer,
    collectionId,
    manifestVersion: searchResult.manifestVersionUsed,
    results: searchResult.results.map((result) => renderResult(result, metadata)),
  };
}

function executeFusedSearch(args: {
  db: AkiDB;
  dataRoot: string;
  rawCollectionId: string;
  semanticCollectionId: string;
  queryVector: Float32Array;
  topK: number;
  mode: "vector" | "keyword" | "hybrid";
  queryText?: string;
  filters?: MetadataFilter;
  explain?: boolean;
  warn?: (message: string) => void;
}): Promise<SearchExecutionResult> {
  return (async () => {
    const rawResult = await args.db.search({
      collectionId: args.rawCollectionId,
      queryVector: args.queryVector,
      topK: args.topK,
      mode: args.mode,
      queryText: args.queryText,
      filters: args.filters,
      explain: args.explain,
    });

    let semanticResults: AkiSearchResult[] = [];
    try {
      const semResult = await args.db.search({
        collectionId: args.semanticCollectionId,
        queryVector: args.queryVector,
        topK: args.topK,
        mode: args.mode,
        queryText: args.queryText,
        filters: args.filters,
        explain: args.explain,
      });
      semanticResults = semResult.results;
    } catch {
      args.warn?.(`Warning: semantic collection "${args.semanticCollectionId}" not found — falling back to raw-only results`);
    }

    const metadata = resolveSearchMetadata(
      args.dataRoot,
      [...rawResult.results.map((result) => result.chunkId), ...semanticResults.map((result) => result.chunkId)],
      args.warn,
    );

    type ScoredEntry = {
      chunkId: string;
      rrfScore: number;
      collection: string;
      originalResult: AkiSearchResult;
      matchedLayers: Array<"raw" | "semantic">;
      rawChunkId?: string;
      semanticChunkId?: string;
    };

    const byDedupeKey = new Map<string, ScoredEntry>();
    const applyRrf = (results: AkiSearchResult[], collection: string): void => {
      results.forEach((result, idx) => {
        const rank = idx + 1;
        const rrfContrib = 1 / (60 + rank);
        const dedupeKey = metadata.get(result.chunkId)?.dedupeKey ?? result.chunkId;
        const existing = byDedupeKey.get(dedupeKey);
        if (existing) {
          existing.rrfScore += rrfContrib;
          if (existing.collection !== collection) {
            existing.collection = "raw+semantic";
          }
          if (!existing.matchedLayers.includes(collection as "raw" | "semantic")) {
            existing.matchedLayers.push(collection as "raw" | "semantic");
          }
          if (collection === "raw") {
            existing.rawChunkId = result.chunkId;
          } else {
            existing.semanticChunkId = result.chunkId;
          }
        } else {
          byDedupeKey.set(dedupeKey, {
            chunkId: result.chunkId,
            rrfScore: rrfContrib,
            collection,
            originalResult: result,
            matchedLayers: [collection as "raw" | "semantic"],
            rawChunkId: collection === "raw" ? result.chunkId : undefined,
            semanticChunkId: collection === "semantic" ? result.chunkId : undefined,
          });
        }
      });
    };

    applyRrf(rawResult.results, "raw");
    applyRrf(semanticResults, "semantic");

    const fused = Array.from(byDedupeKey.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, args.topK);

    return {
      layer: "fused" as const,
      collectionId: "fused",
      manifestVersion: rawResult.manifestVersionUsed,
      results: fused.map((entry) => {
        const rendered = renderResult(entry.originalResult, metadata);
        return {
          ...rendered,
          score: entry.rrfScore,
          collection: entry.collection,
          matchedLayers: entry.matchedLayers,
          provenanceChunkId: metadata.get(entry.semanticChunkId ?? entry.rawChunkId ?? entry.chunkId)?.dedupeKey ?? rendered.provenanceChunkId,
          semanticTitle: metadata.get(entry.semanticChunkId ?? "")?.title ?? rendered.semanticTitle,
          semanticQualityScore: metadata.get(entry.semanticChunkId ?? "")?.semanticQualityScore ?? rendered.semanticQualityScore,
          explain: mergeExplainInfo(entry, metadata),
        };
      }),
    };
  })();
}

function renderResult(
  result: AkiSearchResult,
  metadata: Map<string, SearchResultMetadata>,
): RenderedSearchResult {
  const meta = metadata.get(result.chunkId);
  return {
    chunkId: result.chunkId,
    score: result.score,
    sourcePath: meta?.sourcePath ?? null,
    contentType: meta?.contentType ?? null,
    explain: result.explain ?? null,
    matchedLayers: result.chunkId.startsWith("semantic:") ? ["semantic"] : ["raw"],
    provenanceChunkId: meta?.dedupeKey ?? result.chunkId,
    semanticTitle: meta?.title,
    semanticQualityScore: meta?.semanticQualityScore,
  };
}

function resolveRetrievalLayer(args: {
  requestedLayer: "auto" | "raw" | "semantic" | "fused";
  defaultLayer: "auto" | "raw" | "semantic" | "fused";
  dataRoot: string;
  semanticCollectionId: string;
  db: AkiDB;
  warn?: (message: string) => void;
}): "raw" | "semantic" | "fused" {
  const desired = args.requestedLayer === "auto" ? args.defaultLayer : args.requestedLayer;
  if (desired === "raw") return "raw";

  const semanticReady = hasPublishedSemanticCollection(args.dataRoot, args.semanticCollectionId)
    && hasCollection(args.db, args.semanticCollectionId);

  if (desired === "semantic" || desired === "fused") {
    if (!semanticReady) {
      args.warn?.(`Warning: semantic collection "${args.semanticCollectionId}" is not ready — falling back to raw retrieval`);
      return "raw";
    }
    return desired;
  }

  return semanticReady ? "fused" : "raw";
}

function hasCollection(db: AkiDB, collectionId: string): boolean {
  try {
    db.getCollection(collectionId);
    return true;
  } catch {
    return false;
  }
}

function hasPublishedSemanticCollection(dataRoot: string, semanticCollectionId: string): boolean {
  const semanticDbPath = join(dataRoot, "semantic.db");
  if (!existsSync(semanticDbPath)) {
    return false;
  }

  try {
    const store = new SemanticStore(semanticDbPath);
    try {
      return store.hasPublishedCollection(semanticCollectionId);
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

function resolveSearchMetadata(
  dataRoot: string,
  chunkIds: string[],
  warn?: (message: string) => void,
): Map<string, SearchResultMetadata> {
  const metadata = new Map<string, SearchResultMetadata>();
  if (chunkIds.length === 0) {
    return metadata;
  }

  const remaining = new Set(chunkIds);

  const registryDbPath = join(dataRoot, "registry.db");
  try {
    const registry = new JobRegistry(registryDbPath);
    try {
      for (const [chunkId, value] of buildChunkIndex(registry, remaining)) {
        metadata.set(chunkId, value);
        remaining.delete(chunkId);
        if (remaining.size === 0) {
          break;
        }
      }
    } finally {
      registry.close();
    }
  } catch (err) {
    warn?.(`Warning: could not load registry (source paths will be missing): ${err instanceof Error ? err.message : String(err)}`);
  }

  const semanticDbPath = join(dataRoot, "semantic.db");
  if (!existsSync(semanticDbPath)) {
    return metadata;
  }

  try {
    const store = new SemanticStore(semanticDbPath);
    try {
      for (const chunkId of Array.from(remaining)) {
        const lookup = store.getPublishedUnitLookup(chunkId);
        if (!lookup) continue;
        setSemanticLookup(metadata, lookup);
        remaining.delete(chunkId);
      }
    } finally {
      store.close();
    }
  } catch (err) {
    warn?.(`Warning: could not load semantic store (semantic source paths will be missing): ${err instanceof Error ? err.message : String(err)}`);
  }

  return metadata;
}

function buildChunkIndex(
  registry: JobRegistry,
  chunkIds?: Set<string>,
): Map<string, SearchResultMetadata> {
  const map = new Map<string, SearchResultMetadata>();
  const files = registry.listFiles();

  for (const file of files) {
    for (const chunkId of file.chunkIds) {
      if (chunkIds && !chunkIds.has(chunkId)) {
        continue;
      }
      map.set(chunkId, {
        sourcePath: file.sourcePath,
        contentType: guessContentType(file.sourcePath),
        dedupeKey: chunkId,
      });
    }
  }

  return map;
}

function setSemanticLookup(
  metadata: Map<string, SearchResultMetadata>,
  lookup: SemanticUnitLookup,
): void {
  metadata.set(lookup.chunkId, {
    sourcePath: lookup.sourcePath,
    contentType: lookup.contentType,
    dedupeKey: lookup.dedupeKey,
    title: lookup.title,
    semanticQualityScore: lookup.qualityScore,
  });
}

function mergeExplainInfo(
  entry: {
    originalResult: AkiSearchResult;
    rrfScore: number;
    matchedLayers: Array<"raw" | "semantic">;
    chunkId: string;
    semanticChunkId?: string;
  },
  metadata: Map<string, SearchResultMetadata>,
): ExplainInfo | null | undefined {
  const base = entry.originalResult.explain ? { ...entry.originalResult.explain } : undefined;
  if (!base) {
    return base;
  }
  base.rrfScore = entry.rrfScore;
  const meta = metadata.get(entry.semanticChunkId ?? entry.chunkId);
  const previewExtras = [
    entry.matchedLayers.length > 1 ? `matched_layers=${entry.matchedLayers.join("+")}` : null,
    meta?.semanticQualityScore !== undefined ? `semantic_quality=${meta.semanticQualityScore.toFixed(2)}` : null,
    meta?.title ? `semantic_title=${meta.title}` : null,
  ].filter((value): value is string => value !== null);
  if (previewExtras.length > 0) {
    base.matchedTerms = Array.from(new Set([...(base.matchedTerms ?? []), ...previewExtras]));
  }
  return base;
}

function guessContentType(sourcePath: string): string {
  const ext = sourcePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "txt", md: "md", markdown: "md", pdf: "pdf", docx: "docx", pptx: "pptx",
    xlsx: "xlsx", csv: "csv", tsv: "tsv", json: "json", jsonl: "jsonl",
    yaml: "yaml", yml: "yaml", html: "html", htm: "html", rtf: "rtf",
    sql: "sql", log: "log",
  };
  return map[ext] ?? "unknown";
}

function validateContentType(value: string): void {
  const valid = ["txt", "md", "pdf", "docx", "pptx", "xlsx", "csv", "tsv", "json", "jsonl", "yaml", "html", "rtf", "sql", "log"];
  if (!valid.includes(value)) {
    throw new Error(`--content-type must be one of: ${valid.join(", ")}`);
  }
}

function validateChunkLabel(value: string): void {
  if (!["paragraph", "heading", "table", "code", "list", "text"].includes(value)) {
    throw new Error("--chunk-label must be one of: paragraph, heading, table, code, list, text");
  }
}
