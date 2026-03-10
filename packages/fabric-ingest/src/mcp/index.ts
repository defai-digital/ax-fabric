// MCP — Model Context Protocol server, tools, resources, and auth (ADR-028/029)

export { registerAkiDbTools } from "./akidb-tools.js";
export { registerFabricTools, type FabricToolsDeps } from "./fabric-tools.js";
export { registerResources, type ResourceDeps } from "./resources.js";
export { createMcpServer, authenticateRequest, type McpServerOptions } from "./server.js";
export {
  generateToken,
  writeToken,
  readToken,
  ensureToken,
  validateToken,
} from "./auth.js";
