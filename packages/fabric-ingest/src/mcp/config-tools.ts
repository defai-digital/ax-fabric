import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FabricConfig } from "../cli/config-loader.js";

export interface ConfigToolsDeps {
  config: FabricConfig;
}

export function registerConfigTools(server: McpServer, deps: ConfigToolsDeps): void {
  const { config } = deps;

  server.tool(
    "fabric_config_show",
    "Show the current ax-fabric configuration (secrets redacted)",
    {},
    async () => {
      try {
        const redacted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
        const embedderSection = redacted["embedder"] as Record<string, unknown> | undefined;
        if (embedderSection?.["api_key"]) {
          embedderSection["api_key"] = "***REDACTED***";
        }
        const llmSection = redacted["llm"] as Record<string, unknown> | undefined;
        const authSection = llmSection?.["auth"] as Record<string, unknown> | undefined;
        if (authSection?.["token"]) {
          authSection["token"] = "***REDACTED***";
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(redacted, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_config_set",
    "Update a configuration value (dot-separated path, e.g., 'akidb.metric')",
    {
      key: z.string().describe("Dot-separated config path (e.g., 'akidb.metric', 'ingest.chunking.chunk_size')"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
    },
    async (args) => {
      try {
        const parts = args.key.split(".");
        let current = config as unknown as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const key = parts[i]!;
          const next = current[key];
          if (next === undefined || typeof next !== "object" || next === null || Array.isArray(next)) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }
        const lastKey = parts[parts.length - 1]!;
        const oldValue = current[lastKey];
        current[lastKey] = args.value;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              key: args.key,
              old_value: oldValue,
              new_value: args.value,
              message: "Configuration updated in memory. Use 'ax-fabric init' to persist changes to disk.",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
