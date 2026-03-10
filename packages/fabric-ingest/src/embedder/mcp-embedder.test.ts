/**
 * Unit tests for McpEmbedder.
 *
 * The MCP Client is never actually connected — constructor validation,
 * embed([]) shortcut, parseResult parsing, and close() resilience are
 * all exercised without spawning a real server.
 */

import { describe, it, expect } from "vitest";
import { AxFabricError } from "@ax-fabric/contracts";
import { McpEmbedder } from "./mcp-embedder.js";
import type { McpEmbedderOptions } from "./mcp-embedder.js";

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

function makeOptions(overrides: Partial<McpEmbedderOptions> = {}): McpEmbedderOptions {
  return {
    mcpUrl: "http://localhost:9000",
    modelId: "test-model",
    dimension: 4,
    ...overrides,
  };
}

/**
 * Subclass that exposes the private parseResult method for unit testing.
 */
class TestableMcpEmbedder extends McpEmbedder {
  public testParseResult(raw: unknown, expectedCount: number): number[][] {
    return (this as unknown as { parseResult(r: unknown, n: number): number[][] }).parseResult(
      raw,
      expectedCount,
    );
  }
}

/* ================================================================== */
/*  Constructor validation                                            */
/* ================================================================== */

describe("McpEmbedder constructor", () => {
  it("throws EMBED_ERROR when neither mcpCommand nor mcpUrl is provided", () => {
    expect(() => new McpEmbedder({ modelId: "m", dimension: 4 })).toThrow(AxFabricError);
    try {
      new McpEmbedder({ modelId: "m", dimension: 4 });
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("mcpCommand");
    }
  });

  it("throws EMBED_ERROR when both mcpCommand and mcpUrl are provided", () => {
    expect(
      () =>
        new McpEmbedder({
          modelId: "m",
          dimension: 4,
          mcpCommand: "uvx my-embed",
          mcpUrl: "http://localhost:9000",
        }),
    ).toThrow(AxFabricError);
    try {
      new McpEmbedder({
        modelId: "m",
        dimension: 4,
        mcpCommand: "uvx my-embed",
        mcpUrl: "http://localhost:9000",
      });
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("not both");
    }
  });

  it("accepts mcpUrl without mcpCommand", () => {
    expect(
      () => new McpEmbedder({ modelId: "m", dimension: 4, mcpUrl: "http://localhost:9000" }),
    ).not.toThrow();
  });

  it("accepts mcpCommand without mcpUrl", () => {
    expect(
      () => new McpEmbedder({ modelId: "m", dimension: 4, mcpCommand: "uvx my-embed-server" }),
    ).not.toThrow();
  });

  it("stores modelId", () => {
    const embedder = new McpEmbedder(makeOptions({ modelId: "nomic-embed-text" }));
    expect(embedder.modelId).toBe("nomic-embed-text");
  });

  it("stores dimension", () => {
    const embedder = new McpEmbedder(makeOptions({ dimension: 768 }));
    expect(embedder.dimension).toBe(768);
  });
});

/* ================================================================== */
/*  embed([]) shortcut                                                */
/* ================================================================== */

describe("McpEmbedder.embed", () => {
  it("returns empty array immediately for empty input without connecting", async () => {
    const embedder = new McpEmbedder(makeOptions());
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
  });
});

/* ================================================================== */
/*  parseResult — MCP content array                                   */
/* ================================================================== */

