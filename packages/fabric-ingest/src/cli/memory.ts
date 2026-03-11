import { join } from "node:path";

import type { Command } from "commander";

import { resolveConfigPath, loadConfig, resolveDataRoot } from "./config-loader.js";
import { MemoryStore, type MemoryKind } from "../memory/index.js";

function createStore(configPath?: string): MemoryStore {
  const config = loadConfig(configPath ?? resolveConfigPath());
  const dataRoot = resolveDataRoot(config);
  return new MemoryStore(join(dataRoot, "memory.json"));
}

function parseKind(kind?: string): MemoryKind | undefined {
  if (!kind) return undefined;
  if (kind !== "short-term" && kind !== "long-term") {
    throw new Error("--kind must be one of: short-term, long-term");
  }
  return kind;
}

function parseLimit(limit: string): number {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Manage short-term and long-term memory/context records");

  memory
    .command("put")
    .description("Store a memory record")
    .requiredOption("--session <id>", "Session ID")
    .requiredOption("--text <text>", "Memory text")
    .option("--workflow <id>", "Workflow ID")
    .option("--kind <kind>", "Memory kind: short-term | long-term", "short-term")
    .option("--json", "Print JSON output")
    .action((opts: {
      session: string;
      text: string;
      workflow?: string;
      kind?: string;
      json?: boolean;
    }) => {
      try {
        const store = createStore();
        const record = store.put({
          sessionId: opts.session,
          workflowId: opts.workflow,
          kind: parseKind(opts.kind),
          text: opts.text,
        });
        if (opts.json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(`Stored memory ${record.id} (${record.kind}) for session ${record.sessionId}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  memory
    .command("list")
    .description("List memory records")
    .option("--session <id>", "Session ID")
    .option("--workflow <id>", "Workflow ID")
    .option("--kind <kind>", "Memory kind: short-term | long-term")
    .option("--limit <n>", "Maximum records to return", "20")
    .option("--json", "Print JSON output")
    .action((opts: {
      session?: string;
      workflow?: string;
      kind?: string;
      limit: string;
      json?: boolean;
    }) => {
      try {
        const store = createStore();
        const records = store.list({
          sessionId: opts.session,
          workflowId: opts.workflow,
          kind: parseKind(opts.kind),
          limit: parseLimit(opts.limit),
        });
        if (opts.json) {
          console.log(JSON.stringify({ records }, null, 2));
          return;
        }
        for (const record of records) {
          console.log(`${record.id}  ${record.kind}  ${record.sessionId}  ${record.text}`);
        }
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  memory
    .command("show <id>")
    .description("Show one memory record")
    .option("--json", "Print JSON output")
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const store = createStore();
        const record = store.get(id);
        if (!record) {
          console.error(`Memory record not found: ${id}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(`${record.id} (${record.kind})`);
        console.log(`session:   ${record.sessionId}`);
        if (record.workflowId) {
          console.log(`workflow:  ${record.workflowId}`);
        }
        console.log(`text:      ${record.text}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  memory
    .command("delete <id>")
    .description("Delete one memory record")
    .action((id: string) => {
      try {
        const store = createStore();
        const deleted = store.delete(id);
        if (!deleted) {
          console.error(`Memory record not found: ${id}`);
          process.exit(1);
        }
        console.log(`Deleted memory ${id}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  memory
    .command("assemble")
    .description("Assemble memory context for a session/workflow")
    .requiredOption("--session <id>", "Session ID")
    .option("--workflow <id>", "Workflow ID")
    .option("--kind <kind>", "Memory kind: short-term | long-term")
    .option("--limit <n>", "Maximum records to include", "20")
    .option("--json", "Print JSON output")
    .action((opts: {
      session: string;
      workflow?: string;
      kind?: string;
      limit: string;
      json?: boolean;
    }) => {
      try {
        const store = createStore();
        const assembled = store.assembleContext({
          sessionId: opts.session,
          workflowId: opts.workflow,
          kind: parseKind(opts.kind),
          limit: parseLimit(opts.limit),
        });
        if (opts.json) {
          console.log(JSON.stringify(assembled, null, 2));
          return;
        }
        console.log(assembled.text);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
