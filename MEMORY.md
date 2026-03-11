# AX Fabric Memory Guide

This document defines the recommended `v1.5` workflow for durable memory, session context, and context assembly.

## Goal

The goal of `v1.5` is to make AX Fabric more than a retrieval layer.

It should act as:

- a durable short-term and long-term memory store,
- a session and workflow context backbone,
- a context assembly layer for local AI systems.

## Memory Model

AX Fabric stores memory records with:

- session ID,
- optional workflow ID,
- memory kind (`short-term` or `long-term`),
- text content,
- timestamps.

This gives operators a clear separation between:

- durable knowledge indexed from documents,
- operator-managed memory records,
- runtime model state that AX Fabric does not own.

## CLI Workflow

### Store memory

```bash
pnpm exec ax-fabric memory put --session ops-demo --text "Deployment window is Friday night."
pnpm exec ax-fabric memory put --session ops-demo --kind long-term --text "Policy owner is the platform team."
```

### List memory

```bash
pnpm exec ax-fabric memory list --session ops-demo
pnpm exec ax-fabric memory list --session ops-demo --kind long-term --json
```

### Assemble context

```bash
pnpm exec ax-fabric memory assemble --session ops-demo
pnpm exec ax-fabric memory assemble --session ops-demo --workflow deploy-42 --json
```

### Delete memory

```bash
pnpm exec ax-fabric memory delete <memory-id>
```

## Search and Answer Integration

Use `--session` and optional `--workflow` on `search --answer` to inject assembled memory context into grounded answer generation:

```bash
pnpm exec ax-fabric search "what is the deployment policy?" --answer --session ops-demo
pnpm exec ax-fabric search "what is the deployment policy?" --answer --session ops-demo --workflow deploy-42
```

The answer flow will:

1. assemble matching memory records,
2. retrieve document context from AX Fabric,
3. build one combined prompt for the configured LLM.

## Recommended Usage Pattern

- use `short-term` memory for active session facts and temporary context,
- use `long-term` memory for durable operator or workflow facts,
- use `workflowId` when one session contains multiple parallel tasks,
- keep document retrieval and memory records distinct so provenance stays understandable.

## What v1.5 Adds

Included in this phase:

- durable local memory storage,
- session and workflow-scoped memory,
- memory context assembly,
- CLI management surface,
- search/answer integration through assembled memory context.

Not fully solved by this phase:

- policy-driven memory eviction,
- semantic retrieval over memory records,
- cross-session summarization,
- advanced multi-agent context routing.
