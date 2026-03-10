/**
 * Mock embedder for testing — produces deterministic vectors from text content.
 *
 * Uses SHA-256 to hash the input text and seeds a deterministic vector
 * from the hash bytes.  Same text always produces the same vector.
 */

import { createHash } from "node:crypto";

import type { EmbedderProvider } from "@ax-fabric/contracts";

const DEFAULT_MODEL_ID = "mock-embed-v1";
const DEFAULT_DIMENSION = 128;

export interface MockEmbedderOptions {
  modelId?: string;
  dimension?: number;
}

export class MockEmbedder implements EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;

  constructor(options?: MockEmbedderOptions) {
    this.modelId = options?.modelId ?? DEFAULT_MODEL_ID;
    this.dimension = options?.dimension ?? DEFAULT_DIMENSION;
  }

  /**
   * Generate deterministic embedding vectors for the given texts.
   *
   * Each text is hashed with SHA-256 and the hash bytes are used to
   * produce a float vector of the configured dimension, then L2-normalised.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.deterministicVector(text));
  }

  /** Build a deterministic, normalised vector from a text string. */
  private deterministicVector(text: string): number[] {
    const hash = createHash("sha256").update(text, "utf8").digest();
    const vector: number[] = [];

    for (let i = 0; i < this.dimension; i++) {
      // Cycle through hash bytes (32 bytes) and convert to [-1, 1]
      const byte = hash[i % hash.length]!;
      vector.push((byte / 255) * 2 - 1);
    }

    return normalise(vector);
  }
}

/** L2-normalise a vector in place and return it. */
function normalise(vector: number[]): number[] {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);

  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i]! / norm;
  }
  return vector;
}
