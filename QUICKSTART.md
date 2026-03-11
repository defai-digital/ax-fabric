# AX Fabric Quickstart

This guide walks you from a fresh checkout to a first successful evaluation of AX Fabric as the knowledge and retrieval layer in an enterprise offline AI stack.

Before you begin, keep the product roles clear:

- `ax-fabric` is the core knowledge, retrieval, memory, and context layer.
- `ax-cli` and `ax-studio` are the main user-facing endpoints around that layer.
- `ax-serving` is an optional local backend for embeddings and model execution.

For the overall product-family architecture, see [STACK.md](./STACK.md).
For local-stack operating guidance, see [OPERATIONS.md](./OPERATIONS.md).
For retrieval-quality and explainability workflows, see [SEARCH_QUALITY.md](./SEARCH_QUALITY.md).
For memory and context workflows, see [MEMORY.md](./MEMORY.md).

## Prerequisites

- Node.js `>=22`
- pnpm `10.22` (`npm install -g pnpm`)
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

Validate your environment:

```bash
node --version     # >=22
pnpm --version     # >=10
rustc --version
```

---

## Path A: Evaluate AX Fabric Directly via CLI

One command cycle: ingest a directory, search it, and confirm the core product layer works.

### 1. Install + Build

```bash
pnpm install
pnpm build
```

Validate the CLI is available:

```bash
pnpm exec ax-fabric --help
```

### 2. Initialize workspace

```bash
pnpm exec ax-fabric init
```

Creates `~/.ax-fabric/config.yaml` and `~/.ax-fabric/data/`.

### 3. Configure an embedder

Edit `~/.ax-fabric/config.yaml`. Three real options and one mock for testing.

**Option A: Cloudflare Workers AI** (recommended for cloud)

```yaml
akidb:
  dimension: 1024

embedder:
  type: cloudflare
  model_id: "@cf/baai/bge-large-en-v1.5"
  dimension: 1024
  account_id: your-cloudflare-account-id
  api_key_env: CLOUDFLARE_API_TOKEN
```

```bash
export CLOUDFLARE_API_TOKEN=your-token
```

**Option B: OpenAI-compatible HTTP endpoint**

```yaml
akidb:
  dimension: 1536

embedder:
  type: http
  model_id: text-embedding-3-small
  dimension: 1536
  base_url: https://api.openai.com/v1/embeddings
  api_key_env: EMBEDDING_API_KEY
```

```bash
export EMBEDDING_API_KEY=sk-...
```

**Option C: Local model via ax-serving**

