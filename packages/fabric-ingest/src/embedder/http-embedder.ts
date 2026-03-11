/**
 * HTTP embedder — calls a remote OpenAI-compatible /v1/embeddings endpoint.
 *
 * Supports batching, timeouts, and Bearer-token authentication.
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { EmbedderProvider } from "@ax-fabric/contracts";

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;

export interface HttpEmbedderOptions {
  /**
   * Base URL of the embedding service (e.g. "https://api.openai.com")
   * or full embeddings endpoint (e.g. ".../v1/embeddings").
   */
  baseUrl: string;
  /** Model identifier sent in the request body. */
  modelId: string;
  /** Embedding dimension expected from the model. */
  dimension: number;
  /** Bearer token.  Falls back to the EMBEDDING_API_KEY env var. */
  apiKey?: string;
  /** Maximum number of texts per HTTP request.  Default: 64. */
  batchSize?: number;
  /** Request timeout in milliseconds.  Default: 30 000. */
  timeoutMs?: number;
  /** Maximum number of in-flight HTTP requests at once.  Default: 4. */
  maxConcurrency?: number;
}

/** Shape of a single embedding object in the OpenAI response. */
interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

/** Top-level shape of the OpenAI /v1/embeddings response. */
interface EmbeddingResponse {
  data: EmbeddingResponseItem[];
}

export class HttpEmbedder implements EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;

  constructor(options: HttpEmbedderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.modelId = options.modelId;
    this.dimension = options.dimension;
    this.apiKey = options.apiKey ?? process.env["EMBEDDING_API_KEY"];
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * Embed one or more texts by calling the remote API.
   *
   * Texts are split into batches of `batchSize` and dispatched in parallel
   * windows of up to `maxConcurrency` in-flight requests.  Results are
   * reassembled in original order.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batches = splitIntoBatches(texts, this.batchSize);
    const results: number[][][] = new Array(batches.length) as number[][][];

    for (let i = 0; i < batches.length; i += this.maxConcurrency) {
      const window = batches.slice(i, i + this.maxConcurrency);
      const windowResults = await Promise.all(window.map((batch) => this.callApi(batch)));
      for (let j = 0; j < windowResults.length; j++) {
        results[i + j] = windowResults[j]!;
      }
    }

    return results.flat();
  }

  /** POST a single batch to the /v1/embeddings endpoint. */
  private async callApi(texts: string[]): Promise<number[][]> {
    const url = this.baseUrl.endsWith("/v1/embeddings")
      ? this.baseUrl
      : `${this.baseUrl}/v1/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body = JSON.stringify({
      input: texts,
      model: this.modelId,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `Embedding request to ${url} failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new AxFabricError(
        "EMBED_ERROR",
        `Embedding API returned HTTP ${String(response.status)}: ${text}`,
      );
    }

    let json: EmbeddingResponse;
    try {
      json = (await response.json()) as EmbeddingResponse;
    } catch (err) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "Failed to parse embedding API response as JSON",
        err,
      );
    }

    if (!json || !Array.isArray(json.data)) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "Embedding API response missing or invalid data array",
      );
    }
    // Sort by index to guarantee correct ordering.
    // Distinguish two valid cases:
    //   - All items have an index field  → sort by it.
    //   - No items have an index field   → trust positional order.
    // A partial mix (some have index, some don't) means we cannot reliably
    // reconstruct the original order, so we reject the response.
    const hasAnyIndex = json.data.some((d: { index?: unknown }) => typeof d.index === "number");
    const hasAllIndex = json.data.every((d: { index?: unknown }) => typeof d.index === "number");
    if (hasAnyIndex && !hasAllIndex) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "Embedding API response has partial index fields — cannot guarantee order",
      );
    }
    const sorted = hasAllIndex
      ? [...json.data].sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      : json.data;
    if (sorted.length !== texts.length) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `Embedding API returned ${String(sorted.length)} embeddings for ${String(texts.length)} texts`,
      );
    }
    return sorted.map((item) => {
      if (item.embedding.length !== this.dimension) {
        throw new AxFabricError(
          "EMBED_ERROR",
          `Embedding API returned vector of dimension ${String(item.embedding.length)}, expected ${String(this.dimension)}`,
        );
      }
      return item.embedding;
    });
  }
}

/** Split an array into batches of at most `size` elements. */
function splitIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
