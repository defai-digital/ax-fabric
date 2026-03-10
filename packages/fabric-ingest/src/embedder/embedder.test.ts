/**
 * Tests for Layer 2.5 — Embedder Providers.
 */

import { AxFabricError } from "@ax-fabric/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudflareEmbedder } from "./cloudflare-embedder.js";
import { HttpEmbedder } from "./http-embedder.js";
import { MockEmbedder } from "./mock-embedder.js";

// ─── MockEmbedder Tests ─────────────────────────────────────────────────────

describe("MockEmbedder", () => {
  it("uses default modelId and dimension", () => {
    const embedder = new MockEmbedder();
    expect(embedder.modelId).toBe("mock-embed-v1");
    expect(embedder.dimension).toBe(128);
  });

  it("respects custom options", () => {
    const embedder = new MockEmbedder({ modelId: "custom", dimension: 64 });
    expect(embedder.modelId).toBe("custom");
    expect(embedder.dimension).toBe(64);
  });

  it("produces vectors with the correct dimension", async () => {
    const embedder = new MockEmbedder({ dimension: 32 });
    const vectors = await embedder.embed(["hello world"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(32);
  });

  it("produces deterministic vectors for the same text", async () => {
    const embedder = new MockEmbedder();
    const [v1] = await embedder.embed(["foo"]);
    const [v2] = await embedder.embed(["foo"]);
    expect(v1).toEqual(v2);
  });

  it("produces different vectors for different texts", async () => {
    const embedder = new MockEmbedder();
    const [v1] = await embedder.embed(["alpha"]);
    const [v2] = await embedder.embed(["beta"]);
    expect(v1).not.toEqual(v2);
  });

  it("produces L2-normalised vectors (unit length)", async () => {
    const embedder = new MockEmbedder({ dimension: 64 });
    const [vector] = await embedder.embed(["normalisation test"]);
    const norm = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("handles multiple texts in a single call", async () => {
    const embedder = new MockEmbedder({ dimension: 16 });
    const vectors = await embedder.embed(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toHaveLength(16);
    }
  });

  it("returns empty array for empty input", async () => {
    const embedder = new MockEmbedder();
    const vectors = await embedder.embed([]);
    expect(vectors).toEqual([]);
  });
});

// ─── HttpEmbedder Tests ─────────────────────────────────────────────────────

describe("HttpEmbedder", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responseBody: unknown, status = 200): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response);
  }

  function makeEmbedder(overrides?: Partial<ConstructorParameters<typeof HttpEmbedder>[0]>) {
    return new HttpEmbedder({
      baseUrl: "https://api.example.com",
      modelId: "text-embedding-3-small",
      dimension: 4,
      apiKey: "test-key",
      ...overrides,
    });
  }

  it("sends correct request to /v1/embeddings", async () => {
    const responseData = {
      data: [
        { index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
      ],
    };
    mockFetch(responseData);

    const embedder = makeEmbedder();
    const result = await embedder.embed(["hello"]);

    expect(result).toEqual([[0.1, 0.2, 0.3, 0.4]]);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect(options.method).toBe("POST");

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body as string) as { input: string[]; model: string };
    expect(body.input).toEqual(["hello"]);
    expect(body.model).toBe("text-embedding-3-small");
  });

  it("orders results by index", async () => {
    // Simulate out-of-order response indices.
    const responseData = {
      data: [
        { index: 1, embedding: [0.5, 0.6, 0.7, 0.8] },
        { index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
      ],
    };
    mockFetch(responseData);

    const embedder = makeEmbedder();
    const result = await embedder.embed(["first", "second"]);

    expect(result[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result[1]).toEqual([0.5, 0.6, 0.7, 0.8]);
  });

  it("splits into batches when input exceeds batchSize", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 0, 0, 0] },
            { index: 1, embedding: [0, 1, 0, 0] },
          ],
        }),
        text: async () => "{}",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 0, embedding: [0, 0, 1, 0] },
          ],
        }),
        text: async () => "{}",
      } as Response);

    globalThis.fetch = fetchMock;

    const embedder = makeEmbedder({ batchSize: 2 });
    const result = await embedder.embed(["a", "b", "c"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([1, 0, 0, 0]);
    expect(result[2]).toEqual([0, 0, 1, 0]);
  });

  it("throws AxFabricError on HTTP error", async () => {
    mockFetch({ error: "bad request" }, 400);

    const embedder = makeEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("HTTP 400");
  });

  it("throws AxFabricError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const embedder = makeEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("network down");
  });

  it("throws AxFabricError on invalid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("bad json"); },
      text: async () => "not json",
    } as unknown as Response);

    const embedder = makeEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("parse");
  });

  it("returns empty array for empty input without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const embedder = makeEmbedder();
    const result = await embedder.embed([]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits Authorization header when no apiKey is set", async () => {
    const responseData = {
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    };
    mockFetch(responseData);

    // Clear env var to prevent fallback
    const saved = process.env["EMBEDDING_API_KEY"];
    delete process.env["EMBEDDING_API_KEY"];

    try {
      const embedder = makeEmbedder({ apiKey: undefined });
      await embedder.embed(["test"]);

      const fetchMockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [, options] = fetchMockFn.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    } finally {
      if (saved !== undefined) {
        process.env["EMBEDDING_API_KEY"] = saved;
      }
    }
  });

  it("strips trailing slashes from baseUrl", async () => {
    const responseData = {
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    };
    mockFetch(responseData);

    const embedder = makeEmbedder({ baseUrl: "https://api.example.com///" });
    await embedder.embed(["test"]);

    const fetchMockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = fetchMockFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
  });

  it("accepts full /v1/embeddings endpoint without double-appending", async () => {
    const responseData = {
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    };
    mockFetch(responseData);

    const embedder = makeEmbedder({ baseUrl: "https://api.example.com/v1/embeddings" });
    await embedder.embed(["test"]);

    const fetchMockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = fetchMockFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
  });
});

