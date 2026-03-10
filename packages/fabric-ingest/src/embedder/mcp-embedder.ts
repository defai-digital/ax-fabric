/**
 * MCP embedder — calls a user-provided MCP server's embed tool.
 *
 * Supports two transport modes:
 *   - stdio: spawns a local process (Ollama wrapper, custom server, etc.)
 *   - http:  connects to an HTTP/SSE MCP server
 *
 * The remote tool receives { texts: string[] } and must return a JSON array
 * of number arrays: [[0.1, 0.2, ...], ...].
 *
 * Config example (stdio):
 *   embedder:
 *     type: mcp
 *     mcp_command: "uvx my-embed-server"
 *     mcp_tool: embed
 *     model_id: "my-model"
 *     dimension: 1024
 *
 * Config example (HTTP):
 *   embedder:
 *     type: mcp
 *     mcp_url: "http://localhost:8080/mcp"
 *     mcp_tool: embed
 *     model_id: "my-model"
 *     dimension: 1024
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { EmbedderProvider } from "@ax-fabric/contracts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseCommandLine } from "../mcp/command.js";

export interface McpEmbedderOptions {
  /**
   * Shell command to launch the MCP server via stdio.
   * Mutually exclusive with `mcpUrl`.
   * Example: "uvx my-embed-server --model nomic-embed-text"
   */
  mcpCommand?: string;

  /**
   * HTTP URL of an already-running MCP server (Streamable HTTP transport).
   * Mutually exclusive with `mcpCommand`.
   * Example: "http://localhost:8080/mcp"
   */
  mcpUrl?: string;

  /** Name of the MCP tool to call. Default: "embed" */
  mcpTool?: string;

  /** Model identifier reported by this embedder. */
  modelId: string;

  /** Expected embedding dimension. */
  dimension: number;

  /** Request timeout in milliseconds. Default: 60 000 */
  timeoutMs?: number;
}

const DEFAULT_TOOL = "embed";
const DEFAULT_TIMEOUT_MS = 60_000;

export class McpEmbedder implements EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;

  private readonly mcpCommand: string | undefined;
  private readonly mcpUrl: string | undefined;
  private readonly mcpTool: string;
  private readonly timeoutMs: number;

  /** Lazily initialised — created on first embed() call. */
  private client: Client | null = null;
  private transport: Transport | null = null;

  constructor(options: McpEmbedderOptions) {
    if (!options.mcpCommand && !options.mcpUrl) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "McpEmbedder requires either mcpCommand (stdio) or mcpUrl (HTTP)",
      );
    }
    if (options.mcpCommand && options.mcpUrl) {
      throw new AxFabricError(
        "EMBED_ERROR",
        "McpEmbedder: specify mcpCommand or mcpUrl, not both",
      );
    }
    this.mcpCommand = options.mcpCommand;
    this.mcpUrl = options.mcpUrl;
    this.mcpTool = options.mcpTool ?? DEFAULT_TOOL;
    this.modelId = options.modelId;
    this.dimension = options.dimension;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const client = await this.getClient();

    let result: unknown;
    try {
      const response = await client.callTool(
        { name: this.mcpTool, arguments: { texts } },
        undefined,
        { timeout: this.timeoutMs },
      );
      result = response;
    } catch (err) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `MCP embed tool call failed: ${String(err)}`,
        err,
      );
    }

    return this.parseResult(result, texts.length);
  }

  /** Tear down the MCP client and process when done. */
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

  // ---------------------------------------------------------------------------

  /** Lazily connect to the MCP server. */
  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    const transport = this.buildTransport();
    const client = new Client({ name: "ax-fabric-embedder", version: "1.0.0" });

    try {
      await client.connect(transport);
    } catch (err) {
      // Transport won't be managed by the client if connect failed — close it ourselves.
      await (transport as { close?(): Promise<void> }).close?.().catch(() => undefined);
      throw new AxFabricError(
        "EMBED_ERROR",
        `Failed to connect to MCP embedding server: ${String(err)}`,
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
        throw new AxFabricError("EMBED_ERROR", `Invalid mcpCommand: ${String(err)}`, err);
      }
      return new StdioClientTransport({ command: parsed.command, args: parsed.args });
    }

    // HTTP transport
    return new StreamableHTTPClientTransport(new URL(this.mcpUrl!));
  }

  /** Parse the tool response into a 2D float array. */
  private parseResult(raw: unknown, expectedCount: number): number[][] {
    // MCP tool responses carry content as an array of content items.
    // We look for the first text item and JSON-parse it.
    let payload: unknown = raw;

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

      if (textItem?.text && typeof textItem.text === "string") {
        try {
          payload = JSON.parse(textItem.text);
        } catch {
          throw new AxFabricError(
            "EMBED_ERROR",
            "MCP embed tool returned invalid JSON in text content",
          );
        }
      }
    }

    if (!Array.isArray(payload)) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `MCP embed tool response is not an array (got ${typeof payload})`,
      );
    }

    if (payload.length !== expectedCount) {
      throw new AxFabricError(
        "EMBED_ERROR",
        `MCP embed tool returned ${String(payload.length)} vectors for ${String(expectedCount)} texts`,
      );
    }

    for (let i = 0; i < payload.length; i++) {
      const vec = payload[i];
      if (!Array.isArray(vec)) {
        throw new AxFabricError(
          "EMBED_ERROR",
          `MCP embed tool: item ${String(i)} is not a number array`,
        );
      }
      if (vec.length !== this.dimension) {
        throw new AxFabricError(
          "EMBED_ERROR",
          `MCP embed tool: item ${String(i)} has dimension ${String(vec.length)}, expected ${String(this.dimension)}`,
        );
      }
    }

    return payload as number[][];
  }
}
