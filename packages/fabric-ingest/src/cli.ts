#!/usr/bin/env node

/**
 * ax-fabric CLI — document ingestion and search pipeline.
 */

import { Command } from "commander";

import { registerInitCommand } from "./cli/init.js";
import { registerIngestAddCommand } from "./cli/ingest-add.js";
import { registerIngestDiffCommand } from "./cli/ingest-diff.js";
import { registerIngestRunCommand } from "./cli/ingest-run.js";
import { registerIngestStatusCommand } from "./cli/ingest-status.js";
import { registerSearchCommand } from "./cli/search.js";
import { registerMcpCommand } from "./cli/mcp.js";
import { registerOrchestratorCommand } from "./cli/orchestrator.js";
import { registerDaemonCommand } from "./cli/daemon.js";
import { registerDoctorCommand } from "./cli/doctor.js";

const program = new Command();

program
  .name("ax-fabric")
  .description("AX-Fabric document ingestion and search pipeline")
  .version("0.1.0");

registerInitCommand(program);

const ingest = program
  .command("ingest")
  .description("Document ingestion commands");

registerIngestAddCommand(ingest);
registerIngestDiffCommand(ingest);
registerIngestRunCommand(ingest);
registerIngestStatusCommand(ingest);

registerSearchCommand(program);
registerMcpCommand(program);
registerOrchestratorCommand(program);
registerDaemonCommand(program);
registerDoctorCommand(program);

program.parse();
