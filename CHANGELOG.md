# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and image tags follow
semantic versioning. Releases before this file existed are in the git history and
the container registry.

## Unreleased

## 0.1.16

### Added

- Architecture decision records under `docs/adr/` covering the capability
  model, ciphertext-only control plane, relay direction, storage, isolation and
  lease enforcement.
- `docs/engineering-notes.md`: measured create-path bottleneck, burst behaviour
  and the ranked next experiments.
- `make verify` for the cluster-free check suite, `make docs-check` for Markdown
  and link linting, and `make assets` / `make demo-gif` for documentation media.
- Architecture diagram and repository social preview under `docs/assets/`.
- Issue and pull-request templates, Dependabot, CodeQL and OpenSSF Scorecard.
- Release workflow publishes a GitHub Release with image digests, SBOMs and
  build provenance.

### Changed

- Create path: the SDK caches the x402 challenge per session spec, so repeat
  creates send payment on the first request, and the paid path makes one
  capacity decision instead of two. Client p50 665 → 395 ms; server p50
  179 → 127 ms.
- Relay runs as a singleton with `maxSurge: 0`; two relays can no longer serve
  independent registries during a rollout.
- Benchmarks moved to `ejackson-vp/sandbox-bench`; the product repo keeps the
  methodology and links to the harness.
- README restructured around the problem, the trust boundary, measured
  performance and the design decisions; `docs/README.md` is an audience-based
  map rather than a flat list.

### Fixed

- A create that raced a relay restart could be split across two registries.
- Duplicate status and trust warning in the README opening section.

## 0.1.15

See the git history for the changes included in this and earlier tags.
