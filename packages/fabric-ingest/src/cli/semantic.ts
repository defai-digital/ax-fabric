/**
 * Semantic CLI command group — thin registration entrypoint.
 *
 * File-based, store, and publication subcommands are delegated to focused modules.
 */

import type { Command } from "commander";
import { registerSemanticFileCommands } from "./semantic-file-commands.js";
import { registerSemanticStoreCommands } from "./semantic-store-commands.js";
import { registerSemanticPublishCommands } from "./semantic-publish-commands.js";

export function registerSemanticCommand(program: Command): void {
  const semantic = program
    .command("semantic")
    .description("Preview and export semantic units for a single file");

  registerSemanticFileCommands(semantic);

  // ── Store commands (C-2) ─────────────────────────────────────────────────

  registerSemanticStoreCommands(semantic);

  // ── Publication commands (C-1) ───────────────────────────────────────────

  registerSemanticPublishCommands(semantic);
}
