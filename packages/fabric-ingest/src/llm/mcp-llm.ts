/**
 * MCP LLM provider — calls a user-provided MCP server's generate tool.
 *
 * Supports stdio and HTTP transports, same as McpEmbedder.
 *
 * Config example:
 *   llm:
 *     type: mcp
 *     mcp_command: "uvx my-llm-server"
 *     mcp_tool: generate
 *     model_id: "my-model"
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { GenerateOptions, LlmProvider } from "@ax-fabric/contracts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseCommandLine } from "../mcp/command.js";
import { DEFAULT_LLM_TIMEOUT_MS } from "../constants.js";

export interface McpLlmOptions {
  /** Shell command to launch the MCP server via stdio. */
  mcpCommand?: string;
  /** HTTP URL of an already-running MCP server. */
  mcpUrl?: string;
  /** Name of the MCP tool to call. Default: "generate" */
  mcpTool?: string;
  modelId: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_TOOL = "generate";

export class McpLlmProvider implements LlmProvider {
  readonly modelId: string;

  private readonly mcpCommand: string | undefined;
  private readonly mcpUrl: string | undefined;
  private readonly mcpTool: string;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number | undefined;
  private readonly defaultTemperature: number | undefined;

  private client: Client | null = null;
  private transport: Transport | null = null;

  constructor(options: McpLlmOptions) {
    if (!options.mcpCommand && !options.mcpUrl) {
      throw new AxFabricError("LLM_ERROR", "McpLlmProvider requires mcpCommand or mcpUrl");
    }
    this.mcpCommand = options.mcpCommand;
    this.mcpUrl = options.mcpUrl;
    this.mcpTool = options.mcpTool ?? DEFAULT_TOOL;
    this.modelId = options.modelId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.defaultMaxTokens = options.maxTokens;
    this.defaultTemperature = options.temperature;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const client = await this.getClient();

    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const args: Record<string, unknown> = { prompt };
    if (maxTokens !== undefined) args["max_tokens"] = maxTokens;
    if (temperature !== undefined) args["temperature"] = temperature;
    if (options?.stopSequences !== undefined) args["stop"] = options.stopSequences;

    let raw: unknown;
    try {
      raw = await client.callTool(
        { name: this.mcpTool, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      throw new AxFabricError(
        "LLM_ERROR",
        `MCP generate tool call failed: ${String(err)}`,
        err,
      );
    }

    return this.parseResult(raw);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    if (this.transport) {
      await (this.transport as { close?(): Promise<void> }).close?.().catch(() => undefined);
      this.transport = null;
    }
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    const transport = this.buildTransport();
    const client = new Client({ name: "ax-fabric-llm", version: "1.0.0" });

    try {
      await client.connect(transport);
    } catch (err) {
      // Transport won't be managed by the client if connect failed — close it ourselves.
      await (transport as { close?(): Promise<void> }).close?.().catch(() => undefined);
      throw new AxFabricError(
        "LLM_ERROR",
        `Failed to connect to MCP LLM server: ${String(err)}`,
        err,
      );
    }

    this.transport = transport;
    this.client = client;
    return client;
  }

  private buildTransport(): Transport {
    if (this.mcpCommand) {
      let parsed;
      try {
        parsed = parseCommandLine(this.mcpCommand);
      } catch (err) {
        throw new AxFabricError("LLM_ERROR", `Invalid mcpCommand: ${String(err)}`, err);
      }
      return new StdioClientTransport({ command: parsed.command, args: parsed.args });
    }
    return new StreamableHTTPClientTransport(new URL(this.mcpUrl!));
  }

  private parseResult(raw: unknown): string {
    // Extract text from MCP content items
    if (
      raw !== null &&
      typeof raw === "object" &&
      "content" in raw &&
      Array.isArray((raw as { content: unknown }).content)
    ) {
      const content = (raw as { content: unknown[] }).content;
      const textItem = content.find(
        (c) => c !== null && typeof c === "object" && (c as { type?: unknown }).type === "text",
      ) as { text?: unknown } | undefined;

      if (typeof textItem?.text === "string") {
        return textItem.text;
      }
    }

    // Fallback: plain string response
    if (typeof raw === "string") return raw;

    throw new AxFabricError(
      "LLM_ERROR",
      `MCP generate tool returned unexpected response shape: ${JSON.stringify(raw)}`,
    );
  }
}
