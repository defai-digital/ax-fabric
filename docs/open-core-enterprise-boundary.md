# Open Core And Enterprise Boundary

This repository is the public AX Fabric repository.

It contains the open-source core only.

## Public Repo Scope

The public repository is the source of truth for:

- `packages/contracts`
- `packages/akidb`
- `packages/akidb-native`
- `packages/fabric-ingest`
- public documentation
- public build, test, and release automation

This repository may describe commercial licensing and enterprise packaging, but it must not contain proprietary implementation code.

## Private Enterprise Scope

Enterprise-only implementation should live in a separate private repository.

Typical private-repo contents include:

- proprietary connectors
- customer-specific integrations
- enterprise deployment bundles
- control-plane services
- private operations tooling
- separately licensed commercial add-ons

## Recommended Integration Boundary

When enterprise systems need to work with AX Fabric, prefer boundaries that keep the proprietary layer separate from the open-source core:

- HTTP / REST / gRPC
- MCP
- CLI invocation
- queue / worker orchestration
- separate service processes

Avoid in-process extension by default:

- private plugins loaded into the same runtime
- direct proprietary module linking into the OSS runtime
- shared-address-space extension points intended only for private code

If a future requirement appears to need that level of coupling, treat it as an architecture and licensing review item, not as a default implementation path.

## Repo Policy

Do not add enterprise-only source trees to this public repository.

Examples of forbidden source roots in this repo:

- `enterprise/`
- `private/`
- `commercial/`
- `ee/`
- `packages/enterprise-*`
- `packages/*-enterprise`

Documentation that explains commercial packaging is allowed here. Proprietary implementation is not.

## Packaging Guidance

Recommended distribution model:

1. public GitHub repo for OSS core
2. private GitHub repo for enterprise code
3. private package registry for enterprise packages
4. private container registry for enterprise images
5. separate commercial agreement for enterprise rights

## Why This Exists

This boundary reduces four risks:

- accidental publication of proprietary code
- unclear contributor expectations
- CI and release mistakes
- architecture that is too tightly coupled to split cleanly later

## Current Status

This repository is already dual-licensed at the business level, but the code hosted here should continue to be treated as the open-source core.

Commercial licensing may cover separately distributed proprietary artifacts, but those artifacts should not be committed to this public repository.

## Related Documents

- [Enterprise Repo Bootstrap](./enterprise-repo-bootstrap.md)
- [Public And Private Integration Contract](./public-private-integration-contract.md)
