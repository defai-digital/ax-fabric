# AX Fabric

Enterprise offline knowledge fabric for grounded AI systems.

Status: ✅ Active Development | pnpm Workspace | Rust + TypeScript | macOS + Linux

> 🎯 What AX Fabric Is: The product-level knowledge, retrieval, memory, and context layer for enterprise offline AI systems. It turns local files into searchable, MCP-accessible context without sending your data to the cloud.

> 💡 How It Is Positioned: AX Fabric is the primary product. Users should access AX Fabric through its endpoints and companion interfaces: `ax-cli` for developer workflows, `ax-studio` for visual workflows, and `ax-serving` as an optional serving backend for local embeddings, model execution, routing, and deployment.

---

## Positioning

AX Fabric is not just a vector database, and it is not trying to be a full agent framework.

AX Fabric is the enterprise offline knowledge fabric for AI systems:

- **Knowledge layer** — ingest local documents, normalize them, chunk them, and keep them current.
- **Retrieval layer** — search with vector, keyword, or hybrid retrieval from one local stack.
- **Memory layer** — expose grounded context that agents and AI tools can reuse consistently.
- **Integration layer** — surface the same knowledge through CLI, TypeScript, Python, and MCP.

This means the product story is:

- **AX Fabric** = the core product users adopt for enterprise knowledge, retrieval, memory, and context delivery.
- **ax-cli** = the developer-facing endpoint for setup, ingestion, search, and automation.
- **ax-studio** = the visual endpoint for workspace, search, and management experiences.
- **ax-serving** = a supporting execution layer that AX Fabric can use when local model serving is needed.

If you are evaluating the project, the simplest mental model is:

> AX Fabric gives offline AI systems a local knowledge and context fabric.  
> ax-cli and ax-studio are the main ways to use it.  
> ax-serving helps power parts of that fabric, but AX Fabric is the product.

## Why AX Fabric

Most AI retrieval stacks require a managed cloud vector database, a separate BM25 service, a hosted ingestion pipeline, and custom glue to expose that knowledge to applications and AI tools. AX Fabric collapses those pieces into one enterprise offline product.

- **No lock-in** — data and config live at `~/.ax-fabric` and follow your machine.
- **Incremental** — only changed files are re-processed; unchanged files are always skipped.
- **Three search modes** — vector (HNSW ANN), keyword (BM25 via FTS5), and hybrid (RRF fusion).
- **MCP-native** — 19 tools over stdio for direct AI agent integration without a REST server.
- **Offline-first by default** — your knowledge stays in your environment unless you choose an external embedding provider.

## Where AX Fabric Fits

```text
Users / Applications / AI tools / Agents
        │
        ▼
  ax-cli / ax-studio
        │
        ▼
     AX Fabric
        │
        ├── ingestion
        ├── indexing
        ├── retrieval
        ├── memory / knowledge access
        └── MCP-native integration
        │
        ▼
     Optional execution backends
        ├── Cloudflare Workers AI
        ├── OpenAI-compatible embedding APIs
        └── ax-serving for local serving / routing
```

Use AX Fabric when you want:

- an enterprise offline knowledge and context layer,
- grounded context for AI systems and AI tools,
- MCP-native access to private documents,
- one product that combines ingestion, indexing, and retrieval.

## Product Endpoints

AX Fabric is the core product, but most users will reach it through one of these endpoints:

