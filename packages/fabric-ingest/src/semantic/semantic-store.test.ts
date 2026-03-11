import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SemanticReviewEngine } from "./semantic-review.js";
import { SemanticStore } from "./semantic-store.js";

describe("SemanticStore", () => {
  it("initializes a schema version for new stores", () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-schema-"));
    const dbPath = join(workdir, "semantic.db");

    try {
      const store = new SemanticStore(dbPath);
      expect(store.getSchemaVersion()).toBe(1);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy store that predates schema metadata", () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-legacy-schema-"));
    const dbPath = join(workdir, "semantic.db");
    const legacyDb = new DatabaseSync(dbPath);

    legacyDb.exec(`
      CREATE TABLE semantic_bundles (
        bundle_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        doc_version TEXT NOT NULL,
        content_type TEXT NOT NULL,
        distill_strategy TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        review_status TEXT NOT NULL,
        reviewer TEXT,
        reviewed_at TEXT,
        min_quality_score REAL,
        duplicate_policy TEXT,
        blocking_issues_json TEXT,
        notes TEXT,
        total_units INTEGER NOT NULL,
        average_quality_score REAL NOT NULL,
        duplicate_group_count INTEGER NOT NULL,
        bundle_json TEXT NOT NULL,
        published_collection_id TEXT,
        published_manifest_version INTEGER,
        published_at TEXT
      );

      CREATE TABLE semantic_units (
        unit_id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        summary TEXT NOT NULL,
        answer TEXT NOT NULL,
        quality_score REAL NOT NULL,
        duplicate_group_id TEXT,
        duplicate_group_size INTEGER
      );

      CREATE TABLE semantic_spans (
        bundle_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        span_index INTEGER NOT NULL,
        source_uri TEXT NOT NULL,
        content_type TEXT NOT NULL,
        page_range TEXT,
        table_ref TEXT,
        offset_start INTEGER NOT NULL,
        offset_end INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        chunk_label TEXT NOT NULL,
        PRIMARY KEY(unit_id, span_index)
      );
    `);
    legacyDb.close();

    try {
      const store = new SemanticStore(dbPath);
      expect(store.getSchemaVersion()).toBe(1);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

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

  it("clears publication state when a previously published bundle is re-reviewed as rejected", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-reject-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Rejected semantic bundles should not remain published in canonical state.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const approved = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.1,
        duplicatePolicy: "warn",
      });
      const rejected = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.99,
        duplicatePolicy: "reject",
      });

      const store = new SemanticStore(dbPath);
      store.upsertBundle(approved);
      store.markPublished(bundle.bundle_id, {
        collectionId: "default-semantic",
        manifestVersion: 2,
        publishedAt: new Date().toISOString(),
      });

      store.upsertBundle(rejected);

      const stored = store.getStoredBundle(bundle.bundle_id);
      expect(stored?.bundle.review?.status).toBe("rejected");
      expect(stored?.publication).toBeNull();
      expect(store.listPublishedUnitLookups("default-semantic")).toHaveLength(0);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("finds an active published bundle for a doc and collection", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-published-ref-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Published bundle refs should be queryable by doc and collection.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const approved = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.1,
        duplicatePolicy: "warn",
      });

      const store = new SemanticStore(dbPath);
      store.upsertBundle(approved);
      store.markPublished(bundle.bundle_id, {
        collectionId: "default-semantic",
        manifestVersion: 1,
        publishedAt: new Date().toISOString(),
      });

      const ref = store.findPublishedBundleForDoc(bundle.doc_id, "default-semantic");
      expect(ref?.bundleId).toBe(bundle.bundle_id);
      expect(ref?.docId).toBe(bundle.doc_id);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("hasPublishedCollection returns false when no bundle is published to that collection", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-hpc-false-"));
    const dbPath = join(workdir, "semantic.db");

    try {
      const store = new SemanticStore(dbPath);
      expect(store.hasPublishedCollection("nonexistent-collection")).toBe(false);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("hasPublishedCollection returns true once a bundle is marked published", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-hpc-true-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "doc.txt");
    writeFileSync(filePath, "Content for hasPublishedCollection check.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const store = new SemanticStore(dbPath);
      store.upsertBundle(bundle);

      expect(store.hasPublishedCollection("col-a")).toBe(false);

      store.markPublished(bundle.bundle_id, {
        collectionId: "col-a",
        manifestVersion: 0,
        publishedAt: new Date().toISOString(),
      });

      expect(store.hasPublishedCollection("col-a")).toBe(true);
      expect(store.hasPublishedCollection("col-b")).toBe(false);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("getStoredBundle returns null for a non-existent bundle id", () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-null-stored-"));
    const dbPath = join(workdir, "semantic.db");

    try {
      const store = new SemanticStore(dbPath);
      expect(store.getStoredBundle("no-such-bundle")).toBeNull();
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("listBundles returns empty array when no bundles exist", () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-empty-list-"));
    const dbPath = join(workdir, "semantic.db");

    try {
      const store = new SemanticStore(dbPath);
      expect(store.listBundles()).toEqual([]);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("updateReview changes the review status of an existing bundle", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-update-review-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "doc.txt");
    writeFileSync(filePath, "Content for updateReview test.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const store = new SemanticStore(dbPath);
      store.upsertBundle(bundle);

      // Initially pending.
      expect(store.getBundle(bundle.bundle_id)?.review?.status ?? "pending").toBe("pending");

      const updated = store.updateReview(bundle.bundle_id, {
        status: "approved",
        reviewer: "tester",
        reviewed_at: new Date().toISOString(),
        min_quality_score: 0.1,
        duplicate_policy: "warn",
        blocking_issues: [],
      });

      expect(updated.review?.status).toBe("approved");
      expect(updated.review?.reviewer).toBe("tester");

      // Persisted.
      const stored = store.getStoredBundle(bundle.bundle_id);
      expect(stored?.bundle.review?.status).toBe("approved");
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("updateReview throws when bundle does not exist", () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-update-review-missing-"));
    const dbPath = join(workdir, "semantic.db");

    try {
      const store = new SemanticStore(dbPath);
      expect(() =>
        store.updateReview("no-such-bundle", {
          status: "approved",
          reviewer: "tester",
          reviewed_at: new Date().toISOString(),
          min_quality_score: 0.1,
          duplicate_policy: "warn",
          blocking_issues: [],
        }),
      ).toThrow(/not found/);
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("clears publication state explicitly", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "semantic-store-clear-published-"));
    const dbPath = join(workdir, "semantic.db");
    const filePath = join(workdir, "guide.txt");
    writeFileSync(filePath, "Semantic publication state should be clearable.", "utf8");

    try {
      const engine = new SemanticReviewEngine();
      const bundle = await engine.createBundle(filePath);
      const approved = engine.approveBundle(bundle, {
        reviewer: "akira",
        minQualityScore: 0.1,
        duplicatePolicy: "warn",
      });

      const store = new SemanticStore(dbPath);
      store.upsertBundle(approved);
      store.markPublished(bundle.bundle_id, {
        collectionId: "default-semantic",
        manifestVersion: 1,
        publishedAt: new Date().toISOString(),
      });

      store.clearPublished(bundle.bundle_id);

      const stored = store.getStoredBundle(bundle.bundle_id);
      expect(stored?.publication).toBeNull();
      expect(store.findPublishedBundleForDoc(bundle.doc_id, "default-semantic")).toBeNull();
      store.close();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
