/**
 * MCP server entry point — ADR-028/029.
 *
 * Launches the ax-fabric MCP server with stdio transport.
 * Registers all MCP tools and resources for the OSS/business semantic workflow surface.
 */

import { join } from "node:path";
import { homedir } from "node:os";
const PACKAGE_VERSION = "2.0.0";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AkiDB } from "@ax-fabric/akidb";

import { loadConfig, resolveDataRoot } from "../cli/config-loader.js";
import { createEmbedderFromConfig } from "../cli/create-embedder.js";
import { registerAkiDbTools } from "./akidb-tools.js";
import { registerFabricTools } from "./fabric-tools.js";
import { registerResources } from "./resources.js";
import { readToken, validateToken } from "./auth.js";

/** Expand a leading `~` to the current user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export interface McpServerOptions {
  /** Override config file path. Default: ~/.ax-fabric/config.yaml */
  configPath?: string;
}

/**
 * Create and configure the MCP server instance.
 * Does not start the transport — call `start()` on the returned object.
 */
export function createMcpServer(options?: McpServerOptions): {
  server: McpServer;
  start: () => Promise<void>;
  close: () => Promise<void>;
} {
  const config = loadConfig(options?.configPath);
  const dataRoot = resolveDataRoot(config);
  const akidbRoot = expandTilde(config.akidb.root);

  // Open AkiDB
  const db = new AkiDB({ storagePath: akidbRoot });

  // Create embedder
  const embedder = createEmbedderFromConfig(config);

  // Registry path
  const registryDbPath = join(dataRoot, "registry.db");

  // Create MCP server
  const server = new McpServer({
    name: "ax-fabric",
    version: PACKAGE_VERSION,
  }, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  // Register all tools
  registerAkiDbTools(server, db);
  registerFabricTools(server, { db, embedder, config, registryDbPath, memoryStorePath: join(dataRoot, "memory.json") });

  // Register all resources
  registerResources(server, { db, config, registryDbPath });

  const start = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  };

  const close = async (): Promise<void> => {
    await embedder.close?.().catch(() => undefined);
    try { db.close(); } catch { /* ignore close errors during shutdown */ }
  };

  return { server, start, close };
}

/**
 * Validate a bearer token against the stored MCP auth token.
 * Returns true if the token is valid.
 *
 * Note: stdio MCP transport has no HTTP bearer boundary. This helper is
 * intended for wrappers exposing MCP over HTTP.
 */
export function authenticateRequest(bearerToken: string): boolean {
  const expected = readToken();
  if (!expected) return false;
  return validateToken(bearerToken, expected);
}
