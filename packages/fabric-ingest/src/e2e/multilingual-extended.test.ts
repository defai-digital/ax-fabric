/**
 * Extended Multilingual Ingestion & Search Test
 *
 * Tests 10 languages across 4 script families to verify AkiDB correctly
 * stores and searches multilingual content:
 *
 * - CJK (no word boundaries): Japanese, Korean, Chinese
 * - Latin (with diacritics):   French, German, English, Vietnamese
 * - Devanagari:                Hindi
 * - Cyrillic:                  Russian
 * - Thai script (no spaces):   Thai
 *
 * Run:
 *   npx vitest run packages/fabric-ingest/src/e2e/multilingual-extended.test.ts
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
const COLLECTION_ID = "multilingual-extended";
const DIMENSION = 128;
const MODEL_ID = "mock-embed-v1";

/** Language test definitions grouped by script family. */
const LANGUAGES = [
  // ── CJK (trigram fallback needed) ────────────────────────────────────────
  {
    code: "ja",
    label: "Japanese",
    file: "udhr-japanese.pdf",
    script: "CJK",
    // Query matching actual extracted text
    vectorQuery: "すべての人間は、生まれながらにして自由であり",
    keywordQuery: "生まれながらにして自由",
    uniqueToken: "世界人権宣言",
  },
  {
    code: "ko",
    label: "Korean",
    file: "udhr-korean.pdf",
    script: "CJK",
    vectorQuery: "모든 인류 구성원의 천부의 존엄성과 동등하고",
    keywordQuery: "구성원의 존엄성과 동등하고",
    uniqueToken: "세계인권선언",
  },
  {
    code: "zh",
    label: "Chinese",
    file: "udhr-chinese.pdf",
    script: "CJK",
    // Chinese PDF has spaces between every character from pdf-parse extraction
    vectorQuery: "人人生而自由在尊严和权利上一律平等",
    keywordQuery: "世 界 人 权 宣 言",
    uniqueToken: "世 界 人 权 宣 言",
  },

  // ── Latin (unicode61 works) ──────────────────────────────────────────────
  {
    code: "fr",
    label: "French",
    file: "udhr-french.pdf",
    script: "Latin",
    vectorQuery: "Tous les êtres humains naissent libres et égaux en dignité",
    keywordQuery: "droits liberté égalité",
    uniqueToken: "Déclaration universelle",
  },
  {
    code: "de",
    label: "German",
    file: "udhr-german.pdf",
    script: "Latin",
    vectorQuery: "Alle Menschen sind frei und gleich an Würde und Rechten geboren",
    keywordQuery: "Menschenrechte Freiheit",
    uniqueToken: "Allgemeine Erklärung",
  },
  {
    code: "en",
    label: "English",
    file: "gwu-deng-student-guidelines.pdf",
    script: "Latin",
    vectorQuery: "student guidelines requirements graduation",
    keywordQuery: "student program requirements",
    uniqueToken: "GWU",
  },
  {
    code: "vi",
    label: "Vietnamese",
    file: "udhr-vietnamese.txt",
    script: "Latin",
    vectorQuery: "Tất cả mọi người sinh ra đều được tự do và bình đẳng",
    keywordQuery: "nhân quyền tự do bình đẳng",
    uniqueToken: "Tuyên ngôn",
  },

  // ── Devanagari (unicode61 should work — has spaces) ──────────────────────
  {
    code: "hi",
    label: "Hindi",
    file: "udhr-hindi.txt",
    script: "Devanagari",
    vectorQuery: "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतंत्रता",
    keywordQuery: "मानव अधिकारों स्वतंत्रता",
    uniqueToken: "सार्वभौम घोषणा",
  },

  // ── Cyrillic (unicode61 should work — has spaces) ────────────────────────
  {
    code: "ru",
    label: "Russian",
    file: "udhr-russian.pdf",
    script: "Cyrillic",
    vectorQuery: "Все люди рождаются свободными и равными в своём достоинстве и правах",
    keywordQuery: "свободными достоинстве правах",
    uniqueToken: "Всеобщая декларация",
  },

  // ── Thai script (no word boundaries — trigram fallback needed) ───────────
  {
    code: "th",
    label: "Thai",
    file: "udhr-thai.txt",
    script: "Thai",
    vectorQuery: "มนุษย์ทั้งหลายเกิดมามีอิสระและเสมอภาคกัน",
    keywordQuery: "สิทธิมนุษยชน",
    uniqueToken: "ปฏิญญาสากล",
  },
];

