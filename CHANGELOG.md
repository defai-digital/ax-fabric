# Changelog

## v1.8.0

Canonical semantic store and publication release.

### Highlights

- Added a canonical SQLite-backed `SemanticStore` using Node.js 22 built-in `node:sqlite` for durable, idempotent storage of semantic bundles, units, source spans, review state, and publication metadata
- Established the architecture boundary: SQLite (`semantic.db`) for semantic artifact truth, AkiDB for retrieval serving
- Added `ax-fabric semantic store <file>` to create a bundle and persist it to the canonical store in one step
- Added `ax-fabric semantic bundles` to list all stored bundles with review and publication status
- Added `ax-fabric semantic show <bundleId>` to inspect a stored bundle with diagnostics
- Added `ax-fabric semantic approve-store <bundleId>` to approve or reject a stored bundle and persist the decision without JSON file round-trips
- Added `ax-fabric semantic publish <bundleId>` to embed semantic units and publish them as retrieval-ready records into a named AkiDB collection
- Added publication state tracking: target collection, manifest version, and publication timestamp are persisted back into `semantic.db` after each publish
- Added regression coverage for `SemanticStore` and all five new semantic store CLI commands

### Notes

- `v1.8.0` makes semantic distillation operationally real: bundles survive re-runs, review decisions are durable, and approved artifacts can be published into AkiDB
- published semantic units live in a separate AkiDB collection (default: `<collection>-semantic`) alongside raw chunk records — retrieval fusion is the `v1.9` scope
- JSON bundle file workflows from `v1.7.0` remain usable and backward compatible

## v1.7.0

Semantic review and governance release.

### Highlights

- Added semantic bundle contracts with diagnostics, duplicate-group summaries, and persisted review decisions
- Added a semantic review engine for bundle creation, inspection, approval, and rejection workflows
- Added `ax-fabric semantic review <file>` to generate review diagnostics from a source document
- Added `ax-fabric semantic bundle <file> --output <path>` and `ax-fabric semantic inspect <bundle>` for durable review artifacts
- Added `ax-fabric semantic approve <bundle> --reviewer <name>` with approval thresholds and duplicate policies
- Fixed semantic approval so `--min-quality` is enforced directly, not indirectly through the diagnostics threshold
- Fixed reviewed bundle output so approval no longer overwrites the source bundle by default and instead writes `*.reviewed.json`
- Added regression coverage for bundle contracts, approval policies, and non-destructive reviewed bundle output

### Notes

- `v1.7.0` productionizes the semantic engine through CLI-first review and governance flows
- semantic review remains file and bundle based; semantic artifacts are still not indexed into retrieval by default
- Studio/UI workflows remain future work beyond this release

## v1.6.0

Core `SemanticDistill Engine` release.

### Highlights

- Added first-class semantic unit contracts with grounded provenance, source spans, quality scores, and duplicate-group metadata
- Added a deterministic semantic distillation engine that derives semantic units from extracted source text without changing the existing ingest pipeline
- Added `ax-fabric semantic preview <file>` for operator-facing semantic unit inspection
- Added `ax-fabric semantic export <file> --output <path>` for JSON export of semantic units and provenance
- Added markdown extractor registration to the default registry so semantic workflows support `.md` and `.markdown` files out of the box
- Fixed TypeScript pipeline metric typing so workspace typecheck remains clean with the `v1.5.5` ingest quality metrics
- Added regression coverage for semantic contracts, semantic distillation, semantic CLI flows, markdown extractor registration, and updated config fixtures

### Notes

- `v1.6.0` introduces the semantic artifact engine as an additive layer; raw chunk ingest and retrieval remain intact
- semantic units are previewable and exportable in this release, but are not yet indexed into retrieval by default
- review, governance, and UI workflows remain the `v1.7.0` scope

## v1.5.5

Patch release for `v1.5` retrieval and ingest quality hardening.

### Highlights

- Added `ingest.chunking.strategy` with `auto | fixed | markdown | structured` support across CLI and MCP ingest paths
- Added `metadata.chunk_label` to stored records so chunk structure is preserved through indexing
- Added ingest quality metrics including total chunks, average chunk size, duplicate chunk count and ratio, chunk count by source, and label distribution
- Fixed registry and pipeline invalidation so chunking configuration changes force re-ingest of unchanged files instead of leaving stale indexed data
- Fixed skipped no-content files so they retain pipeline signature state and do not reprocess forever
- Fixed `fabric_ingest_diff` to account for pipeline-signature drift rather than fingerprint-only comparisons
- Added regression coverage for chunking strategy selection, metadata passthrough, quality metrics, registry pipeline signature persistence, and strategy-change re-ingestion

