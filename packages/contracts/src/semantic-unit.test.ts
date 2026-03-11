/**
 * Tests for SemanticUnitSchema and SemanticQualitySignalsSchema (contracts).
 *
 * Validates the Zod schemas introduced in the semantic-unit module,
 * including the new quality_signals and themes fields.
 */

import { describe, it, expect } from "vitest";
import { SemanticUnitSchema, SemanticQualitySignalsSchema } from "./semantic-unit.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const validSpan = {
  source_uri: "/docs/guide.md",
  content_type: "md" as const,
  page_range: null,
  table_ref: null,
  offset_start: 0,
  offset_end: 128,
  chunk_id: "chunk-abc",
  chunk_hash: "sha256-hash",
  chunk_label: "paragraph" as const,
};

const validUnit = {
  unit_id: "unit-001",
  doc_id: "doc-abc",
  doc_version: "v1",
  title: "Introduction to Vectors",
  question: "What are vectors?",
  summary: "Vectors represent points in high-dimensional space.",
  answer: "A vector is a list of numbers.",
  keywords: ["vector", "embedding", "space"],
  entities: ["AkiDB"],
  quality_score: 0.85,
  distill_strategy: "extractive-v1" as const,
  source_spans: [validSpan],
};

// ─── SemanticQualitySignalsSchema ─────────────────────────────────────────────

describe("SemanticQualitySignalsSchema", () => {
  it("accepts a valid quality signals object", () => {
    const signals = {
      coverage: 0.8,
      density: 0.6,
      structure: 0.7,
      noise_penalty: 0.1,
      confidence: 0.9,
      flags: ["low_density"],
    };
    expect(() => SemanticQualitySignalsSchema.parse(signals)).not.toThrow();
  });

  it("accepts signals with an empty flags array", () => {
    const signals = {
      coverage: 0.5,
      density: 0.5,
      structure: 0.5,
      noise_penalty: 0.0,
      confidence: 0.5,
      flags: [],
    };
    expect(() => SemanticQualitySignalsSchema.parse(signals)).not.toThrow();
  });

  it("rejects flags with more than 8 entries", () => {
    const signals = {
      coverage: 0.5,
      density: 0.5,
      structure: 0.5,
      noise_penalty: 0.0,
      confidence: 0.5,
      flags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], // 9 items
    };
    expect(() => SemanticQualitySignalsSchema.parse(signals)).toThrow();
  });

  it("rejects empty-string flags", () => {
    const signals = {
      coverage: 0.5,
      density: 0.5,
      structure: 0.5,
      noise_penalty: 0.0,
      confidence: 0.5,
      flags: [""],
    };
    expect(() => SemanticQualitySignalsSchema.parse(signals)).toThrow();
  });

  it("rejects values outside 0..1 range", () => {
    for (const field of ["coverage", "density", "structure", "noise_penalty", "confidence"] as const) {
      expect(() =>
        SemanticQualitySignalsSchema.parse({ ...{ coverage: 0.5, density: 0.5, structure: 0.5, noise_penalty: 0.0, confidence: 0.5, flags: [] }, [field]: 1.5 }),
      ).toThrow();

      expect(() =>
        SemanticQualitySignalsSchema.parse({ ...{ coverage: 0.5, density: 0.5, structure: 0.5, noise_penalty: 0.0, confidence: 0.5, flags: [] }, [field]: -0.1 }),
      ).toThrow();
    }
  });

  it("accepts boundary values of 0 and 1", () => {
    const signals = {
      coverage: 0,
      density: 1,
      structure: 0,
      noise_penalty: 1,
      confidence: 0,
      flags: [],
    };
    expect(() => SemanticQualitySignalsSchema.parse(signals)).not.toThrow();
  });
});

// ─── SemanticUnitSchema — required fields ─────────────────────────────────────

describe("SemanticUnitSchema — required fields", () => {
  it("accepts a minimal valid semantic unit", () => {
    const result = SemanticUnitSchema.safeParse(validUnit);
    expect(result.success).toBe(true);
  });

  it("rejects unit with empty unit_id", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, unit_id: "" })).toThrow();
  });

  it("rejects unit with empty title", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, title: "" })).toThrow();
  });

  it("rejects unit with empty question", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, question: "" })).toThrow();
  });

  it("rejects unit with empty summary", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, summary: "" })).toThrow();
  });

  it("rejects unit with empty answer", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, answer: "" })).toThrow();
  });

  it("rejects quality_score below 0", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, quality_score: -0.1 })).toThrow();
  });

  it("rejects quality_score above 1", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, quality_score: 1.1 })).toThrow();
  });

  it("accepts quality_score at boundary values 0 and 1", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, quality_score: 0 })).not.toThrow();
    expect(() => SemanticUnitSchema.parse({ ...validUnit, quality_score: 1 })).not.toThrow();
  });

  it("rejects an empty source_spans array", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, source_spans: [] })).toThrow();
  });

  it("accepts source_spans with multiple entries", () => {
    const result = SemanticUnitSchema.safeParse({
      ...validUnit,
      source_spans: [validSpan, { ...validSpan, chunk_id: "chunk-xyz", offset_start: 128, offset_end: 256 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 12 keywords", () => {
    const manyKeywords = Array.from({ length: 13 }, (_, i) => `kw${i}`);
    expect(() => SemanticUnitSchema.parse({ ...validUnit, keywords: manyKeywords })).toThrow();
  });

  it("rejects more than 12 entities", () => {
    const manyEntities = Array.from({ length: 13 }, (_, i) => `entity${i}`);
    expect(() => SemanticUnitSchema.parse({ ...validUnit, entities: manyEntities })).toThrow();
  });

  it("rejects empty-string keywords", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, keywords: [""] })).toThrow();
  });

  it("rejects unknown distill_strategy values", () => {
    expect(() =>
      SemanticUnitSchema.parse({ ...validUnit, distill_strategy: "unknown-strategy" }),
    ).toThrow();
  });
});

