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

### Security

- Session capabilities are bound to the paying wallet: a captured
  `PAYMENT-SIGNATURE` can no longer recover a capability or bind the session to
  another client key. The payer signs a canonical client commitment, which is
  part of the spec hash (`security-review/FINDINGS.md` F-02).
- Egress proxy connection slots are reserved before DNS and released on every
  path, with an independent global budget (F-01).
- Schema migrations are additive and transactional; payments, ledger and
  refund obligations survive upgrades, and newer databases are refused (F-03).
- Custom sessions are priced by CPU, RAM and disk, monotonic in each dimension
  (F-04).
- Rate-limit eviction no longer clears the table on high-cardinality input
  (F-05).
- Full audit, scanner triage and release gate in `security-review/`.

### Fixed

- Duplicate status and trust warning in the README opening section.

## 0.1.15

Image tag currently deployed by `deploy/talos`. See the git history for the
changes included in this and earlier tags.
