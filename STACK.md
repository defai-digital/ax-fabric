# AX Fabric Stack Guide

This document defines how AX Fabric fits into the DEFAI offline AI product stack.

## Role in the Product Family

AX Fabric is the core product layer for enterprise offline AI systems.

It is responsible for:

- document ingestion,
- indexing and storage,
- vector, keyword, and hybrid retrieval,
- grounded memory and knowledge access,
- MCP and SDK integration for local AI applications.

The rest of the product family should be understood relative to AX Fabric:

- [`ax-cli`](https://github.com/defai-digital/ax-cli): operator and developer endpoint
- [`ax-studio`](https://github.com/defai-digital/ax-studio): visual and workspace endpoint
- [`ax-serving`](https://github.com/defai-digital/ax-serving): optional local model serving and orchestration backend

## Recommended Architecture

```text
Enterprise users / developers / applications
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
                ├── memory / context delivery
                └── MCP / SDK integration
                │
                ▼
             ax-serving
                │
                ├── local embeddings
                ├── local model execution
                ├── routing / scheduling
                └── deployment control
```

Rules:

- AX Fabric is the product anchor.
- `ax-cli` and `ax-studio` are the main user-facing endpoints.
- `ax-serving` is supporting infrastructure, not the primary product narrative.

## What AX Fabric Is

AX Fabric is:

- a local-first knowledge and retrieval fabric,
- a context layer for grounded AI systems,
- an offline-friendly system component for enterprise AI deployments,
- a product that can be used directly through CLI, SDK, Python, or MCP.

AX Fabric is not:

- only a vector database,
- only an ingestion daemon,
- only an internal backend for another DEFAI repo,
- or a general-purpose agent framework.

## Endpoint Responsibilities

### ax-cli

Use `ax-cli` when you want:

- operator setup flows,
- scripted ingestion and search workflows,
- local-stack bootstrap and validation,
- automation-oriented administration.

### ax-studio

Use `ax-studio` when you want:

- a visual workspace for local AI workflows,
- interactive retrieval and knowledge access,
- managed UI flows for enterprise users and operators.

### ax-serving

Use `ax-serving` when AX Fabric needs:

- a local embedding endpoint,
- local model execution,
- routing and scheduling across local workers,
- offline deployment control for model-serving workloads.

AX Fabric can also work with other compatible embedding backends when appropriate. `ax-serving` is recommended when you want tighter DEFAI-local integration.

## Evaluation Path

For `v1.2.x`, the recommended evaluator journey is:

1. Read [README.md](./README.md) for the product position.
2. Follow [QUICKSTART.md](./QUICKSTART.md) to ingest and query a local document set.
3. Use this document to understand how `ax-cli`, `ax-studio`, and `ax-serving` fit around AX Fabric.

The expected first successful result is:

- local documents are indexed,
- a query returns grounded results,
- the evaluator understands where AX Fabric sits in the broader offline stack.

## Enterprise Offline Use Cases

AX Fabric is intended for environments where:

- enterprise knowledge should stay in local or private infrastructure,
- AI applications need grounded retrieval and memory,
- cloud dependency is restricted or undesirable,
- deployment teams need a clear separation between UI, knowledge, and serving layers.

## Near-Term Scope

In the `v1.2.x` phase, AX Fabric should present a coherent product story and evaluation path.

Near-term priorities:

- clarity of product boundaries,
- clear endpoint relationships,
- first-run evaluation flow,
- enterprise offline positioning.

Later phases will expand deeper into:

- installability and stack operability,
- retrieval quality and explainability,
- memory and context services,
- enterprise governance and observability.
