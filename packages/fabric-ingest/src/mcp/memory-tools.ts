import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MemoryStore } from "../memory/index.js";

export interface MemoryToolsDeps {
  memoryStorePath: string;
}

export function registerMemoryTools(server: McpServer, deps: MemoryToolsDeps): void {
  const { memoryStorePath } = deps;

  server.tool(
    "fabric_memory_put",
    "Store a memory record scoped to a session and optional workflow",
    {
      session_id: z.string().describe("Session ID"),
      text: z.string().min(1).describe("Memory text to store"),
      kind: z.enum(["short-term", "long-term"]).optional().default("short-term").describe("Memory kind"),
      workflow_id: z.string().optional().describe("Optional workflow ID for sub-session scoping"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const record = store.put({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          text: args.text,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_memory_list",
    "List memory records, optionally filtered by session, workflow, and kind",
    {
      session_id: z.string().optional().describe("Session ID to filter by"),
      workflow_id: z.string().optional().describe("Workflow ID to filter by"),
      kind: z.enum(["short-term", "long-term"]).optional().describe("Memory kind to filter by"),
      limit: z.number().int().positive().optional().default(20).describe("Maximum records to return"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const records = store.list({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          limit: args.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ records }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_memory_assemble",
    "Assemble memory records into a single context block for prompt injection",
    {
      session_id: z.string().describe("Session ID"),
      workflow_id: z.string().optional().describe("Optional workflow ID to narrow scope"),
      kind: z.enum(["short-term", "long-term"]).optional().describe("Memory kind to include"),
      limit: z.number().int().positive().optional().default(20).describe("Maximum records to include"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const assembled = store.assembleContext({
          sessionId: args.session_id,
          workflowId: args.workflow_id,
          kind: args.kind,
          limit: args.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(assembled, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "fabric_memory_delete",
    "Delete a memory record by ID",
    {
      id: z.string().describe("Memory record ID"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(memoryStorePath);
        const deleted = store.delete(args.id);
        if (!deleted) {
          return { content: [{ type: "text" as const, text: `Memory record not found: ${args.id}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: args.id, deleted: true }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
