# Changelog

## v1.3.0

Enterprise offline stack operability release.

### Highlights

- Added `ax-fabric doctor` for local readiness, source-path, env-var, and endpoint checks
- Added machine-readable `--json` output for stack diagnostics and automation workflows
- Added `OPERATIONS.md` for startup order, troubleshooting, and reproducible local-stack demos
- Expanded stack guidance to clarify `ax-cli`, `ax-studio`, and `ax-serving` roles in the AX Fabric product family

### Notes

- See `OPERATIONS.md` for the recommended `v1.3` operating model
- See `STACK.md` for product-family architecture and endpoint responsibilities

## v1.2.1

Documentation and positioning update for the enterprise offline AI direction.

### Highlights

- Clarified AX Fabric as the core product for enterprise offline knowledge, retrieval, memory, and context
- Added product-family guidance covering `ax-cli`, `ax-studio`, and `ax-serving`
- Added a dedicated stack guide for the `v1.2.x` evaluation path
- Reframed QUICKSTART around first evaluation of the offline stack instead of a standalone vector-search demo

### Notes

- See `STACK.md` for the recommended product-family architecture
- See `QUICKSTART.md` for the updated first evaluation path

## v1.2.0

First public release of AX Fabric.

### Highlights

- Public release baseline established at `v1.2.0`
- Dual-license model introduced:
  - GNU AGPL v3 or later for open-source use
  - separate commercial licensing for Business and Enterprise use
- Public contribution policy clarified:
  - issue reports and feedback are welcome
  - unsolicited public code contributions are not accepted
- Licensing metadata normalized across TypeScript, Rust, and Python package surfaces

### Notes

- Business and Enterprise licensing terms are described in `LICENSE-COMMERCIAL.md`
- Issue-reporting policy is described in `CONTRIBUTING.md`
