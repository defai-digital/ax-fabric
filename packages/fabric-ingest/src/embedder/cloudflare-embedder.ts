/**
 * Cloudflare Workers AI embedder — calls the Cloudflare AI embedding API.
 *
 * Endpoint format:
 *   POST /client/v4/accounts/{accountId}/ai/run/{modelId}
 *   Body: { "text": ["hello", "world"] }
 *   Response: { "result": { "data": [[...], [...]], "shape": [N, dim] }, "success": true }
 *
 * Supports batching, timeouts, and Bearer-token authentication.
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { EmbedderProvider } from "@ax-fabric/contracts";

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;

export interface CloudflareEmbedderOptions {
  /** Cloudflare account ID. */
  accountId: string;
  /** Model identifier (e.g. "@cf/qwen/qwen3-embedding-0.6b"). */
  modelId: string;
  /** Embedding dimension expected from the model. */
  dimension: number;
  /** Cloudflare API token. Falls back to the CLOUDFLARE_API_TOKEN env var. */
  apiToken?: string;
  /** Maximum number of texts per HTTP request. Default: 64. */
  batchSize?: number;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /** Maximum number of in-flight HTTP requests at once. Default: 4. */
  maxConcurrency?: number;
}

/** Shape of the Cloudflare Workers AI embedding response. */
interface CloudflareEmbeddingResponse {
  result: {
    data: number[][];
    shape: number[];
  };
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
}

export class CloudflareEmbedder implements EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;

  private readonly accountId: string;
  private readonly apiToken: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;

  constructor(options: CloudflareEmbedderOptions) {
    this.accountId = options.accountId;
    this.modelId = options.modelId;
    this.dimension = options.dimension;
    this.apiToken = options.apiToken ?? process.env["CLOUDFLARE_API_TOKEN"];
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * Embed one or more texts by calling the Cloudflare Workers AI API.
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

  /** POST a single batch to the Cloudflare AI endpoint. */
  private async callApi(texts: string[]): Promise<number[][]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelId}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const body = JSON.stringify({ text: texts });

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
        `Cloudflare embedding request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new AxFabricError(
        "EMBED_ERROR",
        `Cloudflare AI API returned HTTP ${String(response.status)}: ${text}`,
      );
    }

    let json: CloudflareEmbeddingResponse;
    try {
      json = (await response.json()) as CloudflareEmbeddingResponse;
    } catch (err) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "Failed to parse Cloudflare AI response as JSON",
        err,
      );
    }

    if (!json || !json.success) {
      const errMsg = json?.errors
        ?.map((e) => `[${String(e.code)}] ${e.message}`)
        .join("; ") ?? "unknown Cloudflare error";
      throw new AxFabricError(
        "EMBED_ERROR",
        `Cloudflare AI returned errors: ${errMsg}`,
      );
    }

    if (!json.result?.data) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "Cloudflare AI returned success=true but result.data is missing",
      );
    }
    if (json.result.data.length !== texts.length) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `Cloudflare AI returned ${String(json.result.data.length)} embeddings for ${String(texts.length)} texts`,
      );
    }
    return json.result.data.map((vec) => {
      if (vec.length !== this.dimension) {
        throw new AxFabricError(
          "EMBED_ERROR",
          `Cloudflare AI returned vector of dimension ${String(vec.length)}, expected ${String(this.dimension)}`,
        );
      }
      return vec;
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