// ─── SemanticUnitSchema — optional fields ─────────────────────────────────────

describe("SemanticUnitSchema — optional fields", () => {
  it("accepts unit without quality_signals (field is optional)", () => {
    const { quality_signals: _, ...withoutSignals } = { ...validUnit, quality_signals: undefined };
    const result = SemanticUnitSchema.safeParse(withoutSignals);
    expect(result.success).toBe(true);
  });

  it("accepts unit with valid quality_signals", () => {
    const signals = {
      coverage: 0.75,
      density: 0.6,
      structure: 0.8,
      noise_penalty: 0.05,
      confidence: 0.9,
      flags: ["well_structured"],
    };
    const result = SemanticUnitSchema.safeParse({ ...validUnit, quality_signals: signals });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quality_signals?.confidence).toBe(0.9);
    }
  });

  it("rejects unit with invalid quality_signals", () => {
    const badSignals = { coverage: 2.0, density: 0.5, structure: 0.5, noise_penalty: 0, confidence: 0.5, flags: [] };
    expect(() => SemanticUnitSchema.parse({ ...validUnit, quality_signals: badSignals })).toThrow();
  });

  it("accepts unit without themes (field is optional)", () => {
    const result = SemanticUnitSchema.safeParse(validUnit); // no themes field
    expect(result.success).toBe(true);
  });

  it("accepts unit with valid themes array", () => {
    const result = SemanticUnitSchema.safeParse({
      ...validUnit,
      themes: ["machine-learning", "vector-search"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.themes).toEqual(["machine-learning", "vector-search"]);
    }
  });

  it("rejects themes array with more than 8 entries", () => {
    const manyThemes = Array.from({ length: 9 }, (_, i) => `theme-${i}`);
    expect(() => SemanticUnitSchema.parse({ ...validUnit, themes: manyThemes })).toThrow();
  });

  it("rejects empty-string themes", () => {
    expect(() => SemanticUnitSchema.parse({ ...validUnit, themes: [""] })).toThrow();
  });

  it("accepts unit without duplicate_group_id (field is optional)", () => {
    const result = SemanticUnitSchema.safeParse(validUnit);
    expect(result.success).toBe(true);
  });

  it("accepts unit with duplicate_group_id and duplicate_group_size", () => {
    const result = SemanticUnitSchema.safeParse({
      ...validUnit,
      duplicate_group_id: "group-xyz",
      duplicate_group_size: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate_group_size of 0 (must be positive)", () => {
    expect(() =>
      SemanticUnitSchema.parse({ ...validUnit, duplicate_group_id: "g", duplicate_group_size: 0 }),
    ).toThrow();
  });
});

// ─── SemanticSourceSpanSchema ─────────────────────────────────────────────────

describe("SemanticSourceSpanSchema (via SemanticUnitSchema)", () => {
  it("accepts a span with null page_range and table_ref", () => {
    const result = SemanticUnitSchema.safeParse(validUnit);
    expect(result.success).toBe(true);
  });

  it("rejects a span with negative offset_start", () => {
    const badSpan = { ...validSpan, offset_start: -1 };
    expect(() => SemanticUnitSchema.parse({ ...validUnit, source_spans: [badSpan] })).toThrow();
  });

  it("rejects a span with negative offset_end", () => {
    const badSpan = { ...validSpan, offset_end: -1 };
    expect(() => SemanticUnitSchema.parse({ ...validUnit, source_spans: [badSpan] })).toThrow();
  });

  it("rejects a span with empty chunk_id", () => {
    const badSpan = { ...validSpan, chunk_id: "" };
    expect(() => SemanticUnitSchema.parse({ ...validUnit, source_spans: [badSpan] })).toThrow();
  });

  it("rejects a span with empty chunk_hash", () => {
    const badSpan = { ...validSpan, chunk_hash: "" };
    expect(() => SemanticUnitSchema.parse({ ...validUnit, source_spans: [badSpan] })).toThrow();
  });
});
