/**
 * Shared helper — creates an LlmProvider from FabricConfig.
 *
 * Used by the `search --answer` command and any other RAG path.
 * Returns null if no llm section is configured.
 */

import type { LlmProvider } from "@ax-fabric/contracts";

import { HttpLlmProvider } from "../llm/index.js";
import { McpLlmProvider } from "../llm/index.js";

import type { FabricConfig } from "./config-loader.js";
import { resolveToken } from "./config-loader.js";

export function createLlmFromConfig(config: FabricConfig): LlmProvider | null {
  const { llm } = config;
  if (!llm) return null;

  const timeoutMs = llm.timeout_seconds * 1000;
  const apiKey = resolveToken({ token: llm.auth.token, token_env: llm.auth.token_env });

  if (llm.type === "http") {
    if (!llm.base_url) {
      throw new Error("llm.base_url is required for http LLM type");
    }
    return new HttpLlmProvider({
      baseUrl: llm.base_url,
      modelId: llm.model_id,
      apiKey,
      timeoutMs,
      maxTokens: llm.max_tokens,
      temperature: llm.temperature,
    });
  }

  if (llm.type === "mcp") {
    if (!llm.mcp_command && !llm.mcp_url) {
      throw new Error("llm.mcp_command or llm.mcp_url is required for mcp LLM type");
    }
    return new McpLlmProvider({
      mcpCommand: llm.mcp_command,
      mcpUrl: llm.mcp_url,
      mcpTool: llm.mcp_tool,
      modelId: llm.model_id,
      timeoutMs,
      maxTokens: llm.max_tokens,
      temperature: llm.temperature,
    });
  }

  throw new Error(`Unknown LLM type: ${String(llm.type)}`);
}
