/**
 * Config loader — loads, validates, and writes the ax-fabric YAML config file.
 *
 * Supports env-var overrides for secrets (token_env / api_key_env) so that
 * raw credentials never need to live in the config file on disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const FabricConfigSchema = z.object({
  fabric: z
    .object({
      data_root: z.string().default("~/.ax-fabric/data"),
      max_storage_gb: z.number().positive().default(50),
    })
    .default({}),
  akidb: z
    .object({
      root: z.string().default("~/.ax-fabric/data/akidb"),
      collection: z.string().default("default"),
      metric: z.enum(["cosine", "l2", "dot"]).default("cosine"),
      dimension: z.number().int().positive().default(1024),
    })
    .default({}),
  ingest: z
    .object({
      sources: z.array(z.object({ path: z.string() })).default([]),
      scan: z
        .object({
          mode: z.enum(["incremental"]).default("incremental"),
          fingerprint: z.enum(["sha256", "sampled"]).default("sha256"),
        })
        .default({}),
      chunking: z
        .object({
          chunk_size: z.number().int().positive().default(2800),
          overlap: z.number().min(0).max(1).default(0.15),
        })
        .default({}),
    })
    .default({}),
  embedder: z
    .object({
      type: z.enum(["local", "http", "cloudflare", "mcp"]).default("local"),
      model_id: z.string().default("default-embed"),
      dimension: z.number().int().positive().default(128),
      batch_size: z.number().int().positive().default(64),
      base_url: z.string().optional(),
      api_key: z.string().optional(),
      api_key_env: z.string().optional(),
      /** Cloudflare account ID — required when type is "cloudflare". */
      account_id: z.string().optional(),
      /** MCP server stdio command — required when type is "mcp" (stdio mode). */
      mcp_command: z.string().optional(),
      /** MCP server HTTP URL — required when type is "mcp" (HTTP mode). */
      mcp_url: z.string().optional(),
      /** MCP tool name to call for embeddings. Default: "embed". */
      mcp_tool: z.string().optional(),
    })
    .default({}),
  schedule: z
    .object({
      interval_minutes: z.number().int().positive().default(10),
      quiet_hours: z
        .object({
          start: z.string().default("02:00"),
          end: z.string().default("06:00"),
        })
        .optional(),
    })
    .optional(),
  lifecycle: z
    .object({
      store_chunk_text: z.boolean().default(true),
      compact_threshold: z.number().int().positive().default(50),
      archive_retention_days: z.number().int().nonnegative().default(7),
    })
    .optional(),
  orchestrator: z
    .object({
      public_host: z.string().default("127.0.0.1"),
      public_port: z.number().int().positive().default(18080),
      internal_host: z.string().default("127.0.0.1"),
      internal_port: z.number().int().positive().default(19090),
      auth_token: z.string().optional(),
      auth_token_env: z.string().optional(),
    })
    .optional(),
  llm: z
    .object({
      type: z.enum(["http", "mcp"]).default("http"),
      model_id: z.string().default("qwen3-0.6b"),
      base_url: z.string().optional(),
      auth: z
        .object({
          scheme: z.enum(["bearer"]).default("bearer"),
          token: z.string().optional(),
          token_env: z.string().optional(),
        })
        .default({}),
      timeout_seconds: z.number().positive().default(60),
      /** MCP server stdio command — required when type is "mcp" (stdio mode). */
      mcp_command: z.string().optional(),
      /** MCP server HTTP URL — required when type is "mcp" (HTTP mode). */
      mcp_url: z.string().optional(),
      /** MCP tool name for text generation. Default: "generate". */
      mcp_tool: z.string().optional(),
      /** Max tokens for generation. */
      max_tokens: z.number().int().positive().optional(),
      /** Temperature for generation (0-2). */
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
});

export type FabricConfig = z.infer<typeof FabricConfigSchema>;

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Expand a leading `~` to the current user's home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/** Return the default config file path: `~/.ax-fabric/config.yaml`. */
export function resolveConfigPath(): string {
  return expandTilde("~/.ax-fabric/config.yaml");
}

/** Resolve `data_root` from the config, expanding `~`. */
export function resolveDataRoot(config: FabricConfig): string {
  return expandTilde(config.fabric.data_root);
}

// ─── Token resolution ────────────────────────────────────────────────────────

/**
 * Resolve a secret value with env-var override.
 *
 * If `token_env` is set, reads `process.env[token_env]`.
 * Falls back to the raw `token` field if the env var is absent or empty.
 */
export function resolveToken(auth: {
  token?: string;
  token_env?: string;
}): string | undefined {
  if (auth.token_env) {
    const envValue = process.env[auth.token_env];
    if (envValue !== undefined && envValue !== "") {
      return envValue;
    }
  }
  return auth.token;
}

// ─── Load / Write ────────────────────────────────────────────────────────────

/**
 * Load and validate the YAML config from disk.
 *
 * - If `configPath` is omitted, the default `~/.ax-fabric/config.yaml` is used.
 * - If the file does not exist, returns the schema defaults.
 * - Throws on invalid YAML or schema validation failure.
 */
export function loadConfig(configPath?: string): FabricConfig {
  const resolvedPath = configPath
    ? expandTilde(configPath)
    : resolveConfigPath();

  if (!existsSync(resolvedPath)) {
    // File missing — return schema defaults.
    return FabricConfigSchema.parse({});
  }

  const raw = readFileSync(resolvedPath, "utf8");
  const parsed: unknown = parse(raw);

  const result = FabricConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${resolvedPath}:\n${issues}`);
  }

  return result.data;
}

/**
 * Serialize and write the config to disk as YAML.
 *
 * Creates parent directories if they do not exist.
 */
export function writeConfig(
  configPath: string,
  config: FabricConfig,
): void {
  const resolvedPath = expandTilde(configPath);
  const dir = dirname(resolvedPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolvedPath, stringify(config), "utf8");
}
