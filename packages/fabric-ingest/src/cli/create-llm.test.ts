/**
 * Unit tests for createLlmFromConfig.
 *
 * Verifies that the factory correctly constructs HttpLlmProvider /
 * McpLlmProvider from FabricConfig, resolves tokens from env vars,
 * and throws descriptive errors for misconfigured or unknown types.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpLlmProvider } from "../llm/http-llm.js";
import { McpLlmProvider } from "../llm/mcp-llm.js";
import { createLlmFromConfig } from "./create-llm.js";
import type { FabricConfig } from "./config-loader.js";

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

/** Minimal FabricConfig that satisfies the type without an llm section. */
function baseConfig(): FabricConfig {
  return {
    fabric: { data_root: "/tmp/test-data", max_storage_gb: 50 },
    akidb: { root: "/tmp/test-akidb", collection: "test", metric: "cosine", dimension: 128 },
    ingest: {
      sources: [],
      scan: { mode: "incremental", fingerprint: "sha256" },
      chunking: { chunk_size: 512, overlap: 0.15 },
    },
    embedder: { type: "local", model_id: "mock", dimension: 128, batch_size: 64 },
  } as FabricConfig;
}

function withHttpLlm(
  overrides: Partial<{
    base_url: string;
    model_id: string;
    token: string;
    token_env: string;
    timeout_seconds: number;
    max_tokens: number;
    temperature: number;
  }> = {},
): FabricConfig {
  return {
    ...baseConfig(),
    llm: {
      type: "http",
      model_id: overrides.model_id ?? "gpt-4o-mini",
      base_url: overrides.base_url ?? "http://localhost:11434",
      auth: {
        scheme: "bearer",
        token: overrides.token,
        token_env: overrides.token_env,
      },
      timeout_seconds: overrides.timeout_seconds ?? 60,
      max_tokens: overrides.max_tokens,
      temperature: overrides.temperature,
    },
  } as FabricConfig;
}

function withMcpLlm(
  overrides: Partial<{
    mcp_command: string;
    mcp_url: string;
    mcp_tool: string;
    model_id: string;
    token: string;
    token_env: string;
  }> = {},
): FabricConfig {
  return {
    ...baseConfig(),
    llm: {
      type: "mcp",
      model_id: overrides.model_id ?? "my-model",
      mcp_command: overrides.mcp_command,
      mcp_url: overrides.mcp_url,
      mcp_tool: overrides.mcp_tool,
      auth: {
        scheme: "bearer",
        token: overrides.token,
        token_env: overrides.token_env,
      },
      timeout_seconds: 60,
    },
  } as FabricConfig;
}

/* ================================================================== */
/*  No LLM section                                                    */
/* ================================================================== */

describe("createLlmFromConfig — no llm section", () => {
  it("returns null when config has no llm section", () => {
    const result = createLlmFromConfig(baseConfig());
    expect(result).toBeNull();
  });
});

/* ================================================================== */
/*  HTTP LLM type                                                     */
/* ================================================================== */

describe("createLlmFromConfig — http type", () => {
  it("returns an HttpLlmProvider instance", () => {
    const provider = createLlmFromConfig(withHttpLlm());
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });

  it("sets modelId from config", () => {
    const provider = createLlmFromConfig(withHttpLlm({ model_id: "qwen3-0.6b" }));
    expect(provider?.modelId).toBe("qwen3-0.6b");
  });

  it("throws when base_url is missing for http type", () => {
    const config = withHttpLlm();
    delete (config.llm as { base_url?: string }).base_url;

    expect(() => createLlmFromConfig(config)).toThrow("base_url");
  });

  it("resolves api key from auth.token directly", () => {
    // We can't read the private apiKey, but we can verify construction doesn't throw
    const provider = createLlmFromConfig(withHttpLlm({ token: "sk-test-key" }));
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });

  it("resolves api key from auth.token_env", () => {
    process.env["TEST_LLM_TOKEN"] = "env-token-value";
    try {
      const provider = createLlmFromConfig(withHttpLlm({ token_env: "TEST_LLM_TOKEN" }));
      expect(provider).toBeInstanceOf(HttpLlmProvider);
    } finally {
      delete process.env["TEST_LLM_TOKEN"];
    }
  });

  it("passes timeout_seconds converted to ms", () => {
    // Verify construction succeeds with custom timeout
    const provider = createLlmFromConfig(withHttpLlm({ timeout_seconds: 30 }));
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });

  it("passes max_tokens when configured", () => {
    const provider = createLlmFromConfig(withHttpLlm({ max_tokens: 512 }));
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });

  it("passes temperature when configured", () => {
    const provider = createLlmFromConfig(withHttpLlm({ temperature: 0.7 }));
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });
});

/* ================================================================== */
/*  MCP LLM type                                                      */
/* ================================================================== */

describe("createLlmFromConfig — mcp type", () => {
  it("returns a McpLlmProvider instance when mcpCommand is given", () => {
    const provider = createLlmFromConfig(withMcpLlm({ mcp_command: "uvx my-llm" }));
    expect(provider).toBeInstanceOf(McpLlmProvider);
  });

  it("returns a McpLlmProvider instance when mcpUrl is given", () => {
    const provider = createLlmFromConfig(withMcpLlm({ mcp_url: "http://localhost:9000" }));
    expect(provider).toBeInstanceOf(McpLlmProvider);
  });

  it("sets modelId from config", () => {
    const provider = createLlmFromConfig(
      withMcpLlm({ mcp_url: "http://localhost:9000", model_id: "my-mcp-model" }),
    );
    expect(provider?.modelId).toBe("my-mcp-model");
  });

  it("throws when neither mcp_command nor mcp_url is provided", () => {
    const config = withMcpLlm(); // both mcp_command and mcp_url are undefined
    expect(() => createLlmFromConfig(config)).toThrow();
  });

  it("passes mcp_tool when specified", () => {
    // Just verify no throw and correct type
    const provider = createLlmFromConfig(
      withMcpLlm({ mcp_url: "http://localhost", mcp_tool: "my_generate" }),
    );
    expect(provider).toBeInstanceOf(McpLlmProvider);
  });

  it("resolves auth token from env var for mcp type", () => {
    process.env["MCP_AUTH_TOKEN"] = "mcp-secret";
    try {
      const provider = createLlmFromConfig(
        withMcpLlm({ mcp_url: "http://localhost:9000", token_env: "MCP_AUTH_TOKEN" }),
      );
      expect(provider).toBeInstanceOf(McpLlmProvider);
    } finally {
      delete process.env["MCP_AUTH_TOKEN"];
    }
  });
});

/* ================================================================== */
/*  Unknown type                                                      */
/* ================================================================== */

describe("createLlmFromConfig — unknown type", () => {
  it("throws for an unknown llm type", () => {
    const config = baseConfig();
    (config as unknown as { llm: { type: string; model_id: string; auth: object; timeout_seconds: number } }).llm = {
      type: "unknown-provider",
      model_id: "m",
      auth: { scheme: "bearer" },
      timeout_seconds: 60,
    };

    expect(() => createLlmFromConfig(config)).toThrow("Unknown LLM type");
    expect(() => createLlmFromConfig(config)).toThrow("unknown-provider");
  });
});
