# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and image tags follow
semantic versioning. Releases before this file existed are in the git history and
the container registry.

## Unreleased

### Added

- Single-use challenge nonce in the 402 response (`accepts[0].extra.challengeNonce`,
  `cn_` + 128 bits), bound into the client commitment signature and burned in the
  controller's `challenge_nonces` table (schema v13) before capacity is held.
  This closes F-07: a captured *complete* create request is no longer a permanent
  replay. TTL `CHALLENGE_NONCE_TTL_MS` (180 s), cap
  `CHALLENGE_NONCE_MAX_ACTIVE` (20 000). See
  [docs/security-guarantees.md](docs/security-guarantees.md) and #47.
- Kyverno `ClusterPolicy` that rejects a guest pod whose image is not
  `<repository>@sha256:<64 hex>` in the pinned repository, or whose digest is not
  the released one. Scoped by the namespace label `x402.io/image-policy`
  (`enforce` by default, `dev-unpinned` documented for local kind). Not installed
  by `make deploy`; see
  [deploy/kubernetes/kyverno](deploy/kubernetes/kyverno/README.md) and #30.

- Durable per-payer and global create budgets in the controller (schema v14,
  `payer_budgets`): creates and committed spend per fixed window, plus
  concurrency counted from live sessions. Checked after the client commitment is
  verified and before any capacity hold, intent claim or settlement; a rejection
  is `429 budget_exhausted` with the scope, `Retry-After` and the remaining
  budget. Spend is committed in the same transaction as the payment and ledger
  rows, against the payer the facilitator verified, so a failure cannot lock a
  payer out and a settlement cannot be invisible to the budget. Limits:
  `BUDGET_WINDOW_MS`, `PAYER_CREATES_PER_WINDOW`, `PAYER_SPEND_PER_WINDOW`,
  `PAYER_CONCURRENT_SESSIONS`, `GLOBAL_CREATES_PER_WINDOW`,
  `GLOBAL_CONCURRENT_SESSIONS`. See
  [docs/admission-control.md](docs/admission-control.md) and #48.
- API metrics `sandbox_rate_limited_total{scope="payer_budget"|"global_budget"}`
  and controller metric `sandbox_budget_rejections_total{scope}`; auth failures
  gain `challenge_nonce_{missing,expired,reused,unknown}`.

