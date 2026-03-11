# Changelog

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
