# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and image tags follow
semantic versioning. Releases before this file existed are in the git history and
the container registry.

## Unreleased

### Added

- `runtime` is part of the create request, the immutable session spec and its
  hash, the session row (schema v12, `base` for existing rows), the controller
  view and the status/create responses. Profiles are `base`, `python` and
  `node`; `base` is the default and keeps the previous behaviour. An unknown
  name is a 400 `unsupported_runtime` before pricing, payment or any capacity
  hold, and a profile this controller has no image for is rejected by capacity
  admission before settlement.
- The warm pool is per runtime profile. `RUNTIME_PROFILES` declares a JSON
  catalog of `{image, digest}` entries, `base` stays the guest image, and each
  profile gets its own pre-booted pods. Warm claims carry the profile and are
  filtered on it, so a pod can never be claimed by a session that asked for
  another runtime. Cold pods pull the profile image and pass `RUNTIME_PROFILE`
  to the guest, and a session whose profile this controller does not run is
  terminated with `runtime_profile_unavailable` rather than booted on `base`.
- One `WarmPoolManager` owns every profile pool and a single shared budget.
  `base` holds `WARM_POOL_BASE_MIN`; other profiles start at zero and grow after
  a miss, with a cooldown and idle-drain grace so pools do not thrash. An idle
  profile is drained before a growing one is refused. `WARM_POOL_SIZE=0` still
  disables the pool entirely.
- The guest loads `/runtimes/<name>/profile.json` when `RUNTIME_PROFILE` names
  it, applies the manifest environment to exec and long-running services, and
  reports the profile name and version in attestation. `guest/Dockerfile.profile`
  and `guest/profiles/{python,node}.json` build the two language images.
- Controller leader election ([ADR 0009](docs/adr/0009-leader-election.md)). A
  replica holds a `coordination.k8s.io/v1` Lease before it reconciles or reports
  ready, so a second replica is a standby that can take over instead of a second
  scheduler over the same rows. A standby's store connection refuses writes.
  Failover, not throughput: the writer is still one process, and the SQLite
  volume is still ReadWriteOnce.
- The `python` and `node` profile images are released by the pipeline instead of
  by hand. `.github/workflows/release-profiles.yml` runs on the same `v*` tag,
  builds `guest/Dockerfile.profile` for `linux/amd64,linux/arm64` from the
  runtime images pinned in `guest/profiles/runtime-images.conf`, scans the
  staging digest with the guest image's `CRITICAL,HIGH`/`ignore-unfixed` policy,
  and only then creates `<version>-python` and `<version>-node` in the existing
  public `sandbox-guest` package. Each profile carries an SBOM and Sigstore
  build provenance, and its tag and index digest are recorded under
  `## Profile images` in the release body and in a `profile-images.json` asset.
  Profile tags are never moved, and never created for a tag whose control/guest
  release did not succeed. The `0.1.23-*` and `0.1.24-*` tags remain the
  hand-built images that predate this.
- `guest/build-profiles.sh` builds from that same pin file, so a local image has
  the release's build inputs, and `guest/check-profiles.sh` fails CI when the
  pin file and `guest/profiles/*.json` disagree.
- Capabilities carry a key id (`k1.<mac>`) and the API holds a verify set, so
  `CAPABILITY_SECRET` can be rotated without draining sessions:
  `CAPABILITY_KEY_ID`, `CAPABILITY_SECRET_PREVIOUS` and
  `CAPABILITY_PREVIOUS_KEY_ID` are accepted during the overlap. The MAC input is
  unchanged, so this is not a repeat of the F-08 derivation break, and a token
  issued before the key id existed still verifies. A create replay after a
  rotation returns the capability the session was issued rather than a fresh one
  whose hash would not match. Retiring a key rejects its id immediately. See
  `docs/runbooks/secret-rotation.md`.
- `ADMIN_TOKEN_PREVIOUS` is accepted, not presented, on the controller's
  `/internal/*` routes during an admin token rotation, so the API and the
  controller can be rolled in either order.