### Notes

- `v1.5.5` is a scoped quality release, not the full semantic-distillation program
- Verified with targeted contracts, ingest, registry, observer, and MCP test coverage

## v1.5.1

Patch release for `v1.5`.

### Highlights

- Fixed MCP keyword search so `fabric_search` no longer requires embeddings in `mode: "keyword"`
- Fixed MCP server shutdown to close the embedder/provider cleanly on startup failure and signal-driven exit
- Fixed memory record writes so reusing the same `id` updates the existing record instead of duplicating it
- Fixed `ax-fabric memory` limit parsing and normalized invalid `--limit` input to the standard CLI error path
- Added MCP and memory regression coverage for the new bugfix paths

### Notes

- `v1.5.0` remains the feature release for the memory/context backbone
- `v1.5.1` is a stability patch release for MCP and memory workflows

## v1.5.0

Memory and context backbone release.

### Highlights

- Added a durable local memory store with short-term and long-term memory records
- Added `ax-fabric memory` commands for put/list/show/delete/assemble workflows
- Added session and workflow-scoped context assembly
- Integrated assembled memory context into `search --answer` flows
- Added `MEMORY.md` to document the `v1.5` memory model and operator workflow

### Notes

- Use `ax-fabric memory assemble --session <id>` to build durable context
- Use `ax-fabric search ... --answer --session <id>` to combine memory context with retrieved document context

## v1.4.0

Retrieval quality and explainability release.

### Highlights

- Fixed `ax-fabric search` to support documented `--mode vector|keyword|hybrid` behavior
- Added `--explain` and `--json` to the search CLI for explainable and machine-readable retrieval output
- Added `ax-fabric eval` for fixture-based comparison across vector, keyword, and hybrid retrieval
- Fixed `EmbeddingScheduler.close()` so queued embedding work is rejected cleanly during shutdown instead of hanging
- Added `SEARCH_QUALITY.md` to document the `v1.4` evaluation workflow

### Notes

- Use `ax-fabric search --mode hybrid --explain --json` for per-query analysis
- Use `ax-fabric eval <fixture.json>` for repeatable Hit@K-style mode comparison

## v1.3.0

Enterprise offline stack operability release.

### Highlights

- Added `ax-fabric doctor` for local readiness, source-path, env-var, and endpoint checks
- Added machine-readable `--json` output for stack diagnostics and automation workflows
- Added `OPERATIONS.md` for startup order, troubleshooting, and reproducible local-stack demos
- Expanded stack guidance to clarify `ax-cli`, `ax-studio`, and `ax-serving` roles in the AX Fabric product family

### Notes

- See `OPERATIONS.md` for the recommended `v1.3` operating model
- See `STACK.md` for product-family architecture and endpoint responsibilities

## v1.2.1

Documentation and positioning update for the enterprise offline AI direction.

### Highlights

- Clarified AX Fabric as the core product for enterprise offline knowledge, retrieval, memory, and context
- Added product-family guidance covering `ax-cli`, `ax-studio`, and `ax-serving`
- Added a dedicated stack guide for the `v1.2.x` evaluation path
- Reframed QUICKSTART around first evaluation of the offline stack instead of a standalone vector-search demo

### Notes

- See `STACK.md` for the recommended product-family architecture
- See `QUICKSTART.md` for the updated first evaluation path

## v1.2.0

First public release of AX Fabric.

### Highlights

- Public release baseline established at `v1.2.0`
- Dual-license model introduced:
  - GNU AGPL v3 or later for open-source use
  - separate commercial licensing for Business and Enterprise use
- Public contribution policy clarified:
  - issue reports and feedback are welcome
  - unsolicited public code contributions are not accepted
- Licensing metadata normalized across TypeScript, Rust, and Python package surfaces

### Notes

- Business and Enterprise licensing terms are described in `LICENSE-COMMERCIAL.md`
- Issue-reporting policy is described in `CONTRIBUTING.md`
