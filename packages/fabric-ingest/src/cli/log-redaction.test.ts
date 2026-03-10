/**
 * Tests for Task 3.9 — Log Redaction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { redact, createLogger } from "./log-redaction.js";

// ─── redact() ────────────────────────────────────────────────────────────────

describe("redact", () => {
  it("redacts Bearer tokens", () => {
    const input = 'Authorization: Bearer sk-abc123xyz';
    const result = redact(input);
    expect(result).not.toContain("sk-abc123xyz");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts token: value patterns (double quotes)", () => {
    const input = 'token: "my-secret-token-123"';
    const result = redact(input);
    expect(result).not.toContain("my-secret-token-123");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts token: value patterns (single quotes)", () => {
    const input = "token: 'another-secret'";
    const result = redact(input);
    expect(result).not.toContain("another-secret");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts token: value patterns (no quotes)", () => {
    const input = "token: raw-value-here";
    const result = redact(input);
    expect(result).not.toContain("raw-value-here");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts api_key values", () => {
    const input = 'api_key = "sk-proj-AbCdEf"';
    const result = redact(input);
    expect(result).not.toContain("sk-proj-AbCdEf");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts secret values", () => {
    const input = "secret: super-duper-secret";
    const result = redact(input);
    expect(result).not.toContain("super-duper-secret");
    expect(result).toContain("***REDACTED***");
  });

  it("redacts password values", () => {
    const input = 'password = "hunter2"';
    const result = redact(input);
    expect(result).not.toContain("hunter2");
    expect(result).toContain("***REDACTED***");
  });

  it("does not redact normal text", () => {
    const input = "Loading file /docs/readme.txt with 42 chunks";
    const result = redact(input);
    expect(result).toBe(input);
  });

  it("does not redact text that merely contains the word token", () => {
    const input = "Processed 5 token embeddings successfully";
    const result = redact(input);
    expect(result).toBe(input);
  });

  it("handles multiple secrets in a single string", () => {
    const input = 'token: "abc123" and api_key = "xyz789"';
    const result = redact(input);
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789");
    expect(result.match(/\*\*\*REDACTED\*\*\*/g)).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    const input = 'TOKEN: "my-upper-case-secret"';
    const result = redact(input);
    expect(result).not.toContain("my-upper-case-secret");
    expect(result).toContain("***REDACTED***");
  });

  it("handles empty string", () => {
    expect(redact("")).toBe("");
  });
});

// ─── createLogger ────────────────────────────────────────────────────────────

describe("createLogger", () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes messages with [prefix]", () => {
    const log = createLogger("ingest");
    log.info("starting pipeline");

    expect(consoleSpy.log).toHaveBeenCalledWith("[ingest] starting pipeline");
  });

  it("info() redacts secrets in messages", () => {
    const log = createLogger("cli");
    log.info('using token: "sk-secret-key"');

    const output = consoleSpy.log.mock.calls[0]![0] as string;
    expect(output).not.toContain("sk-secret-key");
    expect(output).toContain("***REDACTED***");
  });

  it("error() redacts secrets in messages", () => {
    const log = createLogger("cli");
    log.error("failed with api_key = abc123");

    const output = consoleSpy.error.mock.calls[0]![0] as string;
    expect(output).not.toContain("abc123");
    expect(output).toContain("***REDACTED***");
  });

  it("warn() redacts secrets in messages", () => {
    const log = createLogger("cli");
    log.warn("Bearer my-jwt-token detected in config");

    const output = consoleSpy.warn.mock.calls[0]![0] as string;
    expect(output).not.toContain("my-jwt-token");
    expect(output).toContain("***REDACTED***");
  });

  it("redacts secrets in extra arguments", () => {
    const log = createLogger("test");
    log.info("config loaded", { token: "secret-value" });

    const output = consoleSpy.log.mock.calls[0]![0] as string;
    expect(output).not.toContain("secret-value");
    expect(output).toContain("***REDACTED***");
  });

  it("does not redact normal log output", () => {
    const log = createLogger("scan");
    log.info("scanned 42 files in 1.2s");

    expect(consoleSpy.log).toHaveBeenCalledWith(
      "[scan] scanned 42 files in 1.2s",
    );
  });
});
