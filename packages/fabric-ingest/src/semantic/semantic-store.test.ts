import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { SemanticReviewEngine } from "./semantic-review.js";
import { SemanticStore } from "./semantic-store.js";

describe("SemanticStore", () => {
  it("stores and loads bundles", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Semantic store persists reviewed bundles and provenance.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const store = new SemanticStore(dbPath);
      store.upsertBundle(bundle);

      const loaded = store.getBundle(bundle.bundle_id);
      expect(loaded?.bundle_id).toBe(bundle.bundle_id);
      expect(loaded?.units.length).toBeGreaterThan(0);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("lists bundle summaries and preserves publication metadata", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-list-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Semantic store tracks publication state for approved bundles.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const store = new SemanticStore(dbPath);
      store.upsertBundle(bundle);
      store.markPublished(bundle.bundle_id, {
        collectionId: "default-semantic",
        manifestVersion: 3,
        publishedAt: new Date().toISOString(),
      });

      const summaries = store.listBundles();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.bundleId).toBe(bundle.bundle_id);
      expect(summaries[0]!.publishedCollectionId).toBe("default-semantic");
      expect(summaries[0]!.publishedManifestVersion).toBe(3);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