- Incident runbooks for egress abuse, orphan Pod/PVC cleanup, relay compromise
  and secret rotation, plus a tabletop exercise script and a gap list, under
  `docs/runbooks/`.

### Changed

- CodeQL analyses every branch push, not just `main`, so a commit that lands
  inside a multi-commit push still has its own analysis (the OpenSSF `SAST`
  check reads that).
- Provisioning is table-driven end to end. `PAID -> PROVISIONING` and
  `SUSPENDED -> RESUMING` now execute the effect list their transition returns
  through the controller's effect interpreter, so `register_relay`,
  `ensure_workspace_pvc` and `start_pod` are no longer run out of band by the
  use case. Admission (provisioning slot, relay readiness, capacity
  reservation, shard endpoint) still runs before the transition: a prerequisite
  that is not ready leaves the session in its current state and the next pass
  retries. The SUSPENDING crash-repair replay is a new `suspend_retry` event
  rather than a hand-built effect list.
- The SDK `run` doc comment no longer says `base` is the only runtime. It
  documents `runtime` as `base` (default), `python` or `node`, rejected at
  create time when the controller does not run that profile.

## 0.1.22

### Added

- Keyless SLSA build provenance for both release images. The Sigstore bundle and
  its in-toto statement are attached as `sandbox-<name>.sigstore.json` and
  `sandbox-<name>.intoto.jsonl`, and the attestation is pushed to GHCR (#121).
- TypeScript coverage is measured in CI and published as a README badge (#121).

### Changed

- Readiness reads one relay snapshot stamped with the relay process generation
  and reuses the connection for read-only snapshots. Writes still open a fresh
  connection. This removes two mTLS probes from every readiness pass (#127).
- The docs gate runs on every pull request instead of only when a Markdown path
  changes, so non-Markdown PRs no longer wait on checks that never report (#125).
- README leads with the demo, and the logo, architecture diagram and social
  preview use the navy and mint palette (#126).

### Fixed

- Coverage options moved under `test.coverage`, where Vitest 5 reads them, so
  the badge job finds `coverage-summary.json` (#124).
- The performance claim is corrected: the 0.1.16 numbers are a baseline, and a
  0.1.20 spot check measured 287 ms server-side readiness (#116, #127).

## 0.1.21

### Added

- The relay exports `sandbox_relay_active_requests`, the number of operations
  the guests themselves report as running. The lifecycle fault harness waits
  for this gauge before killing the controller, so it tests an observed
  operation rather than racing the guest's status frame (#108).

### Fixed

- A relay replacement no longer strands paid creates on the old relay Pod IP.
  The controller resolves the relay endpoint on every use instead of caching it
  for 30 seconds, and re-resolves it after generation-checked registration. If
  the replacement lands after the Pod was created but before the guest dials,
  the controller deletes that Pod and recreates it against the current endpoint
  rather than waiting out `PROVISIONING_TIMEOUT_MS` (#109).
- A stale operation response can no longer clear the recovery fence. After a
  controller restart, `finishOperation` only clears `active_request_id` when the
  request still transitions from `pending`; a request already marked
  `outcome_unknown` remains owned by `OperationFence` until the guest reports
  it idle at the new epoch (#111).
- A resumed session can no longer reach `READY` with its compute reservation
  still counted as `SUSPENDED`. The reaper could re-suspend the reservation
  between admission and `markResuming`; the controller now reasserts the
  allocation once the session is `RESUMING` (#114).

## 0.1.20

### Added

- `POST /v1/sessions` returns the session view as `session`, in the same shape
  as `GET /v1/sessions/{id}`. The SDK builds its handle from it, so a create no
  longer needs a status request before the client can start polling. The field
  is additive and older clients ignore it (#27).
- Orphan workspace PVCs with no live session are deleted after
  `ORPHAN_PVC_GRACE_MS` (default 1h), bounding the plaintext-checkpoint
  exposure window after lost metadata or interrupted cleanup (#102).
- Release images are stamped with `BUILD_VERSION`/`BUILD_COMMIT` and OCI
  version/revision labels (#98).

### Security

- Recovery now closes the stale-frame window in the execution-epoch fence. The
  relay enforces the session's `exec_epoch` as a forwarding floor and withdraws
  a frame that the previous controller generation forwarded but the guest never
  observed, so such a frame cannot start after recovery (#88). The guest's
  high-water check remains as defence in depth. A withdrawal resets the guest
  link; because the supervisor exits on link loss and sandbox Pods use
  `restartPolicy: Never`, that session ends `FAILED` with
  `failure:guest_exited` (no refund, since it had reached READY) instead of
  staying `READY` without a guest. See
  [ADR 0008](docs/adr/0008-relay-enforces-execution-epoch.md).

### Changed

- The controller folds the session view into the payment-intent completion, so
  the API no longer makes a separate `GET /internal/sessions/:id` on the
  successful create path. Older controllers fall back to that lookup (#27).
- Monitoring is split by ownership: this repository keeps the portable contract
  under `deploy/monitoring/contract/` (scrape list, SLO rules, Grafana
  dashboard, metric/SLO docs), and the cluster-specific VictoriaMetrics +
  vmalert + Grafana stack moves to the private homelab repository. Object
  names, the dashboard uid and the scrape targets are unchanged.
- Grafana's homelab memory request is raised to 256Mi (limit 512Mi) after the
  measured 228Mi steady state made it the first eviction candidate (#101).

### Fixed

- The Kubernetes guest-digest guard applies only to `controller`/`all` roles;
  relay/proxy/facilitator no longer crashloop on the dev placeholder (#97).
- The relay loads the shared control ConfigMap, so it receives the pinned guest
  digest and TLS settings at startup (#95).

## 0.1.19

### Added

- One-shot `sandbox.run()` in the TypeScript SDK and `sandbox run` CLI: create,
  upload, exec, download and always destroy, with a fresh session per run
  (#80).
- A private metrics listener (`METRICS_PORT`, default 9100) for API, controller
  and relay, a bounded-label scrape contract, process/event-loop/GC metrics, a
  Grafana dashboard and a scrape manifest. The public ingress no longer serves
  `/metrics` (#37).
- Lightweight homelab monitoring under `deploy/monitoring/`: VictoriaMetrics
  single-node, Grafana and vmalert with 14-day retention, a provisioned
  dashboard and the issue #38 SLO rules (including target-down and
  blast-radius) (#38).
- Nightly TLA+ model checking with a pinned Java/TLC toolchain and failure
  artifacts (#73).
- Execution-epoch, guest-status and fence-release modeling, plus `FenceRelease`
  and `StaleEpoch` broken variants (#75).

### Security

- Relay control endpoints require mTLS with a client certificate whose CN is
  `controller`; plaintext and wrong-identity clients are rejected. The guest
  WebSocket listener and its per-session bearer token are unchanged (#23).

### Changed

- The controller reconciles readiness and terminal cleanup in bounded parallel
  phases with per-session serialization and queue metrics (#21).
- Liveness and readiness are separate. Readiness checks store writability and
  migrations, relay reachability and provisioner reachability with a short
  cache (#50).
- The internal controller/relay listeners are rate-limited and their CodeQL
  missing-rate-limit findings are resolved with a repository-owned token bucket
  (#86).

### Fixed

- Relay replacement during a create no longer loses the session registration;
  the controller gates admission on the current relay generation and the guest
  dial window exceeds the provisioning timeout (#17).
- Operation fencing and payment-intent fencing prevent unsafe duplicate
  execution and completion after a controller restart (#19, #20).
- Suspended sessions no longer charge peak compute while `RELEASING` (#72), and
  peak storage is accounted consistently (#68).
- Kubernetes deployments reject an unpinned guest image digest independently of
  the payment/attestation dev switch (#4).

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
