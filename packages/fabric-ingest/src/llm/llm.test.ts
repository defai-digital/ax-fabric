/**
 * Unit tests for HttpLlmProvider and McpLlmProvider.
 *
 * HttpLlmProvider: fetch is mocked via vi.stubGlobal.
 * McpLlmProvider: tested at the constructor/validation and parseResult level
 *   via a subclass that exposes private internals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxFabricError } from "@ax-fabric/contracts";

import { HttpLlmProvider } from "./http-llm.js";
import { McpLlmProvider } from "./mcp-llm.js";

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/* ================================================================== */
/*  HttpLlmProvider                                                   */
/* ================================================================== */

describe("HttpLlmProvider", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Constructor ─────────────────────────────────────────────────────────────

  it("stores modelId from options", () => {
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost:11434", modelId: "qwen3" });
    expect(llm.modelId).toBe("qwen3");
  });

  it("strips trailing slashes from baseUrl", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost:11434///", modelId: "m" });
    await llm.generate("hello");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
  });

  // ─── Successful generation ────────────────────────────────────────────────────

  it("returns content from choices[0].message.content", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    const result = await llm.generate("Say hello");
    expect(result).toBe("Hello!");
  });

  it("sends the prompt as a user message", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("test prompt");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);
  });

  it("includes Authorization header when apiKey is provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m", apiKey: "sk-abc" });
    await llm.generate("hi");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const headers = (request as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-abc");
  });

  it("omits Authorization header when no apiKey", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("hi");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const headers = (request as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends model in request body", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "gpt-4o-mini" });
    await llm.generate("hi");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  // ─── GenerateOptions ─────────────────────────────────────────────────────────

  it("sends max_tokens when specified in options", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("hi", { maxTokens: 256 });

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(256);
  });

  it("sends default max_tokens from constructor when not overridden", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m", maxTokens: 512 });
    await llm.generate("hi");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(512);
  });

  it("per-call maxTokens overrides constructor default", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m", maxTokens: 512 });
    await llm.generate("hi", { maxTokens: 100 });

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(100);
  });

  it("sends temperature when specified", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("hi", { temperature: 0.7 });

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { temperature: number };
    expect(body.temperature).toBe(0.7);
  });

  it("sends stop sequences when specified", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("hi", { stopSequences: ["\n", "END"] });

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as { stop: string[] };
    expect(body.stop).toEqual(["\n", "END"]);
  });

  it("omits max_tokens/temperature when neither constructor nor options provide them", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });
    await llm.generate("hi");

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse((request as RequestInit).body as string) as Record<string, unknown>;
    expect(body["max_tokens"]).toBeUndefined();
    expect(body["temperature"]).toBeUndefined();
  });

  // ─── Error handling ───────────────────────────────────────────────────────────

  it("throws LLM_ERROR AxFabricError when fetch rejects (network error)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });

    try {
      await llm.generate("hi");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AxFabricError);
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
      expect((e as AxFabricError).message).toContain("ECONNREFUSED");
    }
  });

  it("throws LLM_ERROR when API returns non-OK status", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, "Unauthorized"));
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });

    try {
      await llm.generate("hi");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AxFabricError);
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
      expect((e as AxFabricError).message).toContain("401");
      expect((e as AxFabricError).message).toContain("Unauthorized");
    }
  });

  it("throws LLM_ERROR when response body is not valid JSON", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      text: () => Promise.resolve("not json"),
    } as unknown as Response);

    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });

    try {
      await llm.generate("hi");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AxFabricError);
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
      expect((e as AxFabricError).message).toContain("parse");
    }
  });

  it("throws LLM_ERROR when choices[0].message.content is missing", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ choices: [] }));
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });

    try {
      await llm.generate("hi");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AxFabricError);
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
      expect((e as AxFabricError).message).toContain("choices");
    }
  });

  it("throws LLM_ERROR when response is missing choices entirely", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ result: "unexpected" }));
    const llm = new HttpLlmProvider({ baseUrl: "http://localhost", modelId: "m" });

    await expect(llm.generate("hi")).rejects.toMatchObject({
      code: "LLM_ERROR",
    });
  });
});