// ─── Test Suite ──────────────────────────────────────────────────────────────

const allFilesPresent = LANGUAGES.every((lang) => existsSync(join(DATA_DIR, lang.file)));

describe.skipIf(!allFilesPresent)("Extended Multilingual Search (10 languages)", () => {
  let storageDir: string;
  let registryDir: string;
  let akidb: AkiDB;
  let embedder: MockEmbedder;
  let pipeline: Pipeline;
  let metrics: PipelineMetrics;

  beforeAll(async () => {

    storageDir = mkdtempSync(join(tmpdir(), "ml-ext-store-"));
    registryDir = mkdtempSync(join(tmpdir(), "ml-ext-reg-"));

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

  it("ingests all 10 files without errors", () => {
    console.log(
      `\n  Ingested ${metrics.filesSucceeded}/${metrics.filesScanned} files → ` +
        `${metrics.recordsGenerated} chunks in ${metrics.durationMs}ms`,
    );
    if (metrics.errors.length > 0) {
      for (const e of metrics.errors) {
        console.log(`  ERROR: ${e.sourcePath}: ${e.message}`);
      }
    }
    expect(metrics.filesScanned).toBe(21);
    expect(metrics.filesSucceeded).toBe(21);
    expect(metrics.filesFailed).toBe(0);
    expect(metrics.errors).toHaveLength(0);
    expect(metrics.recordsGenerated).toBeGreaterThan(0);
  });

  // ── 2. Vector search per language ────────────────────────────────────────

  describe("vector search", () => {
    for (const lang of LANGUAGES) {
      it(`[${lang.script}] ${lang.label}: returns results for native query`, async () => {
        const vecs = await embedder.embed([lang.vectorQuery]);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
        });

        expect(result.results.length).toBeGreaterThan(0);
        console.log(
          `    ${lang.label.padEnd(12)} vector: top-1=${result.results[0]!.score.toFixed(4)}, hits=${result.results.length}`,
        );
      });
    }
  });

  // ── 3. Keyword search per language ───────────────────────────────────────

  describe("keyword search (BM25 + trigram fallback)", () => {
    for (const lang of LANGUAGES) {
      it(`[${lang.script}] ${lang.label}: keyword search returns results`, async () => {
        const dummyVec = new Float32Array(DIMENSION);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.keywordQuery,
        });

        console.log(
          `    ${lang.label.padEnd(12)} keyword "${lang.keywordQuery}": hits=${result.results.length}`,
        );

        // All languages should return results with properly matched queries
        expect(result.results.length).toBeGreaterThan(0);
      });
    }
  });

  // ── 4. Unique token keyword search ───────────────────────────────────────

  describe("unique token keyword search", () => {
    for (const lang of LANGUAGES) {
      it(`[${lang.script}] ${lang.label}: unique token "${lang.uniqueToken}" found`, async () => {
        const dummyVec = new Float32Array(DIMENSION);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.uniqueToken,
        });

        console.log(
          `    ${lang.label.padEnd(12)} unique "${lang.uniqueToken}": hits=${result.results.length}`,
        );

        expect(result.results.length).toBeGreaterThan(0);
      });
    }
  });

  // ── 5. Hybrid search per language ────────────────────────────────────────

  describe("hybrid search", () => {
    for (const lang of LANGUAGES) {
      it(`[${lang.script}] ${lang.label}: hybrid search returns results`, async () => {
        const vecs = await embedder.embed([lang.vectorQuery]);
        const result = await akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
          mode: "hybrid",
          queryText: lang.keywordQuery,
        });

        expect(result.results.length).toBeGreaterThan(0);
        console.log(
          `    ${lang.label.padEnd(12)} hybrid: top-1=${result.results[0]!.score.toFixed(4)}, hits=${result.results.length}`,
        );
      });
    }
  });

  // ── 6. Cross-script isolation ────────────────────────────────────────────

  describe("cross-script isolation", () => {
    const pairs = [
      { a: "ja", b: "ru" },  // CJK vs Cyrillic
      { a: "th", b: "de" },  // Thai vs Latin
      { a: "hi", b: "ko" },  // Devanagari vs CJK
      { a: "vi", b: "zh" },  // Latin-diacritics vs CJK
      { a: "fr", b: "th" },  // Latin vs Thai
    ];

    for (const pair of pairs) {
      const langA = LANGUAGES.find((l) => l.code === pair.a)!;
      const langB = LANGUAGES.find((l) => l.code === pair.b)!;

      it(`${langA.label} (${langA.script}) vs ${langB.label} (${langB.script}) → different top results`, async () => {
        const [vecsA, vecsB] = await Promise.all([
          embedder.embed([langA.vectorQuery]),
          embedder.embed([langB.vectorQuery]),
        ]);
        const [resultA, resultB] = await Promise.all([
          akidb.search({
            collectionId: COLLECTION_ID,
            queryVector: new Float32Array(vecsA[0]!),
            topK: 3,
          }),
          akidb.search({
            collectionId: COLLECTION_ID,
            queryVector: new Float32Array(vecsB[0]!),
            topK: 3,
          }),
        ]);

        expect(resultA.results.length).toBeGreaterThan(0);
        expect(resultB.results.length).toBeGreaterThan(0);
        expect(resultA.results[0]!.chunkId).not.toBe(resultB.results[0]!.chunkId);

        console.log(
          `    ${langA.label} top-1: ${resultA.results[0]!.chunkId.slice(0, 12)}… ≠ ` +
            `${langB.label} top-1: ${resultB.results[0]!.chunkId.slice(0, 12)}…`,
        );
      });
    }
  });

  // ── 7. Summary report ──────────────────────────────────────────────────

  it("prints summary report", async () => {
    const rows: string[] = [];

    for (const lang of LANGUAGES) {
      const vecs = await embedder.embed([lang.vectorQuery]);
      const dummyVec = new Float32Array(DIMENSION);

      const [vecR, kwR, hyR, uniqR] = await Promise.all([
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
          queryText: lang.keywordQuery,
        }),
        akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: new Float32Array(vecs[0]!),
          topK: 5,
          mode: "hybrid",
          queryText: lang.keywordQuery,
        }),
        akidb.search({
          collectionId: COLLECTION_ID,
          queryVector: dummyVec,
          topK: 5,
          mode: "keyword",
          queryText: lang.uniqueToken,
        }),
      ]);

      const vec = vecR.results.length > 0 ? "OK" : "FAIL";
      const kw = kwR.results.length > 0 ? "OK" : "FAIL";
      const hy = hyR.results.length > 0 ? "OK" : "FAIL";
      const un = uniqR.results.length > 0 ? "OK" : "FAIL";

      rows.push(
        `║  ${lang.label.padEnd(12)} │ ${lang.script.padEnd(10)} │ ${vec.padEnd(6)} │ ${kw.padEnd(7)} │ ${hy.padEnd(6)} │ ${un.padEnd(6)} ║`,
      );
    }

    const report = [
      "",
      "╔══════════════════════════════════════════════════════════════════════════╗",
      "║              Extended Multilingual Search Summary (10 languages)        ║",
      "╠══════════════════════════════════════════════════════════════════════════╣",
      `║  Files ingested:  ${String(metrics.filesSucceeded).padEnd(53)}║`,
      `║  Total chunks:    ${String(metrics.recordsGenerated).padEnd(53)}║`,
      `║  Ingestion time:  ${(metrics.durationMs + "ms").padEnd(53)}║`,
      "╠══════════════════════════════════════════════════════════════════════════╣",
      "║  Language     │ Script     │ Vector │ Keyword │ Hybrid │ Unique ║",
      "╠══════════════════════════════════════════════════════════════════════════╣",
      ...rows,
      "╚══════════════════════════════════════════════════════════════════════════╝",
      "",
    ];

    console.log(report.join("\n"));
  });
});
