# AX Fabric Operations Guide

This document defines the recommended `v1.3` local-stack operating model for AX Fabric.

## Goal

The goal of `v1.3` is to make the DEFAI offline stack installable and operable by enterprise developers and operators.

At minimum, an operator should be able to:

- initialize AX Fabric,
- configure a local or private embedding backend,
- ingest documents,
- expose AX Fabric to local AI tools,
- and diagnose common failure points without reading source code.

## Stack Topology

Recommended local stack:

```text
operator / developer
        │
        ├── ax-cli
        ├── ax-studio
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

## Operational Scope for v1.3

`v1.3` is about local-stack operability, not full enterprise governance.

Included in this phase:

- startup order,
- endpoint relationships,
- local health diagnostics,
- reproducible evaluation flow.

Not yet fully solved in this phase:

- enterprise IAM,
- full audit trails,
- complex multi-node control planes,
- full production SRE automation.