describe("McpEmbedder.parseResult — MCP content array", () => {
  const embedder = new TestableMcpEmbedder(makeOptions({ dimension: 3 }));

  it("extracts and JSON-parses the first text item from content array", () => {
    const raw = {
      content: [
        { type: "image", url: "http://img" },
        { type: "text", text: JSON.stringify([[0.1, 0.2, 0.3]]) },
      ],
    };
    const result = embedder.testParseResult(raw, 1);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("returns multiple vectors when content text contains array of arrays", () => {
    const raw = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            [1, 2, 3],
            [4, 5, 6],
          ]),
        },
      ],
    };
    const result = embedder.testParseResult(raw, 2);
    expect(result).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("uses the first text content item when multiple text items exist", () => {
    const raw = {
      content: [
        { type: "text", text: JSON.stringify([[0.1, 0.2, 0.3]]) },
        { type: "text", text: JSON.stringify([[9, 9, 9]]) },
      ],
    };
    const result = embedder.testParseResult(raw, 1);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("throws EMBED_ERROR when text item contains invalid JSON", () => {
    const raw = {
      content: [{ type: "text", text: "not-valid-json" }],
    };
    expect(() => embedder.testParseResult(raw, 1)).toThrow(AxFabricError);
    try {
      embedder.testParseResult(raw, 1);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("invalid JSON");
    }
  });

  it("throws EMBED_ERROR when content array has no text item", () => {
    const raw = { content: [{ type: "image", url: "http://img" }] };
    expect(() => embedder.testParseResult(raw, 1)).toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  parseResult — plain array (fallback)                             */
/* ================================================================== */

describe("McpEmbedder.parseResult — plain array payload", () => {
  const embedder = new TestableMcpEmbedder(makeOptions({ dimension: 2 }));

  it("accepts a plain array of arrays (no MCP content wrapper)", () => {
    const raw = [[0.5, 0.6]];
    const result = embedder.testParseResult(raw, 1);
    expect(result).toEqual([[0.5, 0.6]]);
  });

  it("accepts multiple vectors in a plain array", () => {
    const raw = [
      [1, 0],
      [0, 1],
    ];
    const result = embedder.testParseResult(raw, 2);
    expect(result).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

/* ================================================================== */
/*  parseResult — count/dimension validation                         */
/* ================================================================== */

describe("McpEmbedder.parseResult — count and dimension validation", () => {
  const embedder = new TestableMcpEmbedder(makeOptions({ dimension: 3 }));

  it("throws EMBED_ERROR when vector count does not match expectedCount", () => {
    const raw = [[1, 2, 3]]; // 1 vector returned, but we asked for 2
    expect(() => embedder.testParseResult(raw, 2)).toThrow(AxFabricError);
    try {
      embedder.testParseResult(raw, 2);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("1");
      expect((e as AxFabricError).message).toContain("2");
    }
  });

  it("throws EMBED_ERROR when a vector has wrong dimension", () => {
    const raw = [[1, 2]]; // dimension 2, expected 3
    expect(() => embedder.testParseResult(raw, 1)).toThrow(AxFabricError);
    try {
      embedder.testParseResult(raw, 1);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("dimension");
    }
  });

  it("throws EMBED_ERROR when a vector item is not an array", () => {
    const raw = ["not-an-array"] as unknown[];
    expect(() => embedder.testParseResult(raw, 1)).toThrow(AxFabricError);
    try {
      embedder.testParseResult(raw, 1);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
      expect((e as AxFabricError).message).toContain("not a number array");
    }
  });
});

/* ================================================================== */
/*  parseResult — invalid payload shapes                             */
/* ================================================================== */

describe("McpEmbedder.parseResult — invalid payload", () => {
  const embedder = new TestableMcpEmbedder(makeOptions({ dimension: 3 }));

  it("throws EMBED_ERROR for null payload", () => {
    expect(() => embedder.testParseResult(null, 0)).toThrow(AxFabricError);
    try {
      embedder.testParseResult(null, 0);
    } catch (e) {
      expect((e as AxFabricError).code).toBe("EMBED_ERROR");
    }
  });

  it("throws EMBED_ERROR for number payload", () => {
    expect(() => embedder.testParseResult(42, 1)).toThrow(AxFabricError);
  });

  it("throws EMBED_ERROR for string payload", () => {
    expect(() => embedder.testParseResult("not-an-array", 1)).toThrow(AxFabricError);
  });

  it("throws EMBED_ERROR for object without content array", () => {
    expect(() => embedder.testParseResult({ result: "foo" }, 1)).toThrow(AxFabricError);
  });
});

/* ================================================================== */
/*  close() resilience                                               */
/* ================================================================== */

describe("McpEmbedder.close", () => {
  it("is safe to call when not connected", async () => {
    const embedder = new McpEmbedder(makeOptions());
    await expect(embedder.close()).resolves.toBeUndefined();
  });

  it("is safe to call multiple times", async () => {
    const embedder = new McpEmbedder(makeOptions());
    await embedder.close();
    await expect(embedder.close()).resolves.toBeUndefined();
  });
});
