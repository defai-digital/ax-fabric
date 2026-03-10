/**
 * Tests for createEmbedderFromConfig — factory that creates an EmbedderProvider
 * from FabricConfig. Tests each embedder type and validates error handling.
 */

import { describe, it, expect } from "vitest";
import { createEmbedderFromConfig } from "./create-embedder.js";
import { HttpEmbedder } from "../embedder/http-embedder.js";
import { CloudflareEmbedder } from "../embedder/cloudflare-embedder.js";
import { MockEmbedder } from "../embedder/mock-embedder.js";
import type { FabricConfig } from "./config-loader.js";

// ─── Minimal config fixture ────────────────────────────────────────────────

function baseConfig(embedderOverrides: Partial<FabricConfig["embedder"]> = {}): FabricConfig {
  return {
    fabric: { data_root: "/tmp/ax-test" },
    akidb: { collection: "test", metric: "cosine", dimension: 128 },
    ingest: { sources: [], scan_mode: "full" },
    embedder: {
      type: "local",
      model_id: "mock-model",
      dimension: 128,
      ...embedderOverrides,
    },
  } as unknown as FabricConfig;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("createEmbedderFromConfig — local/mock", () => {
  it("returns MockEmbedder for type=local", () => {
    const embedder = createEmbedderFromConfig(baseConfig({ type: "local" }));
    expect(embedder).toBeInstanceOf(MockEmbedder);
  });

  it("MockEmbedder uses modelId and dimension from config", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({ type: "local", model_id: "my-model", dimension: 64 }),
    );
    expect(embedder.modelId).toBe("my-model");
    expect(embedder.dimension).toBe(64);
  });

  it("unknown type falls back to MockEmbedder with a warning", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({ type: "unknown-type" as "local" }),
    );
    expect(embedder).toBeInstanceOf(MockEmbedder);
  });
});

describe("createEmbedderFromConfig — http", () => {
  it("returns HttpEmbedder for type=http", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({
        type: "http",
        model_id: "text-embedding-3-small",
        dimension: 1536,
        base_url: "https://api.openai.com/v1/embeddings",
      }),
    );
    expect(embedder).toBeInstanceOf(HttpEmbedder);
  });

  it("HttpEmbedder has correct modelId and dimension", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({
        type: "http",
        model_id: "embed-v1",
        dimension: 512,
        base_url: "http://localhost:8080/v1/embeddings",
      }),
    );
    expect(embedder.modelId).toBe("embed-v1");
    expect(embedder.dimension).toBe(512);
  });

  it("throws when base_url is missing for http type", () => {
    expect(() =>
      createEmbedderFromConfig(baseConfig({ type: "http", model_id: "m", dimension: 4 })),
    ).toThrow("base_url");
  });
});

describe("createEmbedderFromConfig — cloudflare", () => {
  it("returns CloudflareEmbedder for type=cloudflare", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({
        type: "cloudflare",
        model_id: "@cf/baai/bge-large-en-v1.5",
        dimension: 1024,
        account_id: "test-account-id",
      }),
    );
    expect(embedder).toBeInstanceOf(CloudflareEmbedder);
  });

  it("CloudflareEmbedder has correct modelId and dimension", () => {
    const embedder = createEmbedderFromConfig(
      baseConfig({
        type: "cloudflare",
        model_id: "@cf/test-model",
        dimension: 768,
        account_id: "acct-123",
      }),
    );
    expect(embedder.modelId).toBe("@cf/test-model");
    expect(embedder.dimension).toBe(768);
  });

  it("throws when account_id is missing for cloudflare type", () => {
    expect(() =>
      createEmbedderFromConfig(
        baseConfig({ type: "cloudflare", model_id: "m", dimension: 4 }),
      ),
    ).toThrow("account_id");
  });
});

describe("createEmbedderFromConfig — mcp", () => {
  it("throws when neither mcp_command nor mcp_url is provided", () => {
    expect(() =>
      createEmbedderFromConfig(
        baseConfig({ type: "mcp", model_id: "m", dimension: 4 }),
      ),
    ).toThrow(/mcp_command|mcp_url/);
  });
});
