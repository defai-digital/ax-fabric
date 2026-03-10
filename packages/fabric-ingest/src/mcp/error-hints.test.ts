/**
 * Unit tests for MCP error-hints: getErrorHint and formatError.
 */

import { describe, expect, it } from "vitest";
import { getErrorHint, formatError } from "./error-hints.js";

describe("getErrorHint", () => {
  it("returns empty string for unrecognized error", () => {
    expect(getErrorHint("Something completely unknown happened")).toBe("");
  });

  it("hints to create collection when 'not found' and 'collection' appear", () => {
    const hint = getErrorHint("collection not found: my-col");
    expect(hint).toContain("akidb_create_collection");
  });

  it("hints on dimension mismatch", () => {
    const hint = getErrorHint("dimension mismatch: expected 128 got 64");
    expect(hint).toContain("akidb_collection_status");
    expect(hint).toContain("dimension");
  });

  it("hints when 'no manifest' is in the message", () => {
    const hint = getErrorHint("no manifest for collection docs");
    expect(hint).toContain("akidb_publish");
  });

  it("hints when 'manifest not found' is in the message", () => {
    const hint = getErrorHint("manifest not found: v2");
    expect(hint).toContain("akidb_publish");
  });

  it("hints on embedder configuration errors", () => {
    const hint = getErrorHint("embedder returned error: 401 Unauthorized");
    expect(hint).toContain("fabric_config_show");
  });

  it("hints on Cloudflare API errors", () => {
    const hint = getErrorHint("cloudflare: authentication error");
    expect(hint).toContain("api_key_env");
  });

  it("hints on api_key mention", () => {
    const hint = getErrorHint("api_key is not set");
    expect(hint).toContain("api_key_env");
  });

  it("hints when no extractor is found", () => {
    const hint = getErrorHint("no extractor registered for: data.xyz");
    expect(hint).toContain("axfabric://formats");
  });

  it("hints when unsupported file is mentioned", () => {
    const hint = getErrorHint("unsupported file type: .xyz");
    expect(hint).toContain("axfabric://formats");
  });

  it("hints on ENOENT errors", () => {
    const hint = getErrorHint("ENOENT: no such file or directory, open '/foo/bar'");
    expect(hint).toContain("does not exist");
  });

  it("hints on 'no such file' variant", () => {
    const hint = getErrorHint("no such file: /missing/path");
    expect(hint).toContain("does not exist");
  });

  it("hints when collection already exists", () => {
    const hint = getErrorHint("collection already exists: my-col");
    expect(hint).toContain("akidb_list_collections");
  });

  it("hints when collection is soft-deleted", () => {
    const hint = getErrorHint("collection my-col has been deleted");
    expect(hint).toContain("akidb_create_collection");
  });

  it("is case-insensitive (uppercase message)", () => {
    const hint = getErrorHint("COLLECTION NOT FOUND");
    expect(hint).toContain("akidb_create_collection");
  });

  it("is case-insensitive (mixed case)", () => {
    const hint = getErrorHint("No Manifest found");
    expect(hint).toContain("akidb_publish");
  });
});

describe("formatError", () => {
  it("returns isError: true", () => {
    const result = formatError(new Error("something broke"));
    expect(result.isError).toBe(true);
  });

  it("includes the error message in the content text", () => {
    const result = formatError(new Error("disk full"));
    expect(result.content[0]!.text).toContain("disk full");
  });

  it("content type is 'text'", () => {
    const result = formatError(new Error("err"));
    expect(result.content[0]!.type).toBe("text");
  });

  it("appends a hint when the error is recognized", () => {
    const result = formatError(new Error("collection not found: xyz"));
    expect(result.content[0]!.text).toContain("akidb_create_collection");
  });

  it("no hint appended for unrecognized errors", () => {
    const result = formatError(new Error("mysterious error"));
    // Hint should be empty string, so text ends after the message
    expect(result.content[0]!.text).toBe("Error: mysterious error");
  });

  it("handles non-Error objects (string)", () => {
    const result = formatError("string error message");
    // (e as Error).message is undefined for strings, falls back to String(e)
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  it("content array has exactly one entry", () => {
    const result = formatError(new Error("test"));
    expect(result.content).toHaveLength(1);
  });
});