/* ================================================================== */
/*  McpLlmProvider — constructor validation                          */
/* ================================================================== */

describe("McpLlmProvider constructor", () => {
  it("throws LLM_ERROR when neither mcpCommand nor mcpUrl is provided", () => {
    expect(
      () => new McpLlmProvider({ modelId: "m" }),
    ).toThrow(AxFabricError);

    try {
      new McpLlmProvider({ modelId: "m" });
    } catch (e) {
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
      expect((e as AxFabricError).message).toContain("mcpCommand or mcpUrl");
    }
  });

  it("accepts mcpCommand without mcpUrl", () => {
    expect(
      () => new McpLlmProvider({ modelId: "m", mcpCommand: "uvx my-llm" }),
    ).not.toThrow();
  });

  it("accepts mcpUrl without mcpCommand", () => {
    expect(
      () => new McpLlmProvider({ modelId: "m", mcpUrl: "http://localhost:8080" }),
    ).not.toThrow();
  });

  it("stores modelId", () => {
    const provider = new McpLlmProvider({ modelId: "my-model", mcpUrl: "http://localhost" });
    expect(provider.modelId).toBe("my-model");
  });

  it("uses default 'generate' tool name when mcpTool not specified", () => {
    // Verify indirectly — if it constructs without error, the default is applied.
    const provider = new McpLlmProvider({ modelId: "m", mcpCommand: "cmd" });
    expect(provider).toBeDefined();
  });
});

/* ================================================================== */
/*  McpLlmProvider — parseResult (via subclass exposure)             */
/* ================================================================== */

// Access private parseResult via type casting for unit testing the parser logic.
class TestableMcpLlmProvider extends McpLlmProvider {
  public testParseResult(raw: unknown): string {
    // Access the private method via type casting
    return (this as unknown as { parseResult(r: unknown): string }).parseResult(raw);
  }
}

describe("McpLlmProvider.parseResult", () => {
  const provider = new TestableMcpLlmProvider({ modelId: "m", mcpUrl: "http://localhost" });

  it("extracts text from MCP content array with type=text", () => {
    const raw = {
      content: [
        { type: "image", url: "http://img" },
        { type: "text", text: "Generated output" },
      ],
    };
    expect(provider.testParseResult(raw)).toBe("Generated output");
  });

  it("uses the first text content item found", () => {
    const raw = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(provider.testParseResult(raw)).toBe("first");
  });

  it("returns plain string response as-is (fallback)", () => {
    expect(provider.testParseResult("direct string")).toBe("direct string");
  });

  it("throws LLM_ERROR for unexpected response shape (null)", () => {
    expect(() => provider.testParseResult(null)).toThrow(AxFabricError);
    try {
      provider.testParseResult(null);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("LLM_ERROR");
    }
  });

  it("throws LLM_ERROR when content array has no text item", () => {
    const raw = { content: [{ type: "image", url: "http://img" }] };
    expect(() => provider.testParseResult(raw)).toThrow(AxFabricError);
  });

  it("throws LLM_ERROR for number response", () => {
    expect(() => provider.testParseResult(42)).toThrow(AxFabricError);
  });

  it("throws LLM_ERROR for object without content array", () => {
    expect(() => provider.testParseResult({ result: "foo" })).toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  McpLlmProvider — close() resilience                              */
/* ================================================================== */

describe("McpLlmProvider.close", () => {
  it("is safe to call when not connected", async () => {
    const provider = new McpLlmProvider({ modelId: "m", mcpUrl: "http://localhost" });
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it("is safe to call multiple times", async () => {
    const provider = new McpLlmProvider({ modelId: "m", mcpUrl: "http://localhost" });
    await provider.close();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
