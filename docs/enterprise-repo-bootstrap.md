# Enterprise Repo Bootstrap

This document defines the recommended bootstrap for the private enterprise repository that sits beside the public AX Fabric repository.

Recommended repository name:

- `ax-fabric-enterprise`

Recommended visibility:

- private

## Local Bootstrap Command

This public repository includes a local scaffold helper that generates a sibling private repository outside the OSS tree:

```bash
pnpm scaffold:enterprise -- ../ax-fabric-enterprise
```

Optional flags:

- `--scope @your-org`
- `--repo-name ax-fabric-enterprise`

The helper refuses to write inside the public repository, so proprietary bootstrap files do not end up tracked here by accident.

The generated package manifests pin public AX Fabric dependencies to the current public line placeholder (`3.2.x`). Adjust that range when you cut the real private line.

## Purpose

The private enterprise repository is where proprietary implementation should live.

It exists to host:

- proprietary connectors
- customer-specific integrations
- enterprise deployment bundles
- control-plane services
- private operator tooling
- separately licensed runtime add-ons

It must not become the new source of truth for public core logic that belongs in the open-source repository.

## Dependency Direction

Allowed dependency direction:

1. private enterprise repo depends on published public packages
2. private enterprise repo depends on stable public APIs, CLI contracts, and documented integration surfaces

Forbidden dependency direction:

1. public repo depends on private enterprise packages
2. public repo imports private enterprise modules
3. public repo builds or tests require private enterprise code

## Recommended Repository Layout

```text
ax-fabric-enterprise/
  packages/
    enterprise-runtime/
    enterprise-connectors/
    enterprise-control-plane/
    enterprise-deploy/
  docs/
    architecture.md
    compatibility-matrix.md
    release-runbook.md
  configs/
    environments/
  scripts/
  .github/workflows/
  package.json
  pnpm-workspace.yaml
  README.md
```

Not every package is required on day one.

The minimum useful bootstrap is:

- `packages/enterprise-runtime`
- `packages/enterprise-connectors`
- `docs/compatibility-matrix.md`
- private release workflow

## Package Responsibilities

### `enterprise-runtime`

Owns proprietary orchestration and enterprise-only runtime features that sit outside the OSS core.

Examples:

- enterprise auth adapters
- policy gates
- operator-only management flows
- internal deployment-specific service wrappers

### `enterprise-connectors`

Owns connectors that should not live in the public repo.

Examples:

- private SaaS integrations
- customer-specific source systems
- proprietary mailbox, DMS, or ticketing connectors

### `enterprise-control-plane`

Optional.

Use this only if there is a real need for:

- fleet management
- tenant management
- license enforcement workflows
- enterprise operations APIs

### `enterprise-deploy`

Owns deployment artifacts and packaging.

Examples:

- Dockerfiles
- Helm charts
- install bundles
- air-gapped packaging workflows

## Public Package Consumption Model

The private repo should consume public AX Fabric packages as released artifacts whenever possible:

- `@ax-fabric/contracts`
- `@ax-fabric/akidb`
- `@ax-fabric/fabric-ingest`

If native build coordination is required, pin against tagged releases from the public repo instead of floating branch heads.

## Compatibility Matrix

The private repo should maintain a checked-in compatibility file such as:

```text
enterprise line 1.0 -> ax-fabric public line 3.2.x
enterprise line 1.1 -> ax-fabric public line 3.3.x
```

This is important because the public repo and private repo will evolve at different cadences.

## Release Model

Recommended release channels:

1. private npm or GitHub Packages for JS packages
2. private container registry for images
3. internal artifact store for air-gapped or offline bundles

Recommended release rule:

- every enterprise release should record the compatible public AX Fabric version range

## CI Expectations

The private repo should have CI that runs at least:

1. install
2. build
3. typecheck
4. tests
5. compatibility check against pinned public AX Fabric versions
6. package publish or image publish on release tags

## Bootstrap Checklist

Day one bootstrap checklist:

1. create private GitHub repository
2. initialize workspace and package layout
3. add README that states private/proprietary scope
4. add compatibility matrix document
5. add CI workflow
6. configure private package registry or container registry
7. pin initial public AX Fabric dependency versions
8. move proprietary connectors or deployment logic into the private repo

## Migration Guidance

When moving code out of the public repo into the private repo:

1. first define the public integration contract
2. move the proprietary implementation
3. replace direct coupling with API, CLI, MCP, or service boundary
4. keep the public repo independently buildable and testable

Do not leave the public repo in a half-split state where production behavior still depends on unpublished private source.
