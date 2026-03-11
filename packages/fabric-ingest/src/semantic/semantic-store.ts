import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SemanticBundle, SemanticReviewDecision } from "@ax-fabric/contracts";
import { SemanticBundleSchema } from "@ax-fabric/contracts";

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

export class SemanticStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.createSchema();
  }

  upsertBundle(bundle: SemanticBundle): void {
    const parsed = SemanticBundleSchema.parse(bundle);
    const existing = this.getBundleState(parsed.bundle_id);
    const review = parsed.review;

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
          published_collection_id = COALESCE(semantic_bundles.published_collection_id, excluded.published_collection_id),
          published_manifest_version = COALESCE(semantic_bundles.published_manifest_version, excluded.published_manifest_version),
          published_at = COALESCE(semantic_bundles.published_at, excluded.published_at)
      `).run(
        parsed.bundle_id,
        parsed.source_path,
        parsed.doc_id,
        parsed.doc_version,
        parsed.content_type,
        parsed.distill_strategy,
        parsed.generated_at,
        review?.status ?? "pending",
        review?.reviewer ?? null,
        review?.reviewed_at ?? null,
        review?.min_quality_score ?? null,
        review?.duplicate_policy ?? null,
        review ? JSON.stringify(review.blocking_issues) : null,
        review?.notes ?? null,
        parsed.diagnostics.total_units,
        parsed.diagnostics.average_quality_score,
        parsed.diagnostics.duplicate_groups.length,
        JSON.stringify(parsed),
        existing?.publishedCollectionId ?? null,
        existing?.publishedManifestVersion ?? null,
        existing?.publishedAt ?? null,
      );

      this.db.prepare("DELETE FROM semantic_units WHERE bundle_id = ?").run(parsed.bundle_id);
      this.db.prepare("DELETE FROM semantic_spans WHERE bundle_id = ?").run(parsed.bundle_id);

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

      for (const unit of parsed.units) {
        insertUnit.run(
          unit.unit_id,
          parsed.bundle_id,
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
            parsed.bundle_id,
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
    const row = this.db.prepare(`
      SELECT bundle_json
      FROM semantic_bundles
      WHERE bundle_id = ?
    `).get(bundleId) as { bundle_json: string } | undefined;

    if (!row) return null;
    return SemanticBundleSchema.parse(JSON.parse(row.bundle_json) as unknown);
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

  close(): void {
    this.db.close();
  }

  private getBundleState(bundleId: string): {
    publishedCollectionId: string | null;
    publishedManifestVersion: number | null;
    publishedAt: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT
        published_collection_id,
        published_manifest_version,
        published_at
      FROM semantic_bundles
      WHERE bundle_id = ?
    `).get(bundleId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      publishedCollectionId:
        row["published_collection_id"] === null ? null : String(row["published_collection_id"]),
      publishedManifestVersion:
        row["published_manifest_version"] === null ? null : Number(row["published_manifest_version"]),
      publishedAt: row["published_at"] === null ? null : String(row["published_at"]),
    };
  }

  private createSchema(): void {
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
    `);
  }
}
