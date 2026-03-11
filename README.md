# AX Fabric

Offline semantic workflow core for ingest, retrieval, and governed publication.

[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.22-blueviolet)](https://pnpm.io)
[![Tests](https://img.shields.io/badge/tests-1353%20passing-brightgreen)](./packages)
[![Test Files](https://img.shields.io/badge/test%20files-67-blue)](./packages)

AX Fabric turns local documents into searchable raw chunks and reviewable semantic artifacts. It keeps semantic truth separate from the retrieval index and exposes the same workflow through CLI, library, and MCP interfaces.

It is built for teams that want:

- local or air-gapped deployment
- one stack for ingestion, retrieval, semantic review, and publication
- semantic artifacts that can be approved before they become searchable
- direct integration into developer tools and MCP clients

## Overview

AX Fabric gives you four connected layers:

1. **Ingestion**
   Extract, normalize, chunk, embed, and index local files incrementally.
2. **Semantic workflow**
   Distill source material into semantic units, review them, approve them, and publish them.
3. **Retrieval**
   Search raw chunks, semantic units, or both with vector, keyword, and fused retrieval.
4. **Integration**
   Use the same knowledge layer through CLI, TypeScript, Python, and MCP.

The key architectural boundary is:

- `semantic.db` is the canonical semantic store
- `AkiDB` is the retrieval index and search engine

If you are evaluating the project for the first time, start with [QUICKSTART.md](./QUICKSTART.md).

## Why Teams Use It

- Vector search with HNSW ANN
- Keyword search with BM25 / FTS5
- Hybrid search with RRF fusion
- Incremental, idempotent ingestion
- 15-format document extraction
- Semantic unit generation with grounded provenance
- Review, approval, and publication workflows
- Semantic-layer search and raw/semantic fusion
- Local memory and context assembly
- MCP server for agent and tool integration

## Quickstart

The fastest path is:

```bash
pnpm install
pnpm build
pnpm exec ax-fabric init

# Add documents and ingest them
pnpm exec ax-fabric ingest add ./docs
pnpm exec ax-fabric ingest run

# Search raw content
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid

# Create and publish semantic artifacts
pnpm exec ax-fabric semantic store ./docs/architecture.md
pnpm exec ax-fabric semantic bundles
pnpm exec ax-fabric semantic approve-store <bundle-id> --reviewer ops --min-quality 0.6 --duplicate-policy warn
pnpm exec ax-fabric semantic publish <bundle-id>

# Search semantic artifacts directly
pnpm exec ax-fabric search "authentication token expiry" --semantic
pnpm exec ax-fabric search "authentication token expiry" --fuse
```

For the full first-run guide, embedder setup, semantic workflow, and MCP setup, see [QUICKSTART.md](./QUICKSTART.md).

## Operating Modes

### CLI

Run AX Fabric as a local knowledge pipeline:

```bash
pnpm exec ax-fabric ingest run
pnpm exec ax-fabric search "query" --mode hybrid --top-k 5
pnpm exec ax-fabric semantic bundles
```

### Daemon

Run continuous ingestion for changing document sets:

```bash
pnpm exec ax-fabric ingest daemon start
pnpm exec ax-fabric ingest daemon status
pnpm exec ax-fabric ingest daemon stop
```

### MCP

Expose AX Fabric to Claude, Gemini, or any MCP-compatible client:

```bash
pnpm exec ax-fabric mcp server
pnpm exec ax-fabric mcp token generate
```

## Semantic Workflow

The semantic path is:

```text
source file
  -> semantic store
  -> approve-store
  -> publish
  -> search --semantic / --fuse / eval --compare
```

Main commands:

- `ax-fabric semantic preview <file>`
- `ax-fabric semantic store <file>`
- `ax-fabric semantic bundles`
- `ax-fabric semantic show <bundle-id>`
- `ax-fabric semantic approve-store <bundle-id>`
- `ax-fabric semantic publish <bundle-id>`
- `ax-fabric semantic republish <bundle-id>`
- `ax-fabric semantic rollback <bundle-id>`
- `ax-fabric semantic unpublish <bundle-id>`

## Retrieval Modes

| Mode | Use When |
| --- | --- |
| `vector` | semantic similarity matters most |
| `keyword` | exact term match matters most |
| `hybrid` | you want the best balanced recall |
| `--semantic` | search only published semantic units |
| `--fuse` | combine raw and semantic layers |

Useful commands:

```bash
pnpm exec ax-fabric search "jwt expiry" --mode keyword
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --explain
pnpm exec ax-fabric eval ./fixture.json
pnpm exec ax-fabric eval ./fixture.json --compare
```

## Benchmarking

AX Fabric includes a local benchmark harness for quick regression checks on:

- raw search latency
- semantic publish latency
- eval-style retrieval runtime

Useful commands:

```bash
pnpm exec ax-fabric benchmark search --docs 250 --runs 10 --warmup 3 --mode hybrid
pnpm exec ax-fabric benchmark semantic-publish --sections 20 --replace
pnpm exec ax-fabric benchmark eval --docs 250 --cases 25 --compare-semantic --json
```

Use this harness for local performance checks and CI smoke gates. It runs on synthetic corpora in a temporary workspace and does not modify your normal `~/.ax-fabric` data root.

## Editions And Scope

This repository is the **OSS + Business semantic workflow core**.

Enterprise-only governance, compliance, and private deployment features live in a separate private project.

| Capability | OSS | Business |
| --- | --- | --- |
| Local / self-hosted runtime | Yes | Yes |
| Vector / keyword / hybrid retrieval | Yes | Yes |
| Semantic distillation and publication workflow | Yes | Yes |
| CLI / MCP / SDK access | Yes | Yes |
| Commercial licensing terms | No | Yes |
| Support / commercial terms | No | By agreement |

See [LICENSING.md](./LICENSING.md) and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

## Product Context

AX Fabric is the core knowledge product in the stack.

- `ax-fabric`: ingestion, semantic workflow, retrieval, MCP
- `ax-cli`: operator and developer endpoint
- `ax-studio`: visual interface
- `ax-serving`: optional local model / embedding backend

See [STACK.md](./STACK.md) for the product-family view.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Native engine tests:

```bash
cd packages/akidb-native
cargo test
```

## Repository Layout

```text
packages/
  contracts/       shared schemas and TypeScript types
  akidb-native/    Rust engine
  akidb/           TypeScript API over the native engine
  fabric-ingest/   CLI, ingestion pipeline, semantic workflow, MCP server
  akidb-py/        Python bindings
```

## Documentation

- [QUICKSTART.md](./QUICKSTART.md)
- [OPERATIONS.md](./OPERATIONS.md)
- [SEARCH_QUALITY.md](./SEARCH_QUALITY.md)
- [MEMORY.md](./MEMORY.md)
- [STACK.md](./STACK.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CHANGELOG.md](./CHANGELOG.md)

## License

AGPL-3.0-or-later by default.

Commercial terms are available for Business users. See [LICENSE](./LICENSE), [LICENSING.md](./LICENSING.md), and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).
