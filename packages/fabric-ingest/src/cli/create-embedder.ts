/**
 * Shared helper — creates an EmbedderProvider from FabricConfig.
 *
 * Used by both `ingest run` and `search` commands.
 */

import type { EmbedderProvider } from "@ax-fabric/contracts";

import { CloudflareEmbedder } from "../embedder/index.js";
import { HttpEmbedder } from "../embedder/index.js";
import { McpEmbedder } from "../embedder/index.js";
import { MockEmbedder } from "../embedder/index.js";

import type { FabricConfig } from "./config-loader.js";
import { resolveToken } from "./config-loader.js";

export function createEmbedderFromConfig(config: FabricConfig): EmbedderProvider {
  const { embedder } = config;

  if (embedder.type === "http") {
    if (!embedder.base_url) {
      throw new Error("embedder.base_url is required for http embedder type");
    }
    return new HttpEmbedder({
      baseUrl: embedder.base_url,
      modelId: embedder.model_id,
      dimension: embedder.dimension,
      apiKey: resolveToken({ token: embedder.api_key, token_env: embedder.api_key_env }),
      batchSize: embedder.batch_size,
    });
  }

  if (embedder.type === "cloudflare") {
    if (!embedder.account_id) {
      throw new Error("embedder.account_id is required for cloudflare embedder type");
    }
    return new CloudflareEmbedder({
      accountId: embedder.account_id,
      modelId: embedder.model_id,
      dimension: embedder.dimension,
      apiToken: resolveToken({ token: embedder.api_key, token_env: embedder.api_key_env }),
      batchSize: embedder.batch_size,
    });
  }

  if (embedder.type === "mcp") {
    if (!embedder.mcp_command && !embedder.mcp_url) {
      throw new Error(
        "embedder.mcp_command or embedder.mcp_url is required for mcp embedder type",
      );
    }
    return new McpEmbedder({
      mcpCommand: embedder.mcp_command,
      mcpUrl: embedder.mcp_url,
      mcpTool: embedder.mcp_tool,
      modelId: embedder.model_id,
      dimension: embedder.dimension,
    });
  }

  if (embedder.type !== "local") {
    console.warn(
      `Warning: unknown embedder type "${embedder.type}" — falling back to mock embedder. ` +
      `Check your config.yaml embedder.type setting.`,
    );
  }

  return new MockEmbedder({
    modelId: embedder.model_id,
    dimension: embedder.dimension,
  });
}
