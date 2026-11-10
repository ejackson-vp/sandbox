# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and image tags follow
semantic versioning. Releases before this file existed are in the git history and
the container registry.

## 0.1.18

### Fixed

- The control runtime no longer ships the dev TypeScript native compiler
  (`@typescript/typescript-linux-x64`). npm marks TypeScript `devOptional`, so
  `--omit=dev` still installed its Go-built `tsc` binary, which carried five
  HIGH Go stdlib CVEs. The 0.1.17 control image failed the CVE gate; use 0.1.18.

### Added

- Scheduled, encrypted SQLite backups: a native online copy, integrity/row
  checks, streaming AES-256-GCM, retention, `sandbox_backup_age_seconds`, and a
  restore CLI/job (#18).

### Security

- Warm-pool claims are bound to the guest image and boot identity. A pod from an
  older image is never claimed and is drained on the next reconcile pass; the
  guest rejects a claim whose digest differs from its own and attests only its
  own value (#49).

### Testing

- Nightly cluster fault matrix and short fuzz jobs for the guest, relay and API
  boundaries (#39, #41).

## 0.1.17 (withdrawn)

The control image failed the CVE gate because the runtime shipped the dev
TypeScript compiler. No GitHub Release was published; use 0.1.18.

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

- A create that raced a relay restart could be split across two registries.
- Duplicate status and trust warning in the README opening section.

## 0.1.15

See the git history for the changes included in this and earlier tags.
