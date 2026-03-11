# AX Fabric Search Quality Guide

This document defines the recommended `v1.4` workflow for retrieval quality, explainability, and repeatable search evaluation.

## Goal

The goal of `v1.4` is to make AX Fabric win on retrieval quality, not only on architecture.

That means operators and evaluators should be able to:

- compare vector, keyword, and hybrid retrieval on the same query,
- inspect why a result ranked where it did,
- capture machine-readable output for evaluation workflows,
- and use one consistent local workflow for search-quality validation.

## Core CLI Workflow

### Vector search

```bash
pnpm exec ax-fabric search "token expiry policy" --mode vector --top-k 5
```

### Keyword search

```bash
pnpm exec ax-fabric search "JWT expiry" --mode keyword --top-k 5
```

### Hybrid search

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --top-k 5
```

## Explainability

Use `--explain` when you want per-result ranking detail:

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --top-k 5 --explain
```

Explain output can include:

- vector score,
- BM25 score,
- RRF score,
- vector and BM25 ranks,
- matched terms,
- chunk preview.

This is the primary operator-facing tool for understanding retrieval behavior in `v1.4`.

## Machine-Readable Evaluation

Use `--json` when you want to capture search output for comparison, regression tracking, or external evaluation scripts.

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --top-k 5 --explain --json
```

The JSON payload includes:

- query,
- mode,
- topK,
- manifest version,
- result list,
- per-result explain data when requested.

Recommended use cases:

- compare retrieval modes on the same fixture set,
- store evaluation snapshots during releases,
- feed search output into internal quality review scripts.

## Fixture-Based Evaluation

Use `ax-fabric eval` when you want one command that compares vector, keyword, and hybrid retrieval over a fixed query set.

Fixture format:

```json
{
  "cases": [
    {
      "query": "authentication token expiry",
      "expected_sources": ["/abs/path/to/docs/auth.md"],
      "top_k": 5
    }
  ]
}
```

Run it:

```bash
pnpm exec ax-fabric eval ./eval-fixture.json
pnpm exec ax-fabric eval ./eval-fixture.json --json
```

This reports per-mode Hit@K results and gives you a repeatable baseline for release comparisons.

## Recommended Evaluation Pattern

For a retrieval-quality review, run the same query three ways:

1. `--mode vector`
2. `--mode keyword`
3. `--mode hybrid --explain --json`

Then compare:

- whether the expected documents appear,
- whether hybrid improves recall over either single mode,
- whether the explain output matches operator expectations,
- whether chunk previews and matched terms make the ranking understandable.

## What v1.4 Adds

`v1.4` is the phase where AX Fabric should become reviewable as a retrieval system.

Included in this phase:

- working CLI support for vector, keyword, and hybrid modes,
- explainable ranking output,
- machine-readable search output,
- fixture-based evaluation via `ax-fabric eval`,
- a documented operator workflow for retrieval-quality checks.

Not fully solved by this phase:

- full relevance datasets,
- automatic benchmark dashboards,
- cross-collection scoring policies,
- advanced reranking models.
