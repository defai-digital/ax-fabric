/**
 * `ax-fabric mcp` — MCP server management commands.
 *
 * Subcommands:
 *   mcp server       — Start the MCP stdio server
 *   mcp token show   — Show the current auth token
 *   mcp token generate — Generate a new auth token
 */

import type { Command } from "commander";

import { createMcpServer } from "../mcp/server.js";
import { ensureToken, generateToken, readToken, writeToken } from "../mcp/auth.js";

function maskToken(token: string): string {
  if (token.length <= 12) {
    return "***REDACTED***";
  }
  const prefix = token.slice(0, 7); // keep token family prefix (e.g. axf_tk_)
  const suffix = token.slice(-4);
  return `${prefix}***${suffix}`;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("MCP (Model Context Protocol) server management");

  // ── mcp server ────────────────────────────────────────────────────────────

  mcp
    .command("server")
    .description("Start the ax-fabric MCP server (stdio transport)")
    .option("-c, --config <path>", "Config file path")
    .action(async (opts: { config?: string }) => {
      const { start, close } = createMcpServer({ configPath: opts.config });

      // Graceful shutdown
      process.on("SIGINT", async () => {
        await close();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await close();
        process.exit(0);
      });

      try {
        await start();
      } catch (err) {
        await close();
        console.error("MCP server failed to start:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── mcp token ─────────────────────────────────────────────────────────────

  const token = mcp
    .command("token")
    .description("Manage MCP authentication tokens");

  token
    .command("show")
    .description("Show the current MCP auth token (masked by default)")
    .option("--reveal", "Print full token value")
    .action((opts: { reveal?: boolean }) => {
      const existing = readToken();
      if (existing) {
        console.log(opts.reveal ? existing : maskToken(existing));
      } else {
        console.log("No token found. Run 'ax-fabric mcp token generate' to create one.");
      }
    });

  token
    .command("generate")
    .description("Generate a new MCP auth token (overwrites existing)")
    .option("--reveal", "Print full token value")
    .action((opts: { reveal?: boolean }) => {
      const newToken = generateToken();
      writeToken(newToken);
      console.log("New token generated and saved:");
      console.log(opts.reveal ? newToken : maskToken(newToken));
    });

  token
    .command("ensure")
    .description("Ensure an auth token exists (generate if missing)")
    .option("--reveal", "Print full token value")
    .action((opts: { reveal?: boolean }) => {
      const tok = ensureToken();
      console.log(opts.reveal ? tok : maskToken(tok));
    });
}
