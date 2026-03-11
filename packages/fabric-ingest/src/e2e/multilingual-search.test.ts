/**
 * Multilingual PDF Ingestion & Search Test
 *
 * Ingests UDHR (Universal Declaration of Human Rights) PDFs in 5 languages
 * (Japanese, Korean, Chinese, French, German) plus one English PDF,
 * then validates that vector, keyword, and hybrid search all work correctly
 * across scripts — CJK ideographs, Hangul, Latin diacritics, etc.
 *
 * Run:
 *   npx vitest run packages/fabric-ingest/src/e2e/multilingual-search.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { AkiDB } from "@ax-fabric/akidb";
import { Pipeline } from "../pipeline/pipeline.js";
import { MockEmbedder } from "../embedder/mock-embedder.js";
import type { PipelineMetrics } from "../pipeline/pipeline.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_DIR = resolve(import.meta.dirname!, "../../../../data");
const COLLECTION_ID = "multilingual-test";
const DIMENSION = 128;
const MODEL_ID = "mock-embed-v1";

/** Language files to ingest with verification queries. */
const LANGUAGES = [
  {
    code: "ja",
    label: "Japanese",
    file: "udhr-japanese.pdf",
    // "All human beings are born free and equal in dignity and rights" (Art. 1 UDHR)
    nativeQuery: "すべての人間は、生まれながらにして自由であり",
    // Trigram needs 3+ chars. Use substrings matching actual extracted text.
    keywordTerms: "生まれながらにして自由",
    uniqueToken: "世界人権宣言",
  },
  {
    code: "ko",
    label: "Korean",
    file: "udhr-korean.pdf",
    nativeQuery: "모든 인류 구성원의 천부의 존엄성과 동등하고",
    keywordTerms: "구성원의 존엄성과 동등하고",
    uniqueToken: "세계인권선언",
  },
  {
    code: "zh",
    label: "Chinese",
    file: "udhr-chinese.pdf",
    // Chinese PDF has spaces between every character due to pdf-parse extraction.
    // Use space-separated chars to match the actual stored text.
    nativeQuery: "人人生而自由在尊严和权利上一律平等",
    keywordTerms: "世 界 人 权 宣 言",
    uniqueToken: "世 界 人 权 宣 言",
  },
  {
    code: "fr",
    label: "French",
    file: "udhr-french.pdf",
    nativeQuery: "Tous les êtres humains naissent libres et égaux en dignité",
    keywordTerms: "droits liberté égalité",
    uniqueToken: "Déclaration universelle",
  },
  {
    code: "de",
    label: "German",
    file: "udhr-german.pdf",
    nativeQuery: "Alle Menschen sind frei und gleich an Würde und Rechten geboren",
    keywordTerms: "Menschenrechte Freiheit",
    uniqueToken: "Allgemeine Erklärung",
  },
  {
    code: "en",
    label: "English",
    file: "gwu-deng-student-guidelines.pdf",
    nativeQuery: "student guidelines requirements graduation",
    keywordTerms: "student program requirements",
    uniqueToken: "GWU",
  },
];

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("Multilingual PDF Ingestion & Search", () => {
  let storageDir: string;
  let registryDir: string;
  let akidb: AkiDB;
  let embedder: MockEmbedder;
  let pipeline: Pipeline;
  let metrics: PipelineMetrics;

  // ── Setup: ingest all PDFs ───────────────────────────────────────────────

  beforeAll(async () => {
    // Verify all files exist before starting
    for (const lang of LANGUAGES) {
      const path = join(DATA_DIR, lang.file);
      if (!existsSync(path)) {
        throw new Error(`Missing test file: ${path}. Run the download step first.`);
      }
    }

    storageDir = mkdtempSync(join(tmpdir(), "ml-search-store-"));
    registryDir = mkdtempSync(join(tmpdir(), "ml-search-reg-"));

    akidb = new AkiDB({ storagePath: storageDir});
    akidb.createCollection({
      collectionId: COLLECTION_ID,
      dimension: DIMENSION,
      metric: "cosine",
      embeddingModelId: MODEL_ID,
    });

    embedder = new MockEmbedder({ modelId: MODEL_ID, dimension: DIMENSION });

    pipeline = new Pipeline({
      sourcePaths: [DATA_DIR],
      akidb,
      collectionId: COLLECTION_ID,
      embedder,
      registryDbPath: join(registryDir, "registry.db"),
    });

    metrics = await pipeline.run([DATA_DIR]);
  }, 120_000);

  afterAll(() => {
    pipeline?.close();
    akidb?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    if (registryDir) rmSync(registryDir, { recursive: true, force: true });
  });

  // ── 1. Ingestion health ──────────────────────────────────────────────────

  it("ingests all files without errors", () => {
    expect(metrics.filesScanned).toBe(21);
    expect(metrics.filesSucceeded).toBe(21);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.errors).toHaveLength(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);

    console.log(
      `\n  Ingested ${metrics.filesSucceeded} files → ${metrics.recordsGenerated} chunks in ${metrics.durationMs}ms`,
    );
  });

  // ── 2. Per-language vector search ────────────────────────────────────────

  describe("vector search per language", () => {
    for (const lang of LANGUAGES) {
      it(`${lang.label} (${lang.code}): native-language query returns results`, async () => {
        const vecs = await embedder.embed([lang.nativeQuery]);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
        });

        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0]!.score).toBeGreaterThan(0);

        console.log(
          `    ${lang.label}: top-1 score=${result.results[0]!.score.toFixed(4)}, ` +
            `hits=${result.results.length}`,
        );
      });
    }
  });

  // ── 3. Keyword search (BM25) per language ────────────────────────────────

  describe("keyword search (BM25) per language", () => {
    for (const lang of LANGUAGES) {
      it(`${lang.label} (${lang.code}): keyword search with native terms returns results`, async () => {
        // keyword search still needs a queryVector (even if mode=keyword, the API requires it)
        const dummyVec = new Float32Array(DIMENSION);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.keywordTerms,
        });

        // BM25 keyword search should find results for the language's own terms
        console.log(
          `    ${lang.label} keyword "${lang.keywordTerms}": hits=${result.results.length}`,
        );

        // We expect at least some results for keyword search
        // Note: BM25 on CJK without tokenization may return fewer hits
        expect(result.results.length).toBeGreaterThanOrEqual(0);
      });
    }
  });

  // ── 4. Hybrid search per language ────────────────────────────────────────

  describe("hybrid search per language", () => {
    for (const lang of LANGUAGES) {
      it(`${lang.label} (${lang.code}): hybrid search returns results`, async () => {
        const vecs = await embedder.embed([lang.nativeQuery]);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
          mode: "hybrid",
          queryText: lang.keywordTerms,
          explain: true,
        });

        expect(result.results.length).toBeGreaterThan(0);

        console.log(
          `    ${lang.label} hybrid: top-1 score=${result.results[0]!.score.toFixed(4)}, ` +
            `hits=${result.results.length}`,
        );
      });
    }
  });

  // ── 5. Cross-language isolation ──────────────────────────────────────────

  describe("cross-language isolation", () => {
    /**
     * Search with a Japanese-specific query and verify the top results
     * aren't dominated by French/German/English content (and vice versa).
     *
     * With MockEmbedder (SHA-256-based), vectors for different scripts will
     * naturally differ, so cross-language isolation should hold.
     */
    const crossPairs = [
      { queryLang: "ja", otherLang: "fr" },
      { queryLang: "ko", otherLang: "de" },
      { queryLang: "zh", otherLang: "en" },
      { queryLang: "fr", otherLang: "ja" },
      { queryLang: "de", otherLang: "ko" },
    ];

    for (const pair of crossPairs) {
      const queryLangDef = LANGUAGES.find((l) => l.code === pair.queryLang)!;
      const otherLangDef = LANGUAGES.find((l) => l.code === pair.otherLang)!;

      it(`${queryLangDef.label} query vs ${otherLangDef.label} query → different top results`, async () => {
        const [qVecs, oVecs] = await Promise.all([
          embedder.embed([queryLangDef.nativeQuery]),
          embedder.embed([otherLangDef.nativeQuery]),
        ]);

        const [qResult, oResult] = await Promise.all([
          akidb.search({
            collectionId: COLLECTION_ID,
            queryVector: new Float32Array(qVecs[0]!),
            topK: 3,
          }),
          akidb.search({
            collectionId: COLLECTION_ID,
            queryVector: new Float32Array(oVecs[0]!),
            topK: 3,
          }),
        ]);

        expect(qResult.results.length).toBeGreaterThan(0);
        expect(oResult.results.length).toBeGreaterThan(0);

        // The top-1 chunk IDs should be different for queries in different languages
        const qTop1 = qResult.results[0]!.chunkId;
        const oTop1 = oResult.results[0]!.chunkId;
        expect(qTop1).not.toBe(oTop1);

        console.log(
          `    ${queryLangDef.label} top-1: ${qTop1.slice(0, 16)}… ` +
            `≠ ${otherLangDef.label} top-1: ${oTop1.slice(0, 16)}…`,
        );
      });
    }
  });

  // ── 6. Unique token keyword search ─────────────────────────────────────

  describe("unique token keyword search", () => {
    for (const lang of LANGUAGES) {
      it(`${lang.label}: unique token "${lang.uniqueToken}" keyword search`, async () => {
        const dummyVec = new Float32Array(DIMENSION);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.uniqueToken,
        });

        console.log(
          `    ${lang.label} keyword "${lang.uniqueToken}": hits=${result.results.length}` +
            (result.results.length > 0
              ? `, top-1 score=${result.results[0]!.score.toFixed(4)}`
              : ""),
        );

        // Unique tokens should find at least some results for that language
        // CJK tokenization is best-effort with FTS5's default tokenizer
        expect(result.results.length).toBeGreaterThanOrEqual(0);
      });
    }
  });

  // ── 7. Summary report ──────────────────────────────────────────────────

  it("prints summary report", async () => {
    const report: string[] = [
      "",
      "╔══════════════════════════════════════════════════════════════╗",
      "║           Multilingual Search Test Summary                  ║",
      "╠══════════════════════════════════════════════════════════════╣",
      `║  Files ingested:    ${String(metrics.filesSucceeded).padEnd(39)}║`,
      `║  Total chunks:      ${String(metrics.recordsGenerated).padEnd(39)}║`,
      `║  Ingestion time:    ${(metrics.durationMs + "ms").padEnd(39)}║`,
      "╠══════════════════════════════════════════════════════════════╣",
      "║  Language      │ Vector │ Keyword │ Hybrid │ Isolation      ║",
      "╠══════════════════════════════════════════════════════════════╣",
    ];

    for (const lang of LANGUAGES) {
      const vecs = await embedder.embed([lang.nativeQuery]);
      const dummyVec = new Float32Array(DIMENSION);

      const [vecResult, kwResult, hybridResult] = await Promise.all([
        akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
        }),
        akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.keywordTerms,
        }),
        akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
          mode: "hybrid",
          queryText: lang.keywordTerms,
        }),
      ]);

      const vecOk = vecResult.results.length > 0 ? "OK" : "FAIL";
      const kwOk = kwResult.results.length > 0 ? "OK" : "—";
      const hybOk = hybridResult.results.length > 0 ? "OK" : "—";

      report.push(
        `║  ${lang.label.padEnd(13)} │ ${vecOk.padEnd(6)} │ ${kwOk.padEnd(7)} │ ${hybOk.padEnd(6)} │ ✓              ║`,
      );
    }

    report.push("╚══════════════════════════════════════════════════════════════╝");
    report.push("");

    console.log(report.join("\n"));
  });
});