Use this when you want a DEFAI-local backend for embeddings or model execution (e.g. [AX Serving](https://github.com/defai-digital/ax-serving)):

```yaml
akidb:
  dimension: 1024

embedder:
  type: mcp
  model_id: bge-large-en-v1.5
  dimension: 1024
  base_url: http://127.0.0.1:18080/v1/embeddings
```

**Option D: Mock embedder** (testing only, no real search quality)

```yaml
akidb:
  dimension: 128

embedder:
  type: local
  model_id: mock-embed-v1
  dimension: 128
```

### 4. Add documents and preview changes

```bash
pnpm exec ax-fabric ingest add ./my-docs
pnpm exec ax-fabric ingest diff
```

Supported file formats: `txt`, `md`, `pdf`, `docx`, `pptx`, `xlsx`, `csv`, `tsv`, `json`, `jsonl`, `yaml`, `html`, `rtf`, `sql`, `log`.

### 5. Run ingestion

```bash
pnpm exec ax-fabric ingest run
```

Ingestion is **incremental and idempotent** — only new, modified, or deleted files are processed. Unchanged files are always skipped. Re-running is always safe.

Check status after ingestion:

```bash
pnpm exec ax-fabric ingest status
```

### 6. Search

Vector search (semantic, default):

```bash
pnpm exec ax-fabric search "how does authentication work?" --top-k 5
```

Keyword search (BM25 / exact terms):

```bash
pnpm exec ax-fabric search "JWT expiry" --mode keyword --top-k 10
```

Hybrid search (vector + BM25, fused with Reciprocal Rank Fusion — best recall):

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --top-k 5
```

Grounded answer generation:

```bash
pnpm exec ax-fabric search "how do I deploy to production?" --answer
```

At this point, you have validated the core AX Fabric layer:

- local documents were ingested,
- retrieval works,
- the system can serve as the knowledge backbone for higher-level interfaces such as `ax-cli` and `ax-studio`.

---

## Path B: Run as a Continuous Local Knowledge Service

A long-running poll loop that detects and re-ingests file changes automatically. Use this when AX Fabric is serving a local workspace that changes over time.

Follow steps 1–3 from Path A, then:

```bash
pnpm exec ax-fabric ingest daemon start
pnpm exec ax-fabric ingest daemon status
pnpm exec ax-fabric ingest daemon stop
```

The daemon:
- Acquires a file lock so only one instance runs per data directory.
- Handles `SIGINT`/`SIGTERM` by finishing the current cycle then exiting cleanly.
- Handles `SIGHUP` by reloading config without restarting.
- Logs structured events to `~/.ax-fabric/data/daemon.jsonl`.

---

## Path C: Expose AX Fabric to Local AI Tools over MCP

Expose AX Fabric as a tool provider over stdio for Claude, Gemini, and any MCP-compatible client.

```bash
pnpm exec ax-fabric mcp server
```

Token management:

```bash
pnpm exec ax-fabric mcp token show
pnpm exec ax-fabric mcp token generate
```

Available tool groups:

| Group | Count | Operations |
|---|---|---|
| `akidb_*` | 9 | Create / list / delete collections, upsert, search, compact, stats |
| `fabric_*` | 10 | Ingest run / diff / status, daemon control, search with mode |
| `fabric_memory_*` | 4 | Put / list / assemble / delete session and workflow memory records |

Claude Desktop config:

```json
{
  "mcpServers": {
    "ax-fabric": {
      "command": "pnpm",
      "args": ["exec", "ax-fabric", "mcp", "server"],
      "cwd": "/path/to/ax-fabric",
      "env": {
        "AX_FABRIC_MCP_TOKEN": "<token from token show>"
      }
    }
  }
}
```

Use this path when AX Fabric is acting as the knowledge and context layer behind an AI tool or local agent workflow.

---

## Using AX Fabric with the Rest of the Stack

### ax-cli

Use [`ax-cli`](https://github.com/defai-digital/ax-cli) when you want a developer or operator endpoint around AX Fabric for setup, scripted workflows, and automation.

### ax-studio

Use [`ax-studio`](https://github.com/defai-digital/ax-studio) when you want a visual workspace on top of AX Fabric for interactive retrieval and local AI workflows.

### ax-serving

Use [`ax-serving`](https://github.com/defai-digital/ax-serving) when AX Fabric needs a local embedding or model-serving backend under enterprise-controlled infrastructure.

## Health and Diagnostics

Use the built-in doctor command before troubleshooting deeper:

```bash
pnpm exec ax-fabric doctor
pnpm exec ax-fabric doctor --check-serving
```

## First Evaluation Checklist

You have completed the `v1.2.x` first evaluation path when:

- AX Fabric is initialized locally,
- a document directory has been ingested,
- you can run vector, keyword, or hybrid search successfully,
- you understand where `ax-cli`, `ax-studio`, and `ax-serving` fit in the stack.

---

## Search Modes

| Mode | Best For | Requires |
|---|---|---|
| `vector` (default) | Semantic meaning, conceptual similarity | `queryVector` |
| `keyword` | Exact terms, lexical matching (BM25) | `queryText` |
| `hybrid` | Balanced recall — fuses both with RRF | `queryVector` + `queryText` |

Hybrid over-fetches `topK × 2` from each source before fusion. It typically gives the best recall for real-world queries. Use `--explain` to see per-result scores:

```bash
pnpm exec ax-fabric search "query" --mode hybrid --explain
```

Use `--json` when you want to capture search results for repeatable evaluation:

```bash
pnpm exec ax-fabric search "query" --mode hybrid --explain --json
```

For fixture-based mode comparison:

```bash
pnpm exec ax-fabric eval ./eval-fixture.json
pnpm exec ax-fabric eval ./eval-fixture.json --json
```

---

## Metadata Filters

Filters are applied during HNSW graph traversal (pre-filter), so no post-processing overhead. Supported operators:

| Operator | Description |
|---|---|
| `{ field: value }` | Exact match |
| `{ field: [v1, v2] }` | OR match (any of the values) |
| `{ field: { $gt: n } }` | Greater than |
| `{ field: { $gte: n } }` | Greater than or equal |
| `{ field: { $lt: n } }` | Less than |
| `{ field: { $lte: n } }` | Less than or equal |
| `{ field: { $ne: v } }` | Not equal |
| `{ field: { $in: [...] } }` | In set |
| `{ field: { $nin: [...] } }` | Not in set |

Simple equality filters use a bitmap index for fast lookup. Range operators fall back to brute-force scan.

---

## Programmatic Use (TypeScript)

```typescript
import { AkiDB } from "@ax-fabric/akidb";

const db = new AkiDB({ storagePath: "./my-db" });

await db.createCollection({
  collectionId: "docs",
  dimension: 1024,
  metric: "cosine",
  embeddingModelId: "bge-large-en-v1.5",
});

await db.upsertBatch("docs", [
  {
    chunk_id: "doc1-chunk0",
    doc_id: "doc1",
    doc_version: "v1",
    chunk_hash: "abc123",
    pipeline_signature: "sig",
    embedding_model_id: "bge-large-en-v1.5",
    vector: Array.from(new Float32Array(1024)),
    metadata: {
      source_uri: "doc1.txt",
      content_type: "txt",
      page_range: null,
      offset: 0,
      table_ref: null,
      created_at: new Date().toISOString(),
    },
    chunk_text: "The quick brown fox...",
  },
]);

await db.flushWrites("docs");
await db.publish("docs");

const results = await db.search({
  collectionId: "docs",
  queryVector: new Float32Array(1024),
  topK: 5,
  mode: "hybrid",
  queryText: "quick brown fox",
  filters: { source_uri: { $in: ["doc1.txt", "doc2.txt"] } },
});

console.log(results);
await db.close();
```

---

## Key Environment Variables

| Variable | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API key for the Cloudflare Workers AI embedder |
| `EMBEDDING_API_KEY` | API key for an OpenAI-compatible HTTP embedder |
| `AX_FABRIC_MCP_TOKEN` | Bearer token for MCP server authentication |
| `AX_FABRIC_DATA_ROOT` | Override the default data directory (`~/.ax-fabric/data`) |

Config file: `~/.ax-fabric/config.yaml`. Created by `ax-fabric init`. Secrets are never stored in config — reference them by env-var name via `api_key_env`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@ax-fabric/akidb-native-darwin-arm64'` | `cd packages/akidb-native && pnpm build` |
| Native module fails to load | `pnpm install && pnpm build` |
| Dimension mismatch error | `dimension` in `config.yaml` must match the embedding model's actual output (`bge-large-en-v1.5` → 1024, `text-embedding-3-small` → 1536) |
| Search returns no results | Run `ingest status` — confirm files are `success`. Re-run `ingest run` if pending. |
| `ingest status` reports ENOENT | Registry not initialised yet. Run `ingest run` at least once. |
| MCP auth fails (`401`) | Run `mcp token show` and set `AX_FABRIC_MCP_TOKEN` in your client env |
| Daemon won't start (lock error) | Run `ingest daemon status`. Kill the existing process or remove the stale lock. |
| Embedding API returns 4xx | Verify the API key env var is exported and matches `api_key_env` in config |

---

## Next References

- [README.md](README.md)
- `~/.ax-fabric/config.yaml` — runtime configuration
- [LICENSE](LICENSE) — GNU AGPLv3-or-later
- [LICENSING.md](LICENSING.md) — dual-license overview
- [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) — Business and Enterprise commercial terms
