# AX Fabric Roadmap

This roadmap defines the intended product direction for AX Fabric after the `v1.2.0` public baseline.

## Product Position

AX Fabric is the primary product.

It is positioned as:

> The local-first knowledge, retrieval, and memory fabric for grounded AI agents.

In practical terms, AX Fabric owns:

- document ingestion,
- indexing and storage,
- vector, keyword, and hybrid retrieval,
- memory and knowledge access,
- MCP-native integration with AI tools.

`ax-serving` is not the main product story. It is a supporting serving and orchestration layer that AX Fabric can use for local model execution, routing, and deployment.

## Product Principles

- Keep `ax-fabric` as the user-facing product and brand anchor.
- Keep the first-run experience simple enough for a 5-minute demo.
- Prefer local-first workflows and private-by-default data handling.
- Make MCP integration a first-class path, not an afterthought.
- Improve retrieval quality before expanding into broad agent-framework scope.
- Treat `ax-serving` as infrastructure that strengthens AX Fabric, not as a competing narrative.

## Version Roadmap

### v1.2.x

Goal: establish a clear public product definition and make first use successful.

Focus:

- unify product language across README, docs, CLI help, and release notes,
- simplify installation and first-run setup,
- make local directory ingestion reliable and understandable,
- reduce friction in MCP and Claude Desktop setup,
- produce a true 5-minute demo flow.

Success criteria:

- a new user can install, ingest a directory, and run a useful search quickly,
- the product story is consistently "knowledge / retrieval / memory fabric",
- `ax-serving` is presented as optional infrastructure, not the main entry point.

### v1.3

Goal: make AX Fabric the easiest local knowledge tool to adopt.

Focus:

- add one-command setup flows for major MCP clients where feasible,
- improve onboarding for Obsidian, Markdown, and local docs collections,
- improve CLI ergonomics and error messages,
- strengthen daemon health visibility and indexing diagnostics,
- support mainstream local embedding backends cleanly.

Success criteria:

- Claude Desktop or similar MCP client setup is close to one-step,
- indexing and search failures are diagnosable by normal developers,
- first-time user conversion improves because setup friction drops.

### v1.4

Goal: improve retrieval quality enough that the product wins on results, not just architecture.

Focus:

- strengthen hybrid retrieval and reranking,
- improve chunking and metadata quality,
- reduce duplicate and low-value chunks,
- add better explain output and retrieval transparency,
- add repeatable retrieval benchmarks and evaluation sets.

Success criteria:

- retrieval quality is measurable and documented,
- AX Fabric can clearly explain why it performs better than simple vector-only setups,
- search quality becomes a defensible product differentiator.

### v1.5

Goal: expand AX Fabric from retrieval into a stronger memory and agent-context layer.

Focus:

- add clearer short-term and long-term memory abstractions,
- support session and conversation-oriented context storage,
- expand MCP tools for agent-facing memory workflows,
- improve SDK surfaces for agent and application integration,
- define cleaner interfaces between retrieval and memory responsibilities.

Success criteria:

- AX Fabric is no longer perceived as only a search/index tool,
- agent applications can depend on it as a grounded memory layer,
- memory capabilities remain consistent with the local-first product story.

### v1.6

Goal: make AX Fabric ready for small-team and business deployment.

Focus:

- improve observability and operational visibility,
- add backup, import, and export workflows,
- add basic multi-workspace and access-control foundations,
- strengthen deployment patterns backed by `ax-serving`,
- define clearer Business and Enterprise capability boundaries.

Success criteria:

- small teams can run AX Fabric reliably in local or private-network environments,
- commercial packaging is easier to explain,
- the infrastructure underneath supports growth without changing the product identity.

## Not a Near-Term Goal

The near-term roadmap does not assume AX Fabric becomes a full general-purpose agent framework.

Not current priorities:

- broad workflow-runtime ambitions,
- large-scale multi-tenant cloud positioning,
- expanding `ax-serving` into the primary product narrative,
- chasing feature parity with every generic vector database.

## Short Positioning Statement

Use this wording consistently:

> AX Fabric is the local-first knowledge, retrieval, and memory fabric for grounded AI agents.

Supporting wording:

> AX Fabric is the product. `ax-serving` is an optional serving and orchestration layer that powers parts of AX Fabric when local model execution is needed.