- [`ax-cli`](https://github.com/defai-digital/ax-cli) for installation, setup, ingestion, search, and scripted developer workflows.
- [`ax-studio`](https://github.com/defai-digital/ax-studio) for visual access, workspace management, and interactive retrieval workflows.
- `ax-fabric` libraries and MCP interfaces when integrating directly into applications and AI tools.
- `ax-serving` when AX Fabric needs a local serving backend for embeddings or model execution.

This is the intended product stack:

- users adopt **AX Fabric** as the knowledge product,
- users operate it through **ax-cli** or **ax-studio**,
- AX Fabric can call **ax-serving** when local serving infrastructure is needed.

For the recommended `v1.2.x` product-family architecture and evaluation path, see [STACK.md](./STACK.md). For `v1.3` local-stack operability guidance, see [OPERATIONS.md](./OPERATIONS.md).

---

## Editions

Jump to: [OSS](#oss) | [Business](#business) | [Enterprise](#enterprise)

| Capability | OSS | Business | Enterprise |
| --- | --- | --- | --- |
| Vector search (HNSW ANN) | Yes | Yes | Yes |
| Keyword search (BM25 / FTS5) | Yes | Yes | Yes |
| Hybrid search with RRF fusion | Yes | Yes | Yes |
| 15-format document extractors | Yes | Yes | Yes |
| Incremental, idempotent ingestion | Yes | Yes | Yes |
| Continuous daemon mode | Yes | Yes | Yes |
| MCP server (19 tools) | Yes | Yes | Yes |
| Python bindings (PyO3) | Yes | Yes | Yes |
| FP16 and SQ8 quantization | Yes | Yes | Yes |
| Metadata filters and explain output | Yes | Yes | Yes |
| Local / self-hosted deployment | Yes | Yes | Yes |
| Single-node runtime | Yes | Yes | Yes |
| Multi-node Mac Grid | No | Yes | Yes |
| Multi-node NVIDIA CUDA Grid | No | No | Yes |
| Commercial licensing terms | No | Included | Included |
| Contracted support / SLA | No | By agreement | By agreement |
| Enterprise procurement / compliance | No | Optional | Included by agreement |

<details>
<summary><strong id="oss">OSS</strong></summary>

- License: AGPL-3.0-or-later by default, with commercial licensing available as an alternative.
- Includes the full AX Fabric runtime for single-node local deployments.
- Best for individual builders, research, and teams operating under open-source terms.
- Multi-node / grid deployment is not part of the OSS edition.

</details>

<details>
<summary><strong id="business">Business</strong></summary>

- Includes everything in OSS.
- Available under commercial terms (`LICENSE-COMMERCIAL.md`).
- Supports multi-node deployment on Mac Grid worker nodes.
- Companies with annual revenue under USD 2M can use Business features at no cost.
- Optional paid support licenses are available.

</details>

<details>
<summary><strong id="enterprise">Enterprise</strong></summary>

- Includes everything in Business.
- Supports multi-node deployment across Mac Grid and NVIDIA CUDA Grid.
- Includes NVIDIA Jetson Thor optimisations.
- Designed for enterprise-grade security, compliance, and procurement requirements.

</details>

Enterprise and license enquiries: `enquiry@automatosx.com`

---

## Core Capabilities

| Capability | AX Fabric |
|---|---|
| HNSW approximate nearest-neighbour search | ✅ |
| BM25 full-text search (FTS5) | ✅ |
| Hybrid search with Reciprocal Rank Fusion | ✅ |
| Pre-filter HNSW (metadata filters during graph traversal) | ✅ |
| WAL + immutable binary segment storage | ✅ |
| FP16 and SQ8 vector quantization | ✅ |
| Incremental, idempotent ingestion pipeline | ✅ |
| 15-format document extractors | ✅ |
| Continuous daemon mode with `SIGHUP` config reload | ✅ |
| MCP server (19 tools, bearer token auth) | ✅ |
| Python bindings (PyO3 + maturin) | ✅ |
| Metadata filters (`$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`, `$nin`) | ✅ |
| Per-query explain output (scores, ranks, chunk preview) | ✅ |
| Segment compaction and tombstone GC | ✅ |

---

## Quick Start (3 Steps)

### 1. Install + Build

```bash
pnpm install
pnpm build
```

Requirements: Node.js `>=22`, pnpm `10.22`, Rust toolchain.

Validate:

```bash
pnpm exec ax-fabric --help
```

### 2. Initialize + Configure Embedder

```bash
pnpm exec ax-fabric init
```

Edit `~/.ax-fabric/config.yaml` to set your embedder:

```yaml
# Cloudflare Workers AI
embedder:
  type: cloudflare
  model_id: "@cf/baai/bge-large-en-v1.5"
  dimension: 1024
  account_id: your-account-id
  api_key_env: CLOUDFLARE_API_TOKEN
```

```yaml
# OpenAI-compatible HTTP endpoint
embedder:
  type: http
  model_id: text-embedding-3-small
  dimension: 1536
  base_url: https://api.openai.com/v1/embeddings
  api_key_env: EMBEDDING_API_KEY
```

```yaml
# Local model via ax-serving
embedder:
  type: mcp
  model_id: bge-large-en-v1.5
  dimension: 1024
  base_url: http://127.0.0.1:18080/v1/embeddings
```

### 3. Ingest + Query

```bash
# Register a source directory and run ingestion
pnpm exec ax-fabric ingest add ./docs
pnpm exec ax-fabric ingest run

# Vector search (semantic)
pnpm exec ax-fabric search "how does authentication work?" --top-k 5

# Keyword search (BM25 / exact terms)
pnpm exec ax-fabric search "JWT expiry" --mode keyword

# Hybrid search (vector + BM25 fused with RRF — best recall)
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid
```

For full setup details (embedders, daemon, MCP, TypeScript API, and first evaluation flow), see [QUICKSTART.md](./QUICKSTART.md).

---

## Run Modes

### CLI (one-shot)

Ingest once, search interactively:

```bash
pnpm exec ax-fabric ingest run
pnpm exec ax-fabric ingest status
pnpm exec ax-fabric search "query" --top-k 5 --mode hybrid
```

### Daemon (continuous ingestion)

Long-running poll loop that detects file changes and re-ingests automatically:

```bash
pnpm exec ax-fabric ingest daemon start
pnpm exec ax-fabric ingest daemon status
pnpm exec ax-fabric ingest daemon stop
```

Handles `SIGINT`/`SIGTERM` (finish the current cycle, then exit) and `SIGHUP` (reload config without restart). Acquires a file lock so only one daemon runs per data directory.

### MCP Server (AI agent tooling)

Exposes ax-fabric as a tool provider over stdio for Claude, Gemini, and any MCP-compatible client:

```bash
pnpm exec ax-fabric mcp server
pnpm exec ax-fabric mcp token show
pnpm exec ax-fabric mcp token generate
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "ax-fabric": {
      "command": "pnpm",
      "args": ["exec", "ax-fabric", "mcp", "server"],
      "cwd": "/path/to/ax-fabric",
      "env": { "AX_FABRIC_MCP_TOKEN": "<token from token show>" }
    }
  }
}
```

---

## API Surface

### CLI Commands

- `ax-fabric init`
- `ax-fabric ingest add <path>` / `diff` / `run` / `status`
- `ax-fabric ingest daemon start` / `status` / `stop`
- `ax-fabric search <query> [--mode vector|keyword|hybrid] [--top-k N]`
- `ax-fabric mcp server` / `token show` / `token generate`
- `ax-fabric orchestrator start`
- `ax-fabric doctor [--check-serving]`

### TypeScript (`@ax-fabric/akidb`)

```typescript
import { AkiDB } from "@ax-fabric/akidb";

const db = new AkiDB({ storagePath: "./my-db" });

await db.createCollection({ collectionId: "docs", dimension: 1024, metric: "cosine", embeddingModelId: "bge-large-en-v1.5" });
await db.upsertBatch("docs", records);
await db.publish("docs");

const results = await db.search({
  collectionId: "docs",
  queryVector: new Float32Array(1024),
  topK: 5,
  mode: "hybrid",
  queryText: "authentication",
  filters: { type: { $in: ["pdf", "md"] } },
});

await db.close();
```

### MCP Tools

| Group | Count | Operations |
|---|---|---|
| `akidb_*` | 9 | Create / list / delete collections, upsert, search, compact, stats |
| `fabric_*` | 10 | Ingest run / diff / status, daemon control, search with mode |

---

## Authentication

The MCP server requires a bearer token. Generate one with `ax-fabric mcp token generate`, then set it in your client:

```bash
AX_FABRIC_MCP_TOKEN=<token>
```

Embedder API keys use env-var indirection in `config.yaml`. Set `api_key_env: MY_VAR`; the value is read from the environment at runtime and never written to config.

---

## Build, Lint, Test

```bash
pnpm install
pnpm build        # build all packages
pnpm test         # vitest run (625 unit tests)
pnpm lint         # eslint packages/
pnpm typecheck    # tsc -b

# Single test file or pattern
npx vitest run packages/akidb/src/akidb.test.ts
npx vitest run -t "search"

# Native engine (Rust unit tests)
cd packages/akidb-native && cargo test
```

Live integration tests require `CLOUDFLARE_API_TOKEN` and are skipped otherwise.

---

## Repository Layout

```
packages/
  contracts/       Zod schemas and shared TypeScript types
  akidb-native/    Rust NAPI engine — HNSW, WAL, segments, FTS5, metadata store
  akidb/           TypeScript facade over the native engine
  fabric-ingest/   Ingestion pipeline, CLI, daemon, MCP server, orchestrator
  akidb-py/        Python bindings (PyO3 / maturin)
```

---

## Key Environment Variables

| Variable | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API key for the Cloudflare Workers AI embedder |
| `EMBEDDING_API_KEY` | API key for an OpenAI-compatible HTTP embedder |
| `AX_FABRIC_MCP_TOKEN` | Bearer token for MCP server authentication |
| `AX_FABRIC_DATA_ROOT` | Override the default data directory (`~/.ax-fabric/data`) |

Runtime config lives at `~/.ax-fabric/config.yaml` (created by `ax-fabric init`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@ax-fabric/akidb-native-darwin-arm64'` | `cd packages/akidb-native && pnpm build` |
| Native module fails to load | `pnpm install && pnpm build` |
| Dimension mismatch error | Verify `dimension` in `config.yaml` matches the embedding model's actual output size |
| Search returns no results | Check `ingest status` — confirm files are `success`. Re-run `ingest run`. |
| `ingest status` reports ENOENT | Registry not initialised yet. Run `ingest run` at least once. |
| MCP auth fails (`401`) | Run `ax-fabric mcp token show` and set `AX_FABRIC_MCP_TOKEN` in your client env |
| Daemon already running error | Check `ingest daemon status`. Kill the existing process or remove the stale lock file. |

---

## Documentation

- [QUICKSTART.md](./QUICKSTART.md) — full setup: embedders, daemon, RAG, MCP, TypeScript API, metadata filters
- [LICENSE](LICENSE) — GNU AGPLv3-or-later
- [LICENSING.md](LICENSING.md) — dual-license overview
- [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) — Business and Enterprise commercial terms
- [CONTRIBUTING.md](CONTRIBUTING.md) — issue reporting and public contribution policy
