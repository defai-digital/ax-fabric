// cli — config loading, logging, and CLI plumbing (Milestone 3)

export {
  FabricConfigSchema,
  type FabricConfig,
  loadConfig,
  resolveConfigPath,
  resolveDataRoot,
  resolveToken,
  writeConfig,
} from "./config-loader.js";

export {
  redact,
  createLogger,
  type Logger,
} from "./log-redaction.js";
