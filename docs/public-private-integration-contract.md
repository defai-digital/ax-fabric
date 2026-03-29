# Public And Private Integration Contract

This document defines the intended contract between the public AX Fabric repository and a future private enterprise repository.

## Contract Goal

The goal is to let proprietary enterprise systems build on AX Fabric without making the public repository depend on private source code.

## Supported Integration Surfaces

Enterprise systems should integrate with AX Fabric through one or more of the following public surfaces.

### 1. Package Contracts

Stable public packages:

- `@ax-fabric/contracts`
- `@ax-fabric/akidb`
- `@ax-fabric/fabric-ingest`

Use these as the code-level contract when the enterprise repository needs public schemas, client APIs, or runtime wrappers.

### 2. CLI Boundary

Supported when enterprise workflows need:

- ingestion triggers
- semantic lifecycle automation
- benchmark or operator workflows

Preferred usage:

- invoke the public CLI as a process boundary
- consume JSON or machine-readable output where available

### 3. MCP Boundary

Supported when enterprise tooling needs:

- tool-driven retrieval
- semantic bundle workflow actions
- remote or agent-style integrations

Preferred usage:

- connect through documented MCP server behavior
- avoid private code injection into the public MCP runtime

### 4. Service Boundary

Supported when enterprise systems need a long-running backend.

Preferred protocols:

- HTTP / REST
- gRPC
- queue / worker patterns

## Dependency Rules

### Public Repo Rules

The public repository must:

- depend only on public workspace packages and public third-party dependencies
- remain buildable without private artifacts
- remain testable without private artifacts
- avoid import paths or package references to enterprise-only code

### Private Repo Rules

The private repository may:

- depend on published public AX Fabric packages
- wrap public CLI or MCP interfaces
- call public network APIs
- maintain private deployment glue around the public core

The private repository must not:

- patch the public repository by unpublished source coupling
- require unpublished public-repo branches for normal operation
- assume access to private hooks inside public package internals

## Forbidden Coupling Patterns

The following should be treated as forbidden by default:

- public code importing private package namespaces
- public code importing `enterprise/`, `private/`, or `ee/` source trees
- private enterprise source committed into the public monorepo
- public release pipelines that package private enterprise artifacts
- shared-address-space extension points designed only for closed modules

## Recommended Change Management

When a public API change affects the enterprise repo:

1. update the public documentation first
2. release a tagged public version
3. update the compatibility matrix in the private repo
4. adapt the private repo against the released public version

## Stability Expectations

The following are the intended long-lived boundaries:

- public package names
- published schemas in `@ax-fabric/contracts`
- documented CLI behavior
- documented MCP behavior
- documented service contracts

Internal module structure inside the public repo is not a stable private integration surface unless it is explicitly exported and documented.

## Enforcement

The public repo includes an automated boundary guard that checks for:

- enterprise-only source roots
- references to private enterprise package namespaces
- obvious private-path imports from public code

This guard is intentionally lightweight. If future coupling risks appear, extend the guard rather than bypassing it.
