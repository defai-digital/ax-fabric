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
      const stored = store.getStoredBundle(bundle.bundle_id);
      expect(stored?.publication?.collectionId).toBe("default-semantic");
      expect(stored?.publication?.manifestVersion).toBe(3);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("preserves review state when an unchanged bundle is stored again", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-rerun-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Semantic store should preserve approvals across unchanged reruns.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const reviewed = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.1,
        duplicatePolicy: "warn",
      });

      const store = new SemanticStore(dbPath);
      store.upsertBundle(reviewed);
      store.upsertBundle(bundle);

      const stored = store.getStoredBundle(bundle.bundle_id);
      expect(stored?.bundle.review?.status).toBe("approved");
      expect(stored?.bundle.review?.reviewer).toBe("akira");
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("lists published semantic unit lookups without loading full bundles", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-lookups-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Published semantic lookups should be queryable directly from the store.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const store = new SemanticStore(dbPath);
      store.upsertBundle(bundle);
      store.markPublished(bundle.bundle_id, {
        collectionId: "default-semantic",
        manifestVersion: 1,
        publishedAt: new Date().toISOString(),
      });

      const lookups = store.listPublishedUnitLookups("default-semantic");
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups[0]!.chunkId).toMatch(/^semantic:/);
      expect(lookups[0]!.sourcePath).toBe(filePath);
      expect(lookups[0]!.collectionId).toBe("default-semantic");

      const single = store.getPublishedUnitLookup(lookups[0]!.chunkId);
      expect(single?.sourcePath).toBe(filePath);
      expect(single?.dedupeKey).toBeTruthy();
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
