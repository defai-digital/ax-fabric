# AX Fabric Operations Guide

This document defines the recommended operating model for AX Fabric as a governed semantic backend.

## Goal

The goal is to make AX Fabric installable and operable as the governed semantic backend behind AX Studio, custom tools, and private AI workflows.

At minimum, an operator or integrator should be able to:

- initialize AX Fabric,
- configure a local or private embedding backend,
- ingest documents,
- expose AX Fabric to AX Studio or other AI tools,
- and diagnose common failure points without reading source code.

## Stack Topology

Recommended local stack:

```text
operator / developer
        │
        ├── ax-cli
        ├── ax-studio / custom tools
        ▼
     AX Fabric
        │
        ├── local data root
        ├── AkiDB storage
        ├── daemon / MCP server
        └── search / retrieval APIs
        ▼
     ax-serving (optional but recommended for DEFAI-local model serving)
```

## Recommended Startup Order

### 1. Initialize AX Fabric

```bash
pnpm exec ax-fabric init
```

This creates:

- `~/.ax-fabric/config.yaml`
- `~/.ax-fabric/data/`

### 2. Configure the embedder or local serving backend

Use one of:

- `ax-serving`
- another OpenAI-compatible local embedding endpoint
- a supported remote provider if your deployment allows it

### 3. Register source directories

```bash
pnpm exec ax-fabric ingest add ./docs
pnpm exec ax-fabric ingest diff
```

### 4. Run ingestion

```bash
pnpm exec ax-fabric ingest run
```

### 5. Validate with doctor

```bash
pnpm exec ax-fabric doctor
pnpm exec ax-fabric doctor --check-serving
```

### 6. Start long-running services as needed

Continuous sync:

```bash
pnpm exec ax-fabric daemon
```

MCP server:

```bash
pnpm exec ax-fabric mcp server
```

Worker orchestrator:

```bash
pnpm exec ax-fabric orchestrator start
```

## AX Studio Backend Integration

The recommended relationship is:

- `ax-studio` is the visual workspace,
- AX Fabric is the knowledge and retrieval backend,
- `ax-serving` is the optional model-serving backend.

When describing or operating the local stack, use this split:

- `ax-studio` handles UI and user interaction,
- AX Fabric handles ingestion, indexing, retrieval, MCP access, and context delivery,
- `ax-serving` handles local model execution or embedding endpoints when needed.

If `ax-studio` expects multiple local ports or backend services, AX Fabric should be identified explicitly as the retrieval and knowledge service in that topology.

## AX CLI Memory and Context Relationship

`ax-cli` should be treated as an operator and developer endpoint around AX Fabric.

That means:

- AX Fabric remains the durable knowledge and retrieval layer,
- `ax-cli` drives workflows such as setup, ingestion, search, and diagnostics,
- if `ax-cli` has project-memory or warmup concepts, they should be documented as either:
  - using AX Fabric as the backing knowledge/context layer, or
  - being separate transient workflow state that does not replace AX Fabric.

The important rule is to avoid ambiguous overlap. Operators should be able to tell whether a given memory or context function is durable AX Fabric knowledge, transient CLI workflow state, or model runtime state.

## What `ax-fabric doctor` Checks

`ax-fabric doctor` is the first-line local operability check.

It verifies:

- config file presence and parseability,
- data-root presence,
- AkiDB storage-root presence,
- configured source count,
- MCP token presence,
- daemon status file presence,
- optional HTTP endpoint reachability for configured local backends.

Use `--check-serving` when you want AX Fabric to probe configured local endpoints such as:

- embedder HTTP endpoints,
- LLM HTTP endpoints,
- orchestrator health endpoints.

## Operator Checklist

Before handing the stack to end users, confirm:

- `ax-fabric doctor` reports config and storage roots correctly,
- at least one source directory is configured,
- ingestion completes successfully,
- search returns expected results,
- any local serving backend is reachable,
- MCP token exists if AI tools will connect over MCP.

## Reproducible Local Demo Path

The local-stack demo should be reproducible with these steps:

1. initialize AX Fabric,
2. configure a local embedding backend,
3. add and ingest a document directory,
4. run `ax-fabric doctor`,
5. query through CLI or MCP,
6. optionally connect `ax-studio` as the visual client.

The demo is successful when:

- documents are indexed,
- local health checks pass or produce actionable warnings,
- grounded search results are visible,
- the operator understands which layer owns UI, knowledge, and model execution.

## Common Failure Modes

### Missing config

Symptom:

- `doctor` reports missing config

Action:

```bash
pnpm exec ax-fabric init
```

### No sources configured

Symptom:

- `doctor` reports zero sources
- ingestion runs but does nothing

Action:

```bash
pnpm exec ax-fabric ingest add <path>
```

### Local serving endpoint unreachable

Symptom:

- `doctor --check-serving` reports an endpoint as unreachable
- embedding or grounded answer generation fails

Action:

- confirm the backend service is running,
- confirm the configured URL matches the actual port and path,
- confirm the deployment permits loopback access.

### Daemon visibility missing

Symptom:

- no daemon status is shown

Action:

- start the daemon if continuous sync is needed,
- otherwise this warning can be ignored for one-shot workflows.

