# AX Fabric Stack Guide

This document defines how AX Fabric fits into the DEFAI offline AI product stack.

## Role in the Product Family

AX Fabric is the governed semantic backend in the product family.

It is responsible for:

- document ingestion,
- semantic distillation and publication,
- governed storage of semantic knowledge,
- vector, keyword, and hybrid retrieval,
- provenance-aware knowledge access,
- MCP and SDK integration for applications and tools.

The rest of the product family should be understood relative to AX Fabric:

- [`ax-studio`](https://github.com/defai-digital/ax-studio): free user-facing client and reference interface
- [`ax-cli`](https://github.com/defai-digital/ax-cli): operator and developer endpoint
- [`ax-serving`](https://github.com/defai-digital/ax-serving): optional local model serving and orchestration backend

## Recommended Architecture

```text
Enterprise users / operators / applications
                │
                ▼
  ax-studio / custom tools / internal apps
                │
                ▼
             AX Fabric
                │
                ├── ingestion
                ├── semantic distillation
                ├── review / publish / rollback
                ├── governed retrieval
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

- AX Fabric is the governed backend component.
- `ax-studio` is a free client, not the only front end.
- customers may use AX Studio, bring their own tools, or commission custom integrations.
- `ax-serving` is supporting infrastructure, not the primary product narrative.

## What AX Fabric Is

AX Fabric is:

- a governed semantic backend,
- a private-AI knowledge runtime,
- an offline-friendly system component for enterprise AI deployments,
- a component that can be consumed by AX Studio, custom tools, internal apps, CLI, SDKs, or MCP.

AX Fabric is not:

- a user-facing desktop application,
- the only client in the product family,
- only a vector database,
- only an ingestion daemon,
- or a general-purpose agent framework.

## Endpoint Responsibilities

### ax-studio

Use `ax-studio` when you want:

- a free reference client for AX Fabric,
- a user-facing desktop experience,
- an out-of-the-box way to consume governed knowledge without building your own front end.

`ax-studio` is an optional client. It is not the monetized backend.

### ax-cli

Use `ax-cli` when you want:

- operator setup flows,
- scripted ingestion and search workflows,
- local-stack bootstrap and validation,
- automation-oriented administration.

`ax-cli` should be understood as an endpoint into AX Fabric, not as a replacement for it.

The intended relationship is:

- `ax-cli` drives setup, ingestion, diagnostics, and scripted workflows,
- AX Fabric remains the underlying knowledge and context system,
- any project memory or warmup flows in `ax-cli` should either use AX Fabric directly or clearly describe when they do not.

### ax-serving

Use `ax-serving` when AX Fabric needs:

- a local embedding endpoint,
- local model execution,
- routing and scheduling across local workers,
- offline deployment control for model-serving workloads.

AX Fabric can also work with other compatible embedding backends when appropriate. `ax-serving` is recommended when you want tighter DEFAI-local integration.

## Commercial Model

The product-family commercial model is:

- `ax-studio` is the free client
- `ax-fabric` is the licensable governed semantic backend
- customers may use AX Studio, bring their own tools, or engage AutomatosX to build custom tools and integrations on top of AX Fabric

## Evaluation Path

The recommended evaluator journey is:

1. Read [README.md](./README.md) for the product position.
2. Follow [QUICKSTART.md](./QUICKSTART.md) to ingest, publish, and retrieve governed knowledge.
3. Use this document to understand how `ax-studio`, custom tools, and `ax-serving` fit around AX Fabric.

## Enterprise Offline Use Cases

AX Fabric is intended for environments where:

- enterprise knowledge should stay in local or private infrastructure,
- AI applications need governed semantic knowledge rather than raw-file retrieval alone,
- cloud dependency is restricted or undesirable,
- deployment teams need a clear separation between client, knowledge backend, and serving layers.
