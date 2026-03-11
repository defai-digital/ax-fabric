# AX Fabric Quickstart

This guide gets you from a fresh checkout to:

1. a working local AX Fabric install
2. a successful ingest and search run
3. an optional semantic review and publish workflow
4. an optional MCP server for agent integration

If you only want one path, do **Path A** first.

## Prerequisites

- Node.js `>=22`
- pnpm `10.22`
- Rust toolchain

Check your environment:

```bash
node --version
pnpm --version
rustc --version
```

## Path A: First Successful Run

### 1. Install and build

```bash
pnpm install
pnpm build
pnpm exec ax-fabric --help
```

### 2. Initialize the workspace

```bash
pnpm exec ax-fabric init
```

This creates:

- `~/.ax-fabric/config.yaml`
- `~/.ax-fabric/data/`

### 3. Configure an embedder

Edit `~/.ax-fabric/config.yaml`.

For the fastest smoke test, use the mock embedder:

```yaml
akidb:
  dimension: 128

embedder:
  type: local
  model_id: mock-embed-v1
  dimension: 128
```

For real retrieval quality, switch to a real embedder later.

**Cloudflare Workers AI**

```yaml
akidb:
  dimension: 1024

embedder:
  type: cloudflare
  model_id: "@cf/baai/bge-large-en-v1.5"
  dimension: 1024
  account_id: your-account-id
  api_key_env: CLOUDFLARE_API_TOKEN
```

```bash
export CLOUDFLARE_API_TOKEN=your-token
```

**OpenAI-compatible HTTP endpoint**

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

### 4. Add documents

```bash
pnpm exec ax-fabric ingest add ./docs
pnpm exec ax-fabric ingest diff
```

Common supported file types:

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

### 5. Run ingestion

```bash
pnpm exec ax-fabric ingest run
pnpm exec ax-fabric ingest status
```

The pipeline is incremental and idempotent:

- new files are ingested
- changed files are reprocessed
- deleted files are tombstoned
- unchanged files are skipped

### 6. Search

Vector search:

```bash
pnpm exec ax-fabric search "how does authentication work?" --top-k 5
```

Keyword search:

```bash
pnpm exec ax-fabric search "JWT expiry" --mode keyword --top-k 10
```

Hybrid search:

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --top-k 5
```

Explainable results:

```bash
pnpm exec ax-fabric search "authentication token expiry" --mode hybrid --explain
```

At this point AX Fabric is working as a local ingest and retrieval stack.

## Path B: Semantic Workflow

Use this when you want reviewed semantic artifacts, not just raw chunk retrieval.

### 1. Preview semantic units

```bash
pnpm exec ax-fabric semantic preview ./docs/architecture.md
```

### 2. Store a semantic bundle

```bash
pnpm exec ax-fabric semantic store ./docs/architecture.md
pnpm exec ax-fabric semantic bundles
```

### 3. Approve the bundle

```bash
pnpm exec ax-fabric semantic approve-store <bundle-id> \
  --reviewer ops \
  --min-quality 0.6 \
  --duplicate-policy warn
```

### 4. Publish the bundle

```bash
pnpm exec ax-fabric semantic publish <bundle-id>
```

### 5. Search semantic artifacts

```bash
pnpm exec ax-fabric search "authentication token expiry" --semantic
pnpm exec ax-fabric search "authentication token expiry" --fuse
pnpm exec ax-fabric eval ./fixture.json --compare
```

### 6. Lifecycle commands

```bash
pnpm exec ax-fabric semantic republish <bundle-id>
pnpm exec ax-fabric semantic rollback <bundle-id>
pnpm exec ax-fabric semantic unpublish <bundle-id>
```

## Path C: MCP Server

Use this when AX Fabric should serve tools to Claude, Gemini, or another MCP client.

### 1. Start the server

```bash
pnpm exec ax-fabric mcp server
```

### 2. Generate a token

```bash
pnpm exec ax-fabric mcp token generate
pnpm exec ax-fabric mcp token show
```

### 3. Example Claude Desktop config

```json
{
  "mcpServers": {
    "ax-fabric": {
      "command": "pnpm",
      "args": ["exec", "ax-fabric", "mcp", "server"],
      "cwd": "/path/to/ax-fabric",
      "env": {
        "AX_FABRIC_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

High-value semantic MCP tools include:

- `fabric_semantic_store_bundle`
- `fabric_semantic_list_bundles`
- `fabric_semantic_inspect_bundle`
- `fabric_semantic_approve_bundle`
- `fabric_semantic_publish_bundle`

## Useful Commands

Health check:

```bash
pnpm exec ax-fabric doctor
pnpm exec ax-fabric doctor --check-serving
```

Daemon mode:

```bash
pnpm exec ax-fabric ingest daemon start
pnpm exec ax-fabric ingest daemon status
pnpm exec ax-fabric ingest daemon stop
```

Memory and context:

```bash
pnpm exec ax-fabric memory put --session demo --text "Important deployment note"
pnpm exec ax-fabric memory assemble --session demo
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Native module fails to load | `pnpm install && pnpm build` |
| Dimension mismatch | make `akidb.dimension` match the embedding model output |
| Search returns no results | run `ingest status`, then rerun `ingest run` |
| MCP auth fails | generate a token and export `AX_FABRIC_MCP_TOKEN` |
| Daemon lock error | run `ingest daemon status` and stop the existing process |

## What To Read Next

- [README.md](./README.md)
- [OPERATIONS.md](./OPERATIONS.md)
- [SEARCH_QUALITY.md](./SEARCH_QUALITY.md)
- [MEMORY.md](./MEMORY.md)
- [STACK.md](./STACK.md)
