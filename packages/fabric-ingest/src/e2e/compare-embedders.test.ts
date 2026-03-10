/**
 * Compare Qwen3 0.6B vs BGE-M3 embedding quality on the same dataset.
 *
 * Instead of the full pipeline (which stores chunks with opaque IDs and
 * no metadata in search results), this test embeds documents directly
 * and builds the AkiDB index manually, so we can track which chunk ID
 * maps to which source file.
 *
 * Run: CLOUDFLARE_API_TOKEN=<token> npx vitest run packages/fabric-ingest/src/e2e/compare-embedders.test.ts
 */

import { describe, it, expect } from "vitest";
import { CloudflareEmbedder } from "../embedder/cloudflare-embedder.js";

const ACCOUNT_ID = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
const TOKEN = process.env["CLOUDFLARE_API_TOKEN"]!;
const HAS_TOKEN = !!process.env["CLOUDFLARE_API_TOKEN"];

const docs = [
  { name: "typescript.txt", content: "TypeScript is a strongly typed programming language that builds on JavaScript. It adds optional static typing, classes, and interfaces. TypeScript compiles to plain JavaScript and runs in any browser or Node.js environment." },
  { name: "rust.txt", content: "Rust is a systems programming language focused on safety, speed, and concurrency. It achieves memory safety without garbage collection through its ownership system and borrow checker." },
  { name: "python.txt", content: "Python is a high-level interpreted programming language known for its readability and simplicity. It is widely used in data science, machine learning, artificial intelligence, and web development." },
  { name: "cooking.txt", content: "The art of French cooking involves mastering fundamental techniques like sautéing, braising, and making sauces. A classic béchamel sauce starts with a roux of butter and flour, then slowly incorporating warm milk." },
  { name: "astronomy.txt", content: "The James Webb Space Telescope launched in December 2021 and observes in infrared wavelengths. It can peer through cosmic dust clouds and detect light from galaxies formed shortly after the Big Bang." },
];

const queries = [
  { text: "Rust ownership borrow checker memory safety", expected: "rust.txt" },
  { text: "TypeScript static typing compiles to JavaScript", expected: "typescript.txt" },
  { text: "Python data science machine learning AI", expected: "python.txt" },
  { text: "French cooking béchamel sauce roux butter", expected: "cooking.txt" },
  { text: "James Webb Space Telescope infrared galaxies Big Bang", expected: "astronomy.txt" },
  { text: "quantum physics string theory dark matter", expected: "(unrelated)" },
];

interface ModelConfig {
  id: string;
  dim: number;
  label: string;
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function runModel(model: ModelConfig) {
  const embedder = new CloudflareEmbedder({
    accountId: ACCOUNT_ID,
    modelId: model.id,
    dimension: model.dim,
    apiToken: TOKEN,
  });

  // Embed all documents
  const t0 = performance.now();
  const docTexts = docs.map((d) => d.content);
  const docVectors = await embedder.embed(docTexts);
  const embedDocMs = performance.now() - t0;

  console.log(`\n  [${model.label}] Embedded ${docs.length} docs in ${embedDocMs.toFixed(0)}ms`);

  // Run queries
  const results: Array<{
    query: string;
    expected: string;
    topFile: string;
    score: number;
    correct: boolean;
  }> = [];

  for (const q of queries) {
    const queryVecs = await embedder.embed([q.text]);
    const queryVec = queryVecs[0]!;

    // Compute cosine similarity to each doc
    const scores = docs.map((doc, i) => ({
      name: doc.name,
      score: cosineSimilarity(queryVec, docVectors[i]!),
    }));

    // Sort by descending score
    scores.sort((a, b) => b.score - a.score);

    const top = scores[0]!;
    const isUnrelated = q.expected === "(unrelated)";
    const correct = isUnrelated ? top.score < 0.5 : top.name === q.expected;

    results.push({
      query: q.text,
      expected: q.expected,
      topFile: top.name,
      score: top.score,
      correct,
    });
  }

  return results;
}

describe.skipIf(!HAS_TOKEN)("Embedding Model Comparison", () => {
  const qwen: ModelConfig = { id: "@cf/qwen/qwen3-embedding-0.6b", dim: 1024, label: "Qwen3 0.6B" };
  const bge: ModelConfig = { id: "@cf/baai/bge-m3", dim: 1024, label: "BGE-M3" };

  it("Qwen3 0.6B vs BGE-M3 side-by-side", async () => {
    const [qwenResults, bgeResults] = await Promise.all([
      runModel(qwen),
      runModel(bge),
    ]);

    console.log("\n  ┌─────────────────────────────────────────────────────────────────────────────────────┐");
    console.log("  │                     EMBEDDING MODEL COMPARISON                                      │");
    console.log("  ├──────────────────────────────────────────────┬────────────────────┬─────────────────┤");
    console.log("  │ Query                                        │ Qwen3 0.6B         │ BGE-M3          │");
    console.log("  ├──────────────────────────────────────────────┼────────────────────┼─────────────────┤");

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      const qr = qwenResults[i]!;
      const br = bgeResults[i]!;
      const label = q.text.slice(0, 44).padEnd(44);
      const qScore = `${qr.score.toFixed(4)} ${qr.correct ? "ok" : "WRONG"}`;
      const bScore = `${br.score.toFixed(4)} ${br.correct ? "ok" : "WRONG"}`;
      console.log(`  | ${label} | ${qScore.padEnd(18)} | ${bScore.padEnd(15)} |`);
      if (!qr.correct || !br.correct) {
        console.log(`  |   -> Q: got ${qr.topFile.padEnd(18)} B: got ${br.topFile.padEnd(20)}|`);
      }
    }

    console.log("  ├──────────────────────────────────────────────┼────────────────────┼─────────────────┤");

    const qwenAvg = qwenResults.slice(0, 5).reduce((s, r) => s + r.score, 0) / 5;
    const bgeAvg = bgeResults.slice(0, 5).reduce((s, r) => s + r.score, 0) / 5;
    const qwenCorrect = qwenResults.filter(r => r.correct).length;
    const bgeCorrect = bgeResults.filter(r => r.correct).length;

    console.log(`  | Avg score (topic queries)                    | ${qwenAvg.toFixed(4).padEnd(18)} | ${bgeAvg.toFixed(4).padEnd(15)} |`);
    console.log(`  | Accuracy                                     | ${(qwenCorrect + "/" + queries.length).padEnd(18)} | ${(bgeCorrect + "/" + queries.length).padEnd(15)} |`);
    console.log("  └──────────────────────────────────────────────┴────────────────────┴─────────────────┘");

    const winner = bgeAvg > qwenAvg ? "BGE-M3" : "Qwen3 0.6B";
    const delta = Math.abs(bgeAvg - qwenAvg);
    console.log(`\n  Winner: ${winner} (+${(delta * 100).toFixed(1)}% avg score)`);

    // Both should get most correct top results
    expect(qwenCorrect).toBeGreaterThanOrEqual(4);
    expect(bgeCorrect).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
