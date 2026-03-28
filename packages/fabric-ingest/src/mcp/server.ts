/**
 * MCP server entry point — ADR-028/029.
 *
 * Launches the ax-fabric MCP server with stdio transport.
 * Registers all MCP tools and resources for the OSS/business semantic workflow surface.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = _require("../../package.json") as { version: string };

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createEmbedderFromConfig } from "../cli/create-embedder.js";
import { loadFabricRuntime, openRuntimeAkiDb } from "../cli/runtime.js";
import { registerAkiDbTools } from "./akidb-tools.js";
import { registerFabricTools } from "./fabric-tools.js";
import { registerResources } from "./resources.js";
import { readToken, validateToken } from "./auth.js";

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
  const runtime = loadFabricRuntime(options?.configPath);
  const { config } = runtime;

  // Open AkiDB
  const db = openRuntimeAkiDb(runtime);

  // Create embedder
  const embedder = createEmbedderFromConfig(config);

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
  registerFabricTools(server, {
    db,
    embedder,
    config,
    registryDbPath: runtime.paths.registryDbPath,
    memoryStorePath: runtime.paths.memoryStorePath,
  });

  // Register all resources
  registerResources(server, { db, config, registryDbPath: runtime.paths.registryDbPath });

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