// ─── CloudflareEmbedder Tests ──────────────────────────────────────────────

describe("CloudflareEmbedder", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockCfFetch(responseBody: unknown, status = 200): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response);
  }

  function makeCloudflareEmbedder(
    overrides?: Partial<ConstructorParameters<typeof CloudflareEmbedder>[0]>,
  ) {
    return new CloudflareEmbedder({
      accountId: "test-account-id",
      modelId: "@cf/qwen/qwen3-embedding-0.6b",
      dimension: 4,
      apiToken: "test-token",
      ...overrides,
    });
  }

  it("sends correct request to Cloudflare AI endpoint", async () => {
    const responseData = {
      result: {
        data: [[0.1, 0.2, 0.3, 0.4]],
        shape: [1, 4],
      },
      success: true,
      errors: [],
      messages: [],
    };
    mockCfFetch(responseData);

    const embedder = makeCloudflareEmbedder();
    const result = await embedder.embed(["hello"]);

    expect(result).toEqual([[0.1, 0.2, 0.3, 0.4]]);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-id/ai/run/@cf/qwen/qwen3-embedding-0.6b",
    );
    expect(options.method).toBe("POST");

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body as string) as { text: string[] };
    expect(body.text).toEqual(["hello"]);
  });

  it("handles batch embedding", async () => {
    const responseData = {
      result: {
        data: [
          [0.1, 0.2, 0.3, 0.4],
          [0.5, 0.6, 0.7, 0.8],
        ],
        shape: [2, 4],
      },
      success: true,
      errors: [],
      messages: [],
    };
    mockCfFetch(responseData);

    const embedder = makeCloudflareEmbedder();
    const result = await embedder.embed(["hello", "world"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result[1]).toEqual([0.5, 0.6, 0.7, 0.8]);
  });

  it("splits into batches when input exceeds batchSize", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { data: [[1, 0, 0, 0], [0, 1, 0, 0]], shape: [2, 4] },
          success: true,
          errors: [],
          messages: [],
        }),
        text: async () => "{}",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { data: [[0, 0, 1, 0]], shape: [1, 4] },
          success: true,
          errors: [],
          messages: [],
        }),
        text: async () => "{}",
      } as Response);

    globalThis.fetch = fetchMock;

    const embedder = makeCloudflareEmbedder({ batchSize: 2 });
    const result = await embedder.embed(["a", "b", "c"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([1, 0, 0, 0]);
    expect(result[2]).toEqual([0, 0, 1, 0]);
  });

  it("throws AxFabricError on HTTP error", async () => {
    mockCfFetch({ errors: [{ code: 9106, message: "bad request" }] }, 400);

    const embedder = makeCloudflareEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("HTTP 400");
  });

  it("throws AxFabricError on API-level errors (success: false)", async () => {
    const responseData = {
      result: null,
      success: false,
      errors: [{ code: 1000, message: "model not found" }],
      messages: [],
    };
    mockCfFetch(responseData);

    const embedder = makeCloudflareEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("model not found");
  });

  it("throws AxFabricError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const embedder = makeCloudflareEmbedder();
    await expect(embedder.embed(["test"])).rejects.toThrow(AxFabricError);
    await expect(embedder.embed(["test"])).rejects.toThrow("network down");
  });

  it("returns empty array for empty input without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const embedder = makeCloudflareEmbedder();
    const result = await embedder.embed([]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to CLOUDFLARE_API_TOKEN env var", async () => {
    const responseData = {
      result: { data: [[0.1, 0.2, 0.3, 0.4]], shape: [1, 4] },
      success: true,
      errors: [],
      messages: [],
    };
    mockCfFetch(responseData);

    const saved = process.env["CLOUDFLARE_API_TOKEN"];
    process.env["CLOUDFLARE_API_TOKEN"] = "env-token";

    try {
      const embedder = makeCloudflareEmbedder({ apiToken: undefined });
      await embedder.embed(["test"]);

      const fetchMockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [, options] = fetchMockFn.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer env-token");
    } finally {
      if (saved !== undefined) {
        process.env["CLOUDFLARE_API_TOKEN"] = saved;
      } else {
        delete process.env["CLOUDFLARE_API_TOKEN"];
      }
    }
  });
});