## Backup and Restore

AX Fabric stores all durable state in two directory trees. Both must be backed up together to produce a consistent snapshot.

### What to back up

| Store | Default path | Contains |
|-------|-------------|----------|
| Data root | `~/.ax-fabric/data/` | `registry.db` (ingestion state), `semantic.db` (semantic bundles + publication log), `memory.json` |
| AkiDB storage | Configured in `akidb.root` (default `~/.ax-fabric/akidb/`) | Segments, WAL, metadata, manifests |

Both paths are configured in `~/.ax-fabric/config.yaml`.

### Backup procedure

1. Stop the daemon and MCP server if running.
2. Copy the data root:
   ```bash
   cp -r ~/.ax-fabric/data/ /backup/ax-fabric-data/
   ```
3. Copy the AkiDB storage root:
   ```bash
   cp -r ~/.ax-fabric/akidb/ /backup/ax-fabric-akidb/
   ```

If the daemon is running during backup, SQLite WAL checkpointing may leave the backup in an inconsistent state. Always stop services first.

### Restore procedure

1. Stop all AX Fabric services.
2. Replace the data root with the backup:
   ```bash
   rm -rf ~/.ax-fabric/data/ && cp -r /backup/ax-fabric-data/ ~/.ax-fabric/data/
   ```
3. Replace the AkiDB storage root with the backup:
   ```bash
   rm -rf ~/.ax-fabric/akidb/ && cp -r /backup/ax-fabric-akidb/ ~/.ax-fabric/akidb/
   ```
4. Restart services and verify with `ax-fabric doctor`.

### What is not backed up

- The config file (`~/.ax-fabric/config.yaml`) — back this up separately if customized.
- Source documents — these are external to AX Fabric and must be preserved by the operator.
- MCP auth tokens — regenerate after restore if needed.

## Upgrade and Migration

### Schema migrations

AX Fabric applies schema migrations automatically on startup:

- **Semantic store** (`semantic.db`): migrations run when the store is opened. The current schema version is stored in the `semantic_store_metadata` table. Version upgrades (e.g., v1 → v2) are applied transparently.
- **AkiDB segments**: the binary segment format includes a version header. Segments are forward-compatible within the same major version.
- **Job registry** (`registry.db`): schema is created on first use and is forward-compatible.

No manual migration commands are needed for normal upgrades.

### Upgrade procedure

1. Stop all AX Fabric services (daemon, MCP server, orchestrator).
2. Back up data root and AkiDB storage (see Backup section above).
3. Pull and build the new version:
   ```bash
   git pull && pnpm install && pnpm build
   ```
4. Start services. Schema migrations apply automatically on first access.
5. Verify with `ax-fabric doctor`.

### Downgrade considerations

Downgrading is not automatically supported. If a schema migration has been applied (e.g., semantic store v1 → v2), the older build will refuse to open a newer schema. Restore from a pre-upgrade backup if downgrade is required.

### Config compatibility

New releases may add optional config fields. The config loader validates with Zod and will reject unknown or invalid fields. When upgrading:

- Review release notes for new config options.
- Run `ax-fabric init` to regenerate a config file if major changes are needed.
- Existing valid configs continue to work without changes.

## Observability

### CLI diagnostics

| Command | Purpose |
|---------|---------|
| `ax-fabric doctor` | Config, storage, and source validation |
| `ax-fabric doctor --check-serving` | Probe configured HTTP endpoints |
| `ax-fabric ingest status` | Show tracked files and ingestion state |
| `ax-fabric ingest diff` | Preview what would change on next run |
| `ax-fabric semantic bundles` | List semantic bundles and their review/publication state |
| `ax-fabric semantic show <id> --json` | Inspect a single bundle with full details |
| `ax-fabric semantic audit-export` | Export the full governance audit trail as JSON |

### MCP diagnostics

MCP tools that return structured diagnostics:

- `fabric_ingest_status` — tracked file status
- `fabric_ingest_diff` — dry-run change detection
- `fabric_semantic_list_bundles` — bundle inventory
- `fabric_semantic_inspect_bundle` — bundle details + publication state
- `fabric_config_show` — current config (secrets redacted)

### Error patterns

AX Fabric uses typed error codes via `AxFabricError`. Common codes:

| Code | Meaning |
|------|---------|
| `EXTRACT_ERROR` | File extraction failed (unsupported format, corrupt file, I/O error) |
| `EMBED_ERROR` | Embedding API call failed (timeout, rate limit, bad response) |
| `VALIDATION_ERROR` | Zod schema validation failure (bad config, malformed record) |

### Daemon observability

The daemon writes a status snapshot to `~/.ax-fabric/status.json` on each cycle. This file includes:

- last cycle timestamp
- files processed
- errors encountered

Use `ax-fabric doctor` to check daemon status visibility.

## Operational Scope

This document covers single-node operability for AX Fabric as a governed semantic backend.

Included:

- startup order and endpoint relationships,
- backup, restore, and upgrade procedures,
- local health diagnostics and observability,
- reproducible evaluation flow,
- AX Studio and AX CLI integration guidance.

Not yet included:

- enterprise IAM,
- multi-node distributed deployment,
- full production SRE automation.
