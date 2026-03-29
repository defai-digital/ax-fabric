# AX Fabric PRD v3.2

**Status:** Complete  
**Date:** 2026-03-29  
**Owner:** DEFAI / AutomatosX  
**Category:** Product Packaging / Licensing Boundary / Repo Strategy  
**Product:** AX Fabric open core + enterprise packaging model

## 1. Summary

`v3.2` defines the repository and packaging boundary between the public AX Fabric open-source core and future enterprise-only deliverables.

This release does not create enterprise-only runtime features inside the public repository.

Its purpose is to make the following explicit and enforceable:

- the public repository contains the open-source core only
- proprietary enterprise code must live outside this repository
- enterprise distribution should happen through private repositories and private artifact channels
- integration between public core and enterprise layers must prefer process or network boundaries over in-process coupling

## 2. Why This Release Exists

AX Fabric is already positioned under a dual-license model, but the current repository still leaves room for future confusion in three areas:

1. where enterprise-only code should live
2. how enterprise packaging should interact with the public core
3. how to prevent accidental publication of proprietary code into the public repository

Without an explicit boundary, the team risks:

- mixing proprietary code into the public monorepo
- creating architecture that is too tightly coupled to separate cleanly later
- confusing contributors about what is open-source versus commercially distributed
- creating avoidable legal and operational risk in CI, release, and packaging flows

## 3. Problem Statement

The project currently has dual-license messaging, but it does not yet have a strong repository policy for open-core versus enterprise implementation.

That creates four practical problems:

1. the public repository can drift into hosting enterprise-only code
2. release automation can accidentally treat enterprise artifacts as if they belong in the OSS flow
3. contributors do not have a crisp contract for what belongs in the public repo
4. future enterprise work may take the easiest technical path, which is often the wrong licensing boundary

## 4. Goals

1. Define AX Fabric public repository scope as open-source core only.
2. Define enterprise implementation scope as separately distributed private code and artifacts.
3. Establish preferred technical boundaries for enterprise integration.
4. Add lightweight repository enforcement so accidental enterprise code placement is caught early.
5. Document a migration path for future private enterprise repo creation.

## 5. Non-Goals

- no creation of a new private GitHub repository inside this release
- no enterprise feature delivery in this repository
- no relicensing of existing open-source packages in this release
- no major package breakup or monorepo split in this phase
- no attempt to settle all downstream licensing questions inside one engineering document

## 6. Scope

### In Scope

- public documentation for repo boundary and packaging model
- repository rules describing what belongs in the OSS repo
- lightweight automated checks for forbidden enterprise-only paths in the public repo
- CI integration for that guard
- clear guidance on where future enterprise code should live

### Out of Scope

- private enterprise repo bootstrap automation
- customer-facing commercial packaging mechanics
- legal contract drafting beyond summary documentation
- source-available middle-ground licensing experiments

## 7. Product Definition

### Public AX Fabric Repository

The public repository is the source of truth for:

- `packages/contracts`
- `packages/akidb`
- `packages/akidb-native`
- `packages/fabric-ingest`
- OSS documentation
- OSS build, test, and release flows

This repository may describe commercial licensing and enterprise packaging, but it must not contain proprietary implementation code.

### Enterprise Delivery Model

Enterprise-only functionality should be delivered outside this repository through:

- a private GitHub repository
- private npm packages or equivalent package registries
- private Docker images or internal artifact registries
- separately licensed deployment bundles

### Preferred Technical Boundary

Enterprise extensions should prefer one of these boundaries:

- HTTP / REST / gRPC service boundary
- MCP server/client boundary
- CLI or job-runner boundary
- queue-driven asynchronous integration boundary

In-process plugin coupling, direct private-module linking, or shared-address-space extension should be treated as high-risk and avoided by default.

## 8. Functional Requirements

### FR-1 Public Repo Boundary Document

The repository must include a clear document explaining:

- what code belongs in the public repo
- what code belongs in a private enterprise repo
- what technical boundaries are preferred

### FR-2 Root Documentation Alignment

The root README and licensing documents must state that:

- this repository contains the open-source core
- commercial packaging and proprietary add-ons are distributed separately

### FR-3 Repository Guard

The repository must include an automated boundary check that fails when clearly enterprise-only source roots are introduced into the public repo.

The first phase guard may be path-based and intentionally simple.

### FR-4 CI Enforcement

The boundary guard must run in CI for pull requests and main-branch pushes.

### FR-5 Contributor Clarity

Contributors must be able to tell, from repository documentation alone, that enterprise implementation belongs in a private repository rather than this public monorepo.

## 9. Acceptance Criteria

This PRD is considered implemented when:

1. a new boundary document exists in the repo
2. README and licensing documents reflect the public/private split
3. a boundary-check script exists and passes on the current tree
4. CI runs the boundary check
5. the repository remains cleanly usable as OSS without enterprise source present

## 10. Release Plan

### Phase 1: Boundary Hardening in Public Repo

- add PRD
- add public boundary document
- update README and licensing summaries
- add guard script
- wire guard into CI

### Phase 2: Private Enterprise Repo Bootstrap

- create private repo
- move proprietary connectors / deployment logic / enterprise control plane there
- publish private artifacts through private registries

### Phase 3: Stable Integration Contract

- formalize public integration APIs between OSS core and enterprise systems
- document versioning expectations between public and private repos

## 11. Risks

### Risk: Guard is too weak

Mitigation:
- start with low-noise path checks
- extend later if the team sees concrete failure modes

### Risk: Guard is too strict

Mitigation:
- keep first version focused on obviously forbidden source roots
- do not ban documentation discussing enterprise concepts

### Risk: Developers still use the public repo for enterprise prototypes

Mitigation:
- document the rule clearly
- make CI fail early
- keep private repo creation as the next operational step

## 12. Recommendation

Proceed with `v3.2` as a packaging-boundary release.

The right first implementation is not a monorepo split. The right first implementation is a clear contract:

- public repo = open-source core
- private repo = enterprise implementation
- CI = guardrail against mixing the two
