/**
 * MCP auth token management — ADR-029.
 *
 * Token format: `axf_tk_` prefix + 32 bytes crypto.randomBytes in base62.
 * Stored at `~/.ax-fabric/mcp-token` with `0600` permissions.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { AX_FABRIC_HOME_DIR, MCP_TOKEN_FILENAME, ENV_MCP_TOKEN } from "../constants.js";

const TOKEN_PREFIX = "axf_tk_";
const TOKEN_BYTES = 32;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function tokenFilePath(): string {
  return join(homedir(), AX_FABRIC_HOME_DIR, MCP_TOKEN_FILENAME);
}

function toBase62(buf: Buffer): string {
  let result = "";
  for (const byte of buf) {
    result += BASE62_CHARS[byte % 62];
  }
  return result;
}

/** Generate a new auth token with `axf_tk_` prefix. */
export function generateToken(): string {
  const bytes = randomBytes(TOKEN_BYTES);
  return TOKEN_PREFIX + toBase62(bytes);
}

/** Write token to disk at `~/.ax-fabric/mcp-token` with `0600` permissions. */
export function writeToken(token: string): void {
  const filePath = tokenFilePath();
  const dir = join(homedir(), AX_FABRIC_HOME_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, token, "utf-8");
  chmodSync(filePath, 0o600);
}

/** Read token from `AX_FABRIC_MCP_TOKEN` env var or `~/.ax-fabric/mcp-token` file. */
export function readToken(): string | null {
  const envToken = process.env[ENV_MCP_TOKEN];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const filePath = tokenFilePath();
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Ensure a token exists — generate and persist if missing. Returns the token. */
export function ensureToken(): string {
  const existing = readToken();
  if (existing) return existing;

  const token = generateToken();
  writeToken(token);
  return token;
}

/** Constant-time token comparison. Returns true if tokens match. */
export function validateToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return timingSafeEqual(a, b);
}
