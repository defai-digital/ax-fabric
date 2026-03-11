import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SemanticBundle, SemanticReviewDecision } from "@ax-fabric/contracts";
import { SemanticBundleSchema } from "@ax-fabric/contracts";

const SEMANTIC_STORE_SCHEMA_VERSION = 1;

export interface SemanticBundleSummary {
  bundleId: string;
  sourcePath: string;
  reviewStatus: "pending" | "approved" | "rejected";
  totalUnits: number;
  averageQualityScore: number;
  duplicateGroupCount: number;
  publishedCollectionId: string | null;
  publishedManifestVersion: number | null;
  publishedAt: string | null;
}

export interface SemanticPublicationState {
  collectionId: string;
  manifestVersion: number;
  publishedAt: string;
}

export interface StoredSemanticBundle {
  bundle: SemanticBundle;
  publication: SemanticPublicationState | null;
}

export interface SemanticUnitLookup {
  chunkId: string;
  sourcePath: string;
  contentType: string;
  dedupeKey: string;
  collectionId: string | null;
}

export interface SemanticPublishedBundleRef {
  bundleId: string;
  docId: string;
  collectionId: string;
}

export class SemanticStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrateSchema();
  }

  upsertBundle(bundle: SemanticBundle): void {
    const parsed = SemanticBundleSchema.parse(bundle);
    const existing = this.getStoredBundle(parsed.bundle_id);
    const merged = existing && parsed.review === undefined
      ? SemanticBundleSchema.parse({
        ...parsed,
        review: existing.bundle.review,
      })
      : parsed;
    const review = merged.review;
    const retainPublication = review?.status === "approved";

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO semantic_bundles (
          bundle_id,
          source_path,
          doc_id,
          doc_version,
          content_type,
          distill_strategy,
          generated_at,
          review_status,
          reviewer,
          reviewed_at,
          min_quality_score,
          duplicate_policy,
          blocking_issues_json,
          notes,
          total_units,
          average_quality_score,
          duplicate_group_count,
          bundle_json,
          published_collection_id,
          published_manifest_version,
          published_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(bundle_id) DO UPDATE SET
          source_path = excluded.source_path,
          doc_id = excluded.doc_id,
          doc_version = excluded.doc_version,
          content_type = excluded.content_type,
          distill_strategy = excluded.distill_strategy,
          generated_at = excluded.generated_at,
          review_status = excluded.review_status,
          reviewer = excluded.reviewer,
          reviewed_at = excluded.reviewed_at,
          min_quality_score = excluded.min_quality_score,
          duplicate_policy = excluded.duplicate_policy,
          blocking_issues_json = excluded.blocking_issues_json,
          notes = excluded.notes,
          total_units = excluded.total_units,
          average_quality_score = excluded.average_quality_score,
          duplicate_group_count = excluded.duplicate_group_count,
          bundle_json = excluded.bundle_json,
          published_collection_id = excluded.published_collection_id,
          published_manifest_version = excluded.published_manifest_version,
          published_at = excluded.published_at
      `).run(
        merged.bundle_id,
        merged.source_path,
        merged.doc_id,
        merged.doc_version,
        merged.content_type,
        merged.distill_strategy,
        merged.generated_at,
        review?.status ?? "pending",
        review?.reviewer ?? null,
        review?.reviewed_at ?? null,
        review?.min_quality_score ?? null,
        review?.duplicate_policy ?? null,
        review ? JSON.stringify(review.blocking_issues) : null,
        review?.notes ?? null,
        merged.diagnostics.total_units,
        merged.diagnostics.average_quality_score,
        merged.diagnostics.duplicate_groups.length,
        JSON.stringify(merged),
        retainPublication ? (existing?.publication?.collectionId ?? null) : null,
        retainPublication ? (existing?.publication?.manifestVersion ?? null) : null,
        retainPublication ? (existing?.publication?.publishedAt ?? null) : null,
      );

      this.db.prepare("DELETE FROM semantic_units WHERE bundle_id = ?").run(merged.bundle_id);
      this.db.prepare("DELETE FROM semantic_spans WHERE bundle_id = ?").run(merged.bundle_id);

      const insertUnit = this.db.prepare(`
        INSERT INTO semantic_units (
          unit_id,
          bundle_id,
          title,
          question,
          summary,
          answer,
          quality_score,
          duplicate_group_id,
          duplicate_group_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSpan = this.db.prepare(`
        INSERT INTO semantic_spans (
          bundle_id,
          unit_id,
          span_index,
          source_uri,
          content_type,
          page_range,
          table_ref,
          offset_start,
          offset_end,
          chunk_id,
          chunk_hash,
          chunk_label
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const unit of merged.units) {
        insertUnit.run(
          unit.unit_id,
          merged.bundle_id,
          unit.title,
          unit.question,
          unit.summary,
          unit.answer,
          unit.quality_score,
          unit.duplicate_group_id ?? null,
          unit.duplicate_group_size ?? null,
        );

        unit.source_spans.forEach((span, index) => {
          insertSpan.run(
            merged.bundle_id,
            unit.unit_id,
            index,
            span.source_uri,
            span.content_type,
            span.page_range,
            span.table_ref,
            span.offset_start,
            span.offset_end,
            span.chunk_id,
            span.chunk_hash,
            span.chunk_label,
          );
        });
      }

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getBundle(bundleId: string): SemanticBundle | null {
    return this.getStoredBundle(bundleId)?.bundle ?? null;
  }

  getStoredBundle(bundleId: string): StoredSemanticBundle | null {
    const row = this.db.prepare(`
      SELECT
        bundle_json,
        published_collection_id,
        published_manifest_version,
        published_at
      FROM semantic_bundles
      WHERE bundle_id = ?
    `).get(bundleId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      bundle: SemanticBundleSchema.parse(JSON.parse(String(row["bundle_json"])) as unknown),
      publication: this.toPublicationState(row),
    };
  }

  listBundles(): SemanticBundleSummary[] {
    const rows = this.db.prepare(`
      SELECT
        bundle_id,
        source_path,
        review_status,
        total_units,
        average_quality_score,
        duplicate_group_count,
        published_collection_id,
        published_manifest_version,
        published_at
      FROM semantic_bundles
      ORDER BY generated_at DESC, bundle_id DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      bundleId: String(row["bundle_id"]),
      sourcePath: String(row["source_path"]),
      reviewStatus: String(row["review_status"]) as SemanticBundleSummary["reviewStatus"],
      totalUnits: Number(row["total_units"]),
      averageQualityScore: Number(row["average_quality_score"]),
      duplicateGroupCount: Number(row["duplicate_group_count"]),
      publishedCollectionId: row["published_collection_id"] === null ? null : String(row["published_collection_id"]),
      publishedManifestVersion:
        row["published_manifest_version"] === null ? null : Number(row["published_manifest_version"]),
      publishedAt: row["published_at"] === null ? null : String(row["published_at"]),
    }));
  }

  listPublishedUnitLookups(collectionId?: string): SemanticUnitLookup[] {
    const rows = this.db.prepare(`
      SELECT
        b.published_collection_id,
        u.unit_id,
        s.source_uri,
        s.content_type,
        s.chunk_id
      FROM semantic_units u
      INNER JOIN semantic_bundles b ON b.bundle_id = u.bundle_id
      INNER JOIN semantic_spans s
        ON s.unit_id = u.unit_id
       AND s.bundle_id = u.bundle_id
       AND s.span_index = 0
      WHERE b.published_collection_id IS NOT NULL
        AND (? IS NULL OR b.published_collection_id = ?)
      ORDER BY b.bundle_id, u.unit_id
    `).all(collectionId ?? null, collectionId ?? null) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      chunkId: `semantic:${String(row["unit_id"])}`,
      sourcePath: String(row["source_uri"]),
      contentType: String(row["content_type"]),
      dedupeKey: String(row["chunk_id"]),
      collectionId: row["published_collection_id"] === null ? null : String(row["published_collection_id"]),
    }));
  }

  getPublishedUnitLookup(chunkId: string): SemanticUnitLookup | null {
    const unitId = chunkId.startsWith("semantic:") ? chunkId.slice("semantic:".length) : chunkId;
    const row = this.db.prepare(`
      SELECT
        b.published_collection_id,
        u.unit_id,
        s.source_uri,
        s.content_type,
        s.chunk_id
      FROM semantic_units u
      INNER JOIN semantic_bundles b ON b.bundle_id = u.bundle_id
      INNER JOIN semantic_spans s
        ON s.unit_id = u.unit_id
       AND s.bundle_id = u.bundle_id
       AND s.span_index = 0
      WHERE u.unit_id = ?
        AND b.published_collection_id IS NOT NULL
      LIMIT 1
    `).get(unitId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      chunkId: `semantic:${String(row["unit_id"])}`,
      sourcePath: String(row["source_uri"]),
      contentType: String(row["content_type"]),
      dedupeKey: String(row["chunk_id"]),
      collectionId: row["published_collection_id"] === null ? null : String(row["published_collection_id"]),
    };
  }

  findPublishedBundleForDoc(docId: string, collectionId: string): SemanticPublishedBundleRef | null {
    const row = this.db.prepare(`
      SELECT
        bundle_id,
        doc_id,
        published_collection_id
      FROM semantic_bundles
      WHERE doc_id = ?
        AND published_collection_id = ?
      ORDER BY published_at DESC, bundle_id DESC
      LIMIT 1
    `).get(docId, collectionId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      bundleId: String(row["bundle_id"]),
      docId: String(row["doc_id"]),
      collectionId: String(row["published_collection_id"]),
    };
  }

  hasPublishedCollection(collectionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM semantic_bundles
      WHERE published_collection_id = ?
      LIMIT 1
    `).get(collectionId) as Record<string, unknown> | undefined;

    return row !== undefined;
  }

  updateReview(bundleId: string, review: SemanticReviewDecision): SemanticBundle {
    const bundle = this.getBundle(bundleId);
    if (!bundle) {
      throw new Error(`Semantic bundle "${bundleId}" not found`);
    }
    const updated = SemanticBundleSchema.parse({ ...bundle, review });
    this.upsertBundle(updated);
    return updated;
  }

  markPublished(bundleId: string, state: SemanticPublicationState): void {
    this.db.prepare(`
      UPDATE semantic_bundles
      SET
        published_collection_id = ?,
        published_manifest_version = ?,
        published_at = ?
      WHERE bundle_id = ?
    `).run(
      state.collectionId,
      state.manifestVersion,
      state.publishedAt,
      bundleId,
    );
  }

  clearPublished(bundleId: string): void {
    this.db.prepare(`
      UPDATE semantic_bundles
      SET
        published_collection_id = NULL,
        published_manifest_version = NULL,
        published_at = NULL
      WHERE bundle_id = ?
    `).run(bundleId);
  }

  getSchemaVersion(): number {
    const row = this.db.prepare(`
      SELECT value
      FROM semantic_store_metadata
      WHERE key = 'schema_version'
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error("Semantic store schema version metadata is missing");
    }

    return Number(row["value"]);
  }

  close(): void {
    this.db.close();
  }

  private toPublicationState(row: Record<string, unknown>): SemanticPublicationState | null {
    if (row["published_collection_id"] === null) {
      return null;
    }

    return {
      collectionId: String(row["published_collection_id"]),
      manifestVersion: Number(row["published_manifest_version"]),
      publishedAt: String(row["published_at"]),
    };
  }

  private migrateSchema(): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.createBaseSchema();
      this.ensureMetadataTable();

      const currentVersion = this.readSchemaVersion();
      if (currentVersion === null) {
        this.writeSchemaVersion(SEMANTIC_STORE_SCHEMA_VERSION);
      } else if (currentVersion > SEMANTIC_STORE_SCHEMA_VERSION) {
        throw new Error(
          `Semantic store schema version ${String(currentVersion)} is newer than this build supports `
          + `(${String(SEMANTIC_STORE_SCHEMA_VERSION)})`,
        );
      }

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private createBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_bundles (
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

      CREATE TABLE IF NOT EXISTS semantic_units (
        unit_id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        summary TEXT NOT NULL,
        answer TEXT NOT NULL,
        quality_score REAL NOT NULL,
        duplicate_group_id TEXT,
        duplicate_group_size INTEGER,
        FOREIGN KEY(bundle_id) REFERENCES semantic_bundles(bundle_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_spans (
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
        PRIMARY KEY(unit_id, span_index),
        FOREIGN KEY(bundle_id) REFERENCES semantic_bundles(bundle_id) ON DELETE CASCADE,
        FOREIGN KEY(unit_id) REFERENCES semantic_units(unit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_bundles_published_collection
        ON semantic_bundles(published_collection_id);

      CREATE INDEX IF NOT EXISTS idx_semantic_spans_unit_span
        ON semantic_spans(unit_id, span_index);

      CREATE INDEX IF NOT EXISTS idx_semantic_spans_chunk_id
        ON semantic_spans(chunk_id);
    `);
  }

  private ensureMetadataTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private readSchemaVersion(): number | null {
    const row = this.db.prepare(`
      SELECT value
      FROM semantic_store_metadata
      WHERE key = 'schema_version'
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return Number(row["value"]);
  }

  private writeSchemaVersion(version: number): void {
    this.db.prepare(`
      INSERT INTO semantic_store_metadata (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(version));
  }
}