- Settlement reconciliation and an opt-in refund worker (#31, schema v15).
  `payment_intents` records the payment requirements at claim time;
  `SettlementRecovery` finds intents `claimed` past
  `SETTLEMENT_RECOVERY_GRACE_MS` whose payment settled at the facilitator and
  writes a `REFUND_PENDING` ledger row (`unsettled:<paymentKey>`,
  `settled_without_entitlement`) instead of losing the payment. `RefundWorker`
  executes `REFUND_PENDING` rows through `REFUND_WEBHOOK_URL` with attempt
  counting, backoff and a give-up limit; with no webhook it does nothing.
  `payment_ledger.settlement_nonce` lets a refund be keyed by the EIP-3009 nonce
  (`GET /internal/payments/by-nonce/:nonce`, refund endpoint accepts either).
  Never run against real money; the mock facilitator is the only backend tested.
- Effectively-once refund execution (schema v18). A claim pass moves due rows to
  `REFUND_SENDING` with `refund_claim_token` and `refund_claimed_at`, using
  `SELECT ... FOR UPDATE SKIP LOCKED`, so two workers never own the same row and a
  crash or timeout after the provider paid is recovered by a lease reclaim. Every
  attempt sends the stored `refund_idempotency_key` (`refund:<paymentKey>`) as an
  `Idempotency-Key` header and in the body; completion is conditional on the
  claim token. Definite refusals count an attempt and back off;
  ambiguous outcomes stay `REFUND_SENDING` and retry with the same key;
  `REFUND_MAX_ATTEMPTS` bounds refusals only. New config
  `REFUND_CLAIM_LEASE_MS`, gauges `sandbox_refunds_sending`, counters
  `sandbox_refund_worker_total{result}` gain `unknown`, `reclaimed` and
  `claim_lost`. The manual refund endpoint refuses `REFUND_SENDING`.
- Refund policy for relay loss: a session terminated as `failure:relay_lost` is
  refunded in full even though it reached READY, and start-up reconciliation
  repairs terminal `relay_lost` rows left `SETTLED`. Client destroys and ordinary
  lease expiry after READY are still not refunded.
- Double-charge guard: a second signed payment for a `(clientPublicKey,
  clientNonce)` pair that already owns a session is refunded
  (`duplicate_client_nonce`) and refused with `409 duplicate_session`.
- Metrics: `sandbox_refund_worker_total{result}`, `sandbox_refunds_pending`,
  `sandbox_settlement_recovery_total{result}`.
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
- Releases are gated on executed isolation evidence (#44). The `isolation` job
  deploys the scanned image digests to a disposable kind + Cilium cluster,
  switches the sandbox RuntimeClass to Kata, proves a Pod boots under it, runs
  the packet-level isolation suite, and records the tested digests in
  `artifacts/isolation/tested-images.json`. `promote` needs it, so a release
  cannot be tagged when the suite did not run. A release owner can skip the
  gate only by setting the repository variable `ISOLATION_EVIDENCE=none`, which
  stamps a warning into the job summary and the top of the release notes;
  without a runner or that acknowledgement the tag still fails. See
  [docs/release-process.md](docs/release-process.md#isolation-gate).
- `sandbox_relay_connection_resets_total{mode="tcp_reset"|"terminate"}` records
  which mechanism ended a guest link after an epoch withdrawal (#128). The
  `terminate` fallback is a close ordered after queued frames, so a non-zero
  value for it means the stale-frame guarantee degraded; it also logs
  `relay_reset_fell_back_to_terminate`.
- Operation results survive the relay cache (schema v17,
  `exec_requests.result_envelope`). The controller keeps the client-sealed
  envelope with the request row when it observes it (owning POST, duplicate-retry
  POST and GET), so a retry with the same `requestId` is answered after the
  relay's 5 minute / 64 entry cache evicts it instead of returning `410
  result_expired`. The column is client ciphertext the controller cannot open,
  is never written above `MAX_PERSISTED_RESULT_BYTES` (1 MiB, larger results are
  dropped, not truncated, and keep the cache-only behaviour), and is cleared for
  the session in the same transaction as the terminal finalize. Request rows stay
  for audit. Additive and nullable: pre-v17 rows serve what they served before.

### Security

- Operation idempotency keys are bound to the request payload (schema v16,
  `exec_requests.payload_hash`). The operation request accepts an optional
  `payloadHash`, the SHA-256 of the canonical operation plaintext (the SDK sends
  it on both the POST body and the GET query); reusing a `requestId` for a
  different operation is refused with `409 idempotency_key_reused` instead of
  returning the first operation's cached result. A same-operation retry still
  replays even when the envelope was re-sealed. A client that sends no hash keeps
  the ciphertext binding, and rows written before v16 keep a null hash and accept
  any duplicate.
- The controller's database now stores client-sealed result ciphertext
  (`exec_requests.result_envelope`, schema v17). It holds no key for it and
  cannot open it, the same as the relay, and the column is cleared when the
  session is finalized. This is a storage addition to the trust boundary, not a
  new plaintext surface; see [docs/threat-model.md](docs/threat-model.md).

### Changed

- **Breaking:** the SQLite store backend is removed. The controller requires
  `DATABASE_URL` and always uses Postgres; `STORE_BACKEND`, `DB_PATH` and the
  encrypted SQLite backup settings are refused at startup. The deployment runs a
  Postgres StatefulSet, the controller no longer takes backups, and the docs
  point at CloudNativePG or pgBackRest with a restore drill. There are no
  customers and no stored data to migrate.
- CodeQL analyses every branch push, not just `main`, so a commit that lands
  inside a multi-commit push still has its own analysis (the OpenSSF `SAST`
  check reads that).
- **Breaking (SDK 0.3.0):** the client commitment is domain
  `x402-sandbox/client-commitment/v2`, which covers `challengeNonce`, and
  `challengeNonce` is now required on any paid `POST /v1/sessions`. A v1 client
  (no `challengeNonce`, signature over the v1 message) receives a `402` with a
  fresh challenge instead of a capability, so it fails closed rather than being
  served on an unproven freshness value. `@x402s/sdk` 0.3.0 signs v2 and drops
  the cached-challenge fast path, so every create takes the 402 round trip
  (+1 RTT). No external clients exist yet; the SDK is unpublished.
- The SDK retries a rejected challenge with the same payment payload and a new
  signature, so a burned/expired challenge recovers the same entitlement instead
  of paying twice.
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
- The controller's store ports return `Promise`s, and every caller awaits them
  (first step of #25, see [ADR 0010](docs/adr/0010-controller-ha-storage.md)).
  No behaviour change: the SQLite adapter is still one blocking statement per
  method and no `BEGIN IMMEDIATE` transaction contains an `await`. The point is
  the interface shape, because no Postgres client can be called from a
  synchronous method. Consequences a reader should know: a store call is now an
  interleaving point, so where a use case used to read and then write without a
  gap the decision either stays inside the adapter (guarded `UPDATE ... WHERE
  state = ...`, the operation claim, settlement) or is re-checked on the write;
  a store failure now surfaces as a rejected promise rather than a synchronous
  throw; and the readiness probe, the scrape-time SQLite gauges and leadership
  acquisition (which runs startup recovery) are awaited before the thing they
  gate. The operation gate and recovery moved to `controller/src/store/operations.ts`
  so `Store` stays inside the module size limit.
- CI runs `go vet` and `gofmt` on the guest, and the transfer, workload and
  browser-compatibility suites, which no job ran before. The release gate now
  matches `ci.yml`, including the test typecheck and profile-pin check.
- The verification loop got faster without losing a gate. The unit, property,
  coverage and portable suites opt into `--fileParallelism` (915 unit tests:
  ~24 s serial, ~4 s parallel, still serial by default for integration and
  security), the duplicate `coverage` CI job is folded into `unit`, which now
  runs `test:coverage` once and enforces a 55% lines / 45% branches / 45%
  functions floor, `npm test` is unit + property instead of everything, and
  `make docs-check` lints and link-checks the same globs with the same lychee
  flags as `docs.yml`, fragments included.

### Fixed

- A relay restart now actually reconnects. The guest URL was a ready relay Pod
  IP, so the replacement Pod's new IP left every supervisor on the shard dialling
  a dead address, and the session survived only in name. The guest address is now
  a stable ClusterIP: the `relay` Service at one replica and a per-shard
  `relay-<n>` Service above one, created by `make dev-scale N`. The controller's
  own admin address is unchanged. A guest cannot resolve DNS, so a Service name
  was never an option; a Pod IP cannot survive replacement.
- An operation the relay accepted and then lost is `outcome_unknown`. The relay's
  response endpoint now returns a structured failure code
  (`guest_disconnected`, `request_superseded`, `guest_error`,
  `session_destroyed`) instead of one generic 409. The controller marks a link
  loss `outcome_unknown` and answers `409 outcome_unknown`, leaving the
  single-operation gate closed for the fence; a lookup and a same-id retry keep
  answering that, even when the retry's payload hash differs. A guest-reported
  error still answers `502 guest_error`. Previously the caller saw
  `502 guest_error: "guest disconnected"`, the row was finished `error`, and a
  lookup returned `410 result_expired`.
- The `relay-kill` fault case waits for every guest to be registered and
  connected on the replacement relay (new `sandbox_relay_connected_sessions`
  gauge) before it starts the new operation, instead of treating `READY && !busy`
  as sufficient. The workload probe no longer leaks kubectl "not found" stderr
  into the fault logs.
- A relay restart no longer kills a paid session. The relay registry is in
  memory, so a relay rollout dropped every guest socket on the shard; the
  supervisor exited with its link, the Pod went terminal, and the controller
  failed a session that had already reached `READY` with
  `failure:guest_exited` and no refund. The supervisor now aborts the operation
  the link was carrying, reconnects with bounded backoff until the lease ends,
  re-sends `hello` with the same session id, key and token, and republishes its
  slot state. The controller detects the relay generation change, marks the
  in-flight request `outcome_unknown`, bumps `sessions.exec_epoch` once, and
  re-registers `READY`/`ACTIVE` sessions on the replacement with the token hash
  they already have. `OperationFence` holds the gate until the reconnected guest
  reports idle; a guest that cannot reconnect ends the session with
  `failure:relay_lost` at the end of `RELAY_LOSS_GRACE_MS` (default 90 s) or 1 s
  before the lease deadline, whichever comes first, and is refunded in full by
  the refund policy. The lease bound is why a 60 s session with a 90 s grace is
  still `relay_lost` and not `lease_expired`; an overrun the lease check notices
  while the loss window is open is attributed to `relay_lost` too. A retry of the
  interrupted request id is `409 outcome_unknown` and is never re-executed. See
  [ADR 0011](docs/adr/0011-guest-reconnects-after-relay-loss.md).
- A create retry that already booted a Pod adopts it before `register_relay`
  replays, so it no longer rotates the guest token under a running guest.
- Guest results carry `truncated` again. `Result.Truncated` and
  `Result.BodyTruncated` shared the `truncated` JSON tag, so `encoding/json`
  dropped both and neither exec stdout/stderr truncation nor HTTP body
  truncation ever reached the SDK. The field is now one op-dependent value, a
  golden marshal test pins both shapes, and CI runs `go vet`, which catches
  duplicate tags.

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
