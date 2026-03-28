# AX Fabric

**Category:** Governed Semantic Runtime

**Product:** The governed document and semantic backend for private AI systems.

[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.22-blueviolet)](https://pnpm.io)
[![Tests](https://img.shields.io/badge/tests-1353%20passing-brightgreen)](./packages)
[![Test Files](https://img.shields.io/badge/test%20files-67-blue)](./packages)

AX Fabric is a commercial backend component that ingests enterprise documents into AkiDB, applies governed semantic workflows on top of that corpus, and serves the resulting knowledge layer to private AI systems.

AX Studio is the free client in the product family. AX Fabric is the billable backend. Teams can use AX Studio out of the box, connect their own tools, or engage AutomatosX to build custom tools and workflows on top of AX Fabric.

## What AX Fabric Does

AX Fabric combines three layers that are usually sold separately:

1. **Document ingestion**
   Extract, normalize, chunk, embed, and index enterprise documents incrementally into AkiDB.
2. **Governed semantic lifecycle**
   Distill source material into semantic units, review them, approve them, publish them, and roll them back when needed.
3. **Backend delivery**
   Serve raw retrieval, semantic retrieval, or fused retrieval to AX Studio, custom tools, MCP workflows, and private AI applications.

The key boundary is:

- `AkiDB` is the raw retrieval and indexing engine
- `semantic.db` is the canonical semantic store and publication state

## Why This Exists

Most adjacent products stop at one layer:

- extraction and chunking
- vector indexing and search
- enterprise search UI

AX Fabric is designed for teams that need all of the following in one deployable backend:

- private or on-premise document ingestion
- incremental indexing into a local retrieval engine
- review-before-retrieval semantic controls
- provenance, publication state, and rollback
- a licensable backend component instead of a locked front-end product

## Current v3.0 Scope

**Available now**

- document ingestion into AkiDB
- governed semantic distillation, review, approval, publication, and rollback
- vector, keyword, hybrid, semantic-only, and fused retrieval
- CLI, daemon, MCP, and custom-tool integration paths
- private deployment and commercial backend licensing

**Near-term expansion**

- enterprise mail workflow expansion (`.msg`, mailbox sync, thread reconstruction)

**Not current scope**

- image ingestion
- voice or audio ingestion
- generic multimodal platform positioning

## Supported Source Types Today

Current built-in extractors support:

- `txt`
- `md`
- `pdf`
- `docx`
- `pptx`
- `xlsx`
- `csv`
- `tsv`
- `json`
- `jsonl`
- `yaml`
- `html`
- `rtf`
- `sql`
- `log`
- `eml`

For a first-run walkthrough, see [QUICKSTART.md](./QUICKSTART.md).

## Who Buys It

AX Fabric is built for teams that need a governed backend for enterprise knowledge, not just another UI:

- internal tools and AI platform teams
- compliance-sensitive document and knowledge systems
- operations teams managing SOPs, policies, and technical documentation
- regulated organizations that need private deployment and controlled knowledge release
- teams building AX Studio deployments, custom AI applications, or MCP workflows on top of governed data

AX Fabric is a strong fit when you need:

- a commercial backend component for document ingestion and AI retrieval
- a private deployment story that is not tied to a cloud-first SaaS front end
- semantic publication controls layered on top of retrieval
- the option to use AX Studio, bring your own tools, or commission custom integrations

## Product Workflow

The core product loop is:

```text
source files
  -> scan / diff
  -> extract / normalize / chunk
  -> embed / index into AkiDB
  -> distill semantic units
  -> review / approve
  -> publish
  -> retrieve
  -> rollback / republish
```

This is the main distinction of AX Fabric:

- documents are the entry point
- retrieval is the serving layer
- semantic governance is the control layer

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

For the full first-run guide, embedder setup, ingestion workflow, semantic workflow, and MCP setup, see [QUICKSTART.md](./QUICKSTART.md).

## Main Interfaces

### CLI

Run AX Fabric as a local ingestion and retrieval backend:

```bash
pnpm exec ax-fabric ingest run
pnpm exec ax-fabric search "query" --mode hybrid --top-k 5
pnpm exec ax-fabric semantic bundles
```

### Daemon

Run continuous ingestion for changing document sets:

```bash
pnpm exec ax-fabric daemon start
pnpm exec ax-fabric daemon status
pnpm exec ax-fabric daemon stop
```

### MCP

Expose AX Fabric to Claude, Gemini, or any MCP-compatible client:

```bash
pnpm exec ax-fabric mcp server
pnpm exec ax-fabric mcp token generate
```

## Semantic Lifecycle Commands

Main semantic commands:

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

## Licensing And Commercial Use

AX Fabric is dual-licensed:

- **Open-source use:** `AGPL-3.0-or-later`
- **Commercial use:** available under separate written license

Commercial licensing is intended for organizations that want to use AX Fabric as a proprietary backend component for document ingestion, governed semantic workflows, private AI retrieval, internal platforms, customer-delivered solutions, or custom enterprise workflows.

Commercial engagements may include:

- commercial runtime licensing
- private deployment rights
- custom tool and connector development
- custom workflow integration
- support and service terms

See [LICENSING.md](./LICENSING.md) and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

## Product Context

AX Fabric is the governed document and semantic backend in the product family.

- `ax-fabric`: commercial document + semantic backend, retrieval, MCP
- `ax-studio`: free user-facing client and reference interface
- `ax-cli`: operator and developer endpoint
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
