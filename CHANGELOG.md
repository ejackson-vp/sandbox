# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and image tags follow
semantic versioning. Releases before this file existed are in the git history and
the container registry.

## Unreleased

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

### Changed

- README restructured around the problem, the trust boundary, measured
  performance and the design decisions, instead of reading as internal notes.
- `docs/README.md` is now an audience-based map rather than a flat list.
- Release workflow now publishes a GitHub Release with generated notes, image
  digests, SBOMs and build provenance.

### Fixed

- Duplicate status and trust warning in the README opening section.

## 0.1.15

Image tag currently deployed by `deploy/talos`. See the git history for the
changes included in this and earlier tags.
