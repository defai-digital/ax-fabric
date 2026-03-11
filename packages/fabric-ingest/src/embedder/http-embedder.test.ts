import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AxFabricError } from "@ax-fabric/contracts";

import { HttpEmbedder } from "./http-embedder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a well-formed OpenAI-style embedding response. */
function makeResponse(
  embeddings: number[][],
  opts: { status?: number; ok?: boolean } = {},
): Response {
  const data = embeddings.map((embedding, index) => ({ index, embedding }));
  const body = JSON.stringify({ data });
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Create a default embedder pointing at a fake endpoint. */
function makeEmbedder(overrides: Partial<ConstructorParameters<typeof HttpEmbedder>[0]> = {}): HttpEmbedder {
  return new HttpEmbedder({
    baseUrl: "https://api.example.com",
    modelId: "text-embedding-test",
    dimension: 3,
    apiKey: "test-key",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpEmbedder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Empty input ────────────────────────────────────────────────────────────

  describe("embed([])", () => {
    it("returns an empty array without calling fetch", async () => {
      const embedder = makeEmbedder();
      const result = await embedder.embed([]);
      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── Successful responses ───────────────────────────────────────────────────

  describe("successful responses", () => {
    it("returns 2 vectors in correct order for 2 texts", async () => {
      const v1 = [0.1, 0.2, 0.3];
      const v2 = [0.4, 0.5, 0.6];
      fetchMock.mockResolvedValueOnce(makeResponse([v1, v2]));

      const embedder = makeEmbedder();
      const result = await embedder.embed(["text A", "text B"]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(v1);
      expect(result[1]).toEqual(v2);
    });

    it("sends the model ID in the request body", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      const embedder = makeEmbedder({ modelId: "my-model" });
      await embedder.embed(["hello"]);

      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { model: string };
      expect(body.model).toBe("my-model");
    });
  });

  // ── Auth header ────────────────────────────────────────────────────────────

  describe("Authorization header", () => {
    it("sets Bearer token when apiKey is provided", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      const embedder = makeEmbedder({ apiKey: "secret-token" });
      await embedder.embed(["hello"]);

      const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-token");
    });

    it("omits Authorization header when apiKey is not provided", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      // Ensure env var is not set for this test.
      const saved = process.env["EMBEDDING_API_KEY"];
      delete process.env["EMBEDDING_API_KEY"];

      const embedder = makeEmbedder({ apiKey: undefined });
      await embedder.embed(["hello"]);
      if (saved !== undefined) process.env["EMBEDDING_API_KEY"] = saved;

      const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  // ── URL construction ───────────────────────────────────────────────────────

  describe("URL construction", () => {
    it("does not double-append /v1/embeddings when baseUrl already ends with it", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      const embedder = makeEmbedder({ baseUrl: "https://api.example.com/v1/embeddings" });
      await embedder.embed(["hello"]);

      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      // Count occurrences of /v1/embeddings.
      const occurrences = (calledUrl.match(/\/v1\/embeddings/g) ?? []).length;
      expect(occurrences).toBe(1);
      expect(calledUrl).toBe("https://api.example.com/v1/embeddings");
    });

    it("appends /v1/embeddings when baseUrl does not include it", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      const embedder = makeEmbedder({ baseUrl: "https://api.example.com" });
      await embedder.embed(["hello"]);

      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://api.example.com/v1/embeddings");
    });

    it("strips trailing slashes from baseUrl before appending path", async () => {
      fetchMock.mockResolvedValueOnce(makeResponse([[0.1, 0.2, 0.3]]));
      const embedder = makeEmbedder({ baseUrl: "https://api.example.com/" });
      await embedder.embed(["hello"]);

      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://api.example.com/v1/embeddings");
    });
  });

  // ── Batching ───────────────────────────────────────────────────────────────

  describe("batching", () => {
    it("splits into multiple requests when texts.length > batchSize and reassembles in order", async () => {
      // batchSize = 2, 5 texts → 3 batches
      fetchMock
        .mockResolvedValueOnce(makeResponse([[1, 0, 0], [0, 1, 0]]))
        .mockResolvedValueOnce(makeResponse([[0, 0, 1], [1, 1, 0]]))
        .mockResolvedValueOnce(makeResponse([[0, 1, 1]]));

      const embedder = makeEmbedder({ batchSize: 2 });
      const texts = ["t1", "t2", "t3", "t4", "t5"];
      const result = await embedder.embed(texts);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual([1, 0, 0]);
      expect(result[1]).toEqual([0, 1, 0]);
      expect(result[2]).toEqual([0, 0, 1]);
      expect(result[3]).toEqual([1, 1, 0]);
      expect(result[4]).toEqual([0, 1, 1]);
    });
  });

  // ── HTTP errors ────────────────────────────────────────────────────────────

  describe("HTTP errors", () => {
    it("throws AxFabricError with EMBED_ERROR code on HTTP 401", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const embedder = makeEmbedder();
      await expect(embedder.embed(["hello"])).rejects.toThrow(AxFabricError);

      try {
        await embedder.embed(["hello"]);
      } catch (err) {
        // Second call needs a new mock — provide it.
      }

      // Re-check via a fresh call.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });

    it("includes the HTTP status code in the error message", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      const embedder = makeEmbedder();
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as AxFabricError).message).toContain("403");
      }
    });
  });

  // ── Network failures ───────────────────────────────────────────────────────

  describe("network failures", () => {
    it("throws AxFabricError with EMBED_ERROR when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const embedder = makeEmbedder();
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });
  });

  // ── Response parsing errors ────────────────────────────────────────────────

  describe("response parsing", () => {
    it("throws AxFabricError with EMBED_ERROR when response is not valid JSON", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
        text: () => Promise.resolve("not-json"),
      });

      const embedder = makeEmbedder();
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });

    it("throws AxFabricError with EMBED_ERROR when response is missing data array", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ object: "list" }), // no `data` field
        text: () => Promise.resolve("{}"),
      });

      const embedder = makeEmbedder();
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });

    it("throws AxFabricError when API returns wrong number of embeddings (count mismatch)", async () => {
      // 2 texts but only 1 embedding returned.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        text: () => Promise.resolve(""),
      });

      const embedder = makeEmbedder();
      try {
        await embedder.embed(["text1", "text2"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });

    it("throws AxFabricError when embedding dimension does not match expected", async () => {
      // Embedder expects dimension 3 but API returns dimension 2.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
        text: () => Promise.resolve(""),
      });

      const embedder = makeEmbedder({ dimension: 3 });
      try {
        await embedder.embed(["hello"]);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AxFabricError);
        expect((err as AxFabricError).code).toBe("EMBED_ERROR");
      }
    });

    it("correctly reorders out-of-order response items by index field", async () => {
      // API returns items in reverse order.
      const v0 = [0.1, 0.2, 0.3];
      const v1 = [0.4, 0.5, 0.6];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: [
            { index: 1, embedding: v1 },
            { index: 0, embedding: v0 },
          ],
        }),
        text: () => Promise.resolve(""),
      });

      const embedder = makeEmbedder();
      const result = await embedder.embed(["text0", "text1"]);

      expect(result[0]).toEqual(v0);
      expect(result[1]).toEqual(v1);
    });
  });
});
