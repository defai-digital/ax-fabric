import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AkiDB } from "@ax-fabric/akidb";

import { registerSemanticCommand } from "./semantic.js";
import { SemanticStore } from "../semantic/index.js";

let mockConfigPath = "";
let mockConfig: Record<string, unknown> = {};

vi.mock("./config-loader.js", () => ({
  resolveConfigPath: () => mockConfigPath,
  loadConfig: () => mockConfig,
  resolveDataRoot: (config: { fabric: { data_root: string } }) => config.fabric.data_root,
}));

describe("semantic CLI", () => {
  beforeEach(() => {
    mockConfigPath = "/tmp/test-config.yaml";
    mockConfig = {
      fabric: {
        data_root: "/tmp/ax-fabric-semantic-test",
        max_storage_gb: 50,
      },
      akidb: {
        root: "/tmp/ax-fabric-semantic-test/akidb",
        collection: "test-col",
        metric: "cosine",
        dimension: 128,
      },
      retrieval: {
        default_layer: "auto",
        semantic_collection_suffix: "-semantic",
      },
      ingest: {
        chunking: {
          chunk_size: 512,
          overlap: 0.15,
          strategy: "auto",
        },
      },
      embedder: {
        type: "local",
        model_id: "mock-embed-v1",
        dimension: 128,
        batch_size: 64,
      },
    };
  });

  function makeProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerSemanticCommand(program);
    return program;
  }

  it("prints preview output", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-preview-"));
    const filePath = join(workdir, "guide.md");
    writeFileSync(
      filePath,
      "# Preview\n\nSemantic distillation previews semantic units with source provenance.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "preview", filePath, "--limit", "1"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Semantic preview:");
      expect(output).toContain("question:");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("exports semantic units to a JSON file", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-export-"));
    const filePath = join(workdir, "guide.txt");
    const outputPath = join(workdir, "semantic", "units.json");
    writeFileSync(
      filePath,
      "Semantic export writes grounded semantic units to disk for downstream workflows.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "export", filePath, "--output", outputPath]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Exported");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("prints semantic review diagnostics", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-review-"));
    const filePath = join(workdir, "guide.md");
    writeFileSync(
      filePath,
      "# Review\n\nSemantic review should surface diagnostics for approval workflows.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "review", filePath]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Semantic review:");
      expect(output).toContain("Avg quality:");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("approves a saved semantic bundle", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-approve-"));
    const filePath = join(workdir, "guide.txt");
    const bundlePath = join(workdir, "bundle.json");
    const reviewedPath = join(workdir, "bundle.reviewed.json");
    writeFileSync(
      filePath,
      "Semantic approval writes a reviewed bundle with governance metadata for downstream workflows.",
      "utf8",
    );

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "bundle", filePath, "--output", bundlePath]);
      await program.parseAsync([
        "node",
        "test",
        "semantic",
        "approve",
        bundlePath,
        "--reviewer",
        "akira",
        "--min-quality",
        "0.5",
        "--duplicate-policy",
        "warn",
      ]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Review status:");
      expect(output).toContain("Reviewed bundle written");
      expect(existsSync(reviewedPath)).toBe(true);
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("stores bundles in sqlite and lists them", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-store-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    const dbPath = join(dataRoot, "semantic.db");
    writeFileSync(
      filePath,
      "Semantic sqlite storage should persist bundles as canonical review artifacts.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: join(dataRoot, "akidb"), collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      await program.parseAsync(["node", "test", "semantic", "bundles"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(existsSync(dbPath)).toBe(true);
      expect(output).toContain("Stored semantic bundle");
      expect(output).toContain("status=pending");
    } finally {
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("publishes an approved stored bundle to akidb", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-publish-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    const akidbRoot = join(dataRoot, "akidb");
    writeFileSync(
      filePath,
      "Semantic publication should publish approved bundles into a semantic AkiDB collection.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: akidbRoot, collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = new AkiDB({ storagePath: akidbRoot });

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      await program.parseAsync(["node", "test", "semantic", "bundles", "--json"]);
      const jsonOutput = logSpy.mock.calls[logSpy.mock.calls.length - 1]![0] as string;
      const bundles = JSON.parse(jsonOutput) as Array<{ bundleId: string }>;
      const bundleId = bundles[0]!.bundleId;

      await program.parseAsync([
        "node",
        "test",
        "semantic",
        "approve-store",
        bundleId,
        "--reviewer",
        "akira",
        "--min-quality",
        "0.5",
        "--duplicate-policy",
        "warn",
      ]);

      await program.parseAsync(["node", "test", "semantic", "publish", bundleId]);
      await program.parseAsync(["node", "test", "semantic", "show", bundleId]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Published semantic bundle");
      expect(output).toContain("Published:");
      expect(output).toContain("Collection:");

      const result = await db.search({
        collectionId: "test-col-semantic",
        queryVector: new Float32Array(Array.from({ length: 128 }, () => 0.1)),
        topK: 5,
      });
      expect(result.results.length).toBeGreaterThan(0);
    } finally {
      db.close();
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("unpublishes a published bundle from akidb and clears publication state", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-unpublish-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    const akidbRoot = join(dataRoot, "akidb");
    writeFileSync(
      filePath,
      "Semantic unpublish should remove published bundle records from the semantic collection.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: akidbRoot, collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = new AkiDB({ storagePath: akidbRoot });

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      await program.parseAsync(["node", "test", "semantic", "bundles", "--json"]);
      const jsonOutput = logSpy.mock.calls[logSpy.mock.calls.length - 1]![0] as string;
      const bundles = JSON.parse(jsonOutput) as Array<{ bundleId: string }>;
      const bundleId = bundles[0]!.bundleId;

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", bundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", bundleId]);

      let result = await db.search({
        collectionId: "test-col-semantic",
        queryVector: new Float32Array(Array.from({ length: 128 }, () => 0.1)),
        topK: 5,
      });
      expect(result.results.length).toBeGreaterThan(0);

      await program.parseAsync(["node", "test", "semantic", "unpublish", bundleId]);

      result = await db.search({
        collectionId: "test-col-semantic",
        queryVector: new Float32Array(Array.from({ length: 128 }, () => 0.1)),
        topK: 5,
      });
      expect(result.results).toHaveLength(0);

      const store = new SemanticStore(join(dataRoot, "semantic.db"));
      expect(store.getStoredBundle(bundleId)?.publication).toBeNull();
      store.close();
    } finally {
      db.close();
      logSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("refuses to publish a second active bundle for the same doc into the same collection", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-republish-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    writeFileSync(
      filePath,
      "Semantic publication should block a second active publication for the same doc and collection.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: join(dataRoot, "akidb"), collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      const store = new SemanticStore(join(dataRoot, "semantic.db"));
      const firstBundleId = store.listBundles()[0]!.bundleId;
      store.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", firstBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", firstBundleId]);

      writeFileSync(
        filePath,
        "Semantic publication should block a second active publication for the same doc after source changes.",
        "utf8",
      );

      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      const verifyStore = new SemanticStore(join(dataRoot, "semantic.db"));
      const secondBundleId = verifyStore.listBundles()[0]!.bundleId;
      verifyStore.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", secondBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);

      await expect(
        program.parseAsync(["node", "test", "semantic", "publish", secondBundleId]),
      ).rejects.toThrow(/already has an active published bundle/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("replaces a published bundle for the same doc when --replace is provided", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-replace-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    const akidbRoot = join(dataRoot, "akidb");
    writeFileSync(
      filePath,
      "Semantic replace should swap the active published bundle for the same doc.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: akidbRoot, collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const db = new AkiDB({ storagePath: akidbRoot });

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      let store = new SemanticStore(join(dataRoot, "semantic.db"));
      const firstBundleId = store.listBundles()[0]!.bundleId;
      store.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", firstBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", firstBundleId]);
      let publicationStore = new SemanticStore(join(dataRoot, "semantic.db"));
      const firstManifestVersion = publicationStore.getStoredBundle(firstBundleId)!.publication!.manifestVersion;
      publicationStore.close();

      writeFileSync(
        filePath,
        "Semantic replace should publish a newer approved bundle for the same doc when replace is requested.",
        "utf8",
      );

      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      publicationStore = new SemanticStore(join(dataRoot, "semantic.db"));
      const secondBundleId = publicationStore.listBundles()[0]!.bundleId;
      publicationStore.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", secondBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", secondBundleId, "--replace"]);

      publicationStore = new SemanticStore(join(dataRoot, "semantic.db"));
      expect(publicationStore.getStoredBundle(firstBundleId)?.publication).toBeNull();
      expect(publicationStore.getStoredBundle(secondBundleId)?.publication?.collectionId).toBe("test-col-semantic");
      expect(publicationStore.getStoredBundle(secondBundleId)?.publication?.manifestVersion).toBe(firstManifestVersion + 1);
      publicationStore.close();

      const result = await db.search({
        collectionId: "test-col-semantic",
        queryVector: new Float32Array(Array.from({ length: 128 }, () => 0.1)),
        topK: 10,
      });
      const resultIds = new Set(result.results.map((entry) => entry.chunkId));
      expect(resultIds.size).toBeGreaterThan(0);
      expect(Array.from(resultIds).every((id) => id.startsWith("semantic:"))).toBe(true);
    } finally {
      db.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("republishes an already published bundle into the same semantic collection", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-republish-same-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    const akidbRoot = join(dataRoot, "akidb");
    writeFileSync(
      filePath,
      "Semantic republish should rebuild the active semantic collection for the same bundle.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: akidbRoot, collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const storePath = join(dataRoot, "semantic.db");

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      let store = new SemanticStore(storePath);
      const bundleId = store.listBundles()[0]!.bundleId;
      store.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", bundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", bundleId]);

      store = new SemanticStore(storePath);
      const publishedBefore = store.getStoredBundle(bundleId)!.publication!.manifestVersion;
      store.close();

      await program.parseAsync(["node", "test", "semantic", "republish", bundleId]);

      store = new SemanticStore(storePath);
      const publishedAfter = store.getStoredBundle(bundleId)!.publication!.manifestVersion;
      expect(publishedAfter).toBeGreaterThan(publishedBefore);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("rolls back the active semantic publication to an older approved bundle", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-cli-rollback-"));
    const filePath = join(workdir, "guide.txt");
    const dataRoot = join(workdir, "data");
    writeFileSync(
      filePath,
      "Semantic rollback should restore the previously approved semantic bundle.",
      "utf8",
    );
    mockConfig = {
      ...mockConfig,
      fabric: { data_root: dataRoot, max_storage_gb: 50 },
      akidb: { root: join(dataRoot, "akidb"), collection: "test-col", metric: "cosine", dimension: 128 },
    };

    const program = makeProgram();
    const storePath = join(dataRoot, "semantic.db");

    try {
      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      let store = new SemanticStore(storePath);
      const firstBundleId = store.listBundles()[0]!.bundleId;
      store.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", firstBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", firstBundleId]);

      writeFileSync(
        filePath,
        "Semantic rollback should restore an older approved bundle after a newer revision replaced it.",
        "utf8",
      );

      await program.parseAsync(["node", "test", "semantic", "store", filePath]);
      store = new SemanticStore(storePath);
      const secondBundleId = store.listBundles()[0]!.bundleId;
      store.close();

      await program.parseAsync([
        "node", "test", "semantic", "approve-store", secondBundleId,
        "--reviewer", "akira",
        "--min-quality", "0.5",
        "--duplicate-policy", "warn",
      ]);
      await program.parseAsync(["node", "test", "semantic", "publish", secondBundleId, "--replace"]);
      await program.parseAsync(["node", "test", "semantic", "rollback", firstBundleId]);

      store = new SemanticStore(storePath);
      expect(store.getStoredBundle(firstBundleId)?.publication?.collectionId).toBe("test-col-semantic");
      expect(store.getStoredBundle(secondBundleId)?.publication).toBeNull();
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
