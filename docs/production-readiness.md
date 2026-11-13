# Production readiness

This is a working local proof of concept of a general-purpose leased sandbox.
Below is every gap between it and a production service, ordered by risk, with the
concrete next step.

## 1. Blocking gaps

| # | Gap | Why it matters | Next step |
| --- | --- | --- | --- |
| 1 | **No hardware attestation** | dev/Kata evidence is signed by a published key | out of scope for this repository; it needs TEE hardware and an independent verifier |
| 2 | **Shared host kernel in dev mode** | container escape is possible for hostile code | require Kata minimum; validate before launch |
| 3 | **The database is a single Postgres pod** | one primary on a `ReadWriteOnce` volume, pinned to the control-plane node like the rest of the control plane. Losing the node loses the store until the pod is rescheduled and the volume reattached (30s to 2min on most clouds), so this is not database HA, and nothing in this repository backs it up | move the store onto CloudNativePG (streaming replicas + PITR) or pgBackRest, and record a failover that does not wait for a volume detach. [ADR 0010](adr/0010-controller-ha-storage.md), [backup-restore.md](backup-restore.md) |
| 4 | **Relay is an in-memory registry per pod** | a restart loses pending ciphertext and the registration; with the default stable ClusterIP the guest reconnects and the interrupted operation is `outcome_unknown`. On clusters whose guest policy denies Service VIPs, `RELAY_GUEST_ADDRESS=pod` keeps sessions working but cannot follow the replacement, so the grace ends `relay_lost` and refunds ([ADR 0012](adr/0012-guest-reconnects-after-relay-loss.md)). Replicas hold disjoint sessions, addressed by deterministic shard affinity and enforced in the token, so N>1 no longer splits a session. A restart still costs one interrupted operation and up to `RELAY_LOSS_GRACE_MS`, or the rest of a shorter lease, of no operations while the guest reconnects, and that case is refunded | Redis/NATS with per-session queues and TTLs (ciphertext only) if a relay restart must also stop interrupting the operation in flight |
| 5 | **Settlement recovery needs a facilitator lookup** | the controller can now reconcile a settled-but-unentitled payment into a refundable ledger row, but only if the facilitator exposes `GET /settlements/:paymentKey`. Testnet's public facilitator does not, so that window still answers `409 reconciliation_pending` | use a facilitator with a settlement lookup or a webhook, and record the run that proves it |
| 6 | **Real refunds have never run** | mock mode auto-refunds; a real mode records `REFUND_PENDING` and the refund worker sends it to an operator-configured webhook. Nothing in this repository has moved testnet funds, and the webhook contract is defined here rather than by a facilitator | a settlement-sandbox end-to-end run: settle, kill the controller, prove the refund executes. See [payment-ledger.md](payment-ledger.md) |
| 7 | **Image pinning has no admission layer on the cluster** | the controller refuses to start with an unpinned guest image when `KUBERNETES_ENABLED=true`, and pulls `repo@sha256:…` whenever a digest is configured, dev mode or not, so a moved tag cannot change what runs inside the VM. A compromised *node* can still run anything | a Kyverno `ClusterPolicy` now rejects a guest pod whose image is not the pinned repository+digest ([deploy/kubernetes/kyverno](../deploy/kubernetes/kyverno/README.md)); it is inert until Kyverno is installed, and it has not been executed against a cluster |
| 8 | **Dev attestation key is public by design** | anyone can forge dev evidence, so it is only safe while `ALLOW_INSECURE_DEV=true` | hardware attestation. The other credentials are no longer in the public repo: local runs generate them, and the homelab injects its own from SOPS |
| 9 | **Checkpoint workspaces are plaintext PVCs** | node/storage admins can read suspended session files; the homelab's `local-path` has no encryption and the controller cannot verify a CSI driver's parameters | decided in [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md): no at-rest encryption is claimed anywhere, the boundary is stated in [security-guarantees.md](security-guarantees.md) and [lifecycle.md](lifecycle.md), and PVC expiry plus an orphan-volume sweep are implemented. The real fix — client-side encrypted checkpoint objects with a client-held key — is a protocol change and is split into follow-up 1 in the ADR |
| 10 | **No memory snapshot** | resume loses processes, memory and open sockets; this is disk-only | Firecracker snapshot or Kata/CRIU on a KVM host; until then call it a checkpoint, not a snapshot |
| 11 | **Suspend/resume pricing undefined** | a resume starts a fresh lease in the mock model | bill active time + storage, or charge per resume; decide before charging real money |
| 12 | **Checkpoints are node-pinned** | local-path PVCs cannot resume after node loss; `resume_unavailable` is fail-fast, not HA | RWX/network storage or Firecracker snapshot/restore before promising node-failure recovery |
| 13 | **Checkpoint storage has no backup/replication** | deleting or corrupting the PVC makes the session unrecoverable (`checkpoint_missing`); the database backups do **not** contain workspaces, so a restore does not bring sessions back | encrypted object-store checkpoint (same follow-up as item 9), or storage-level snapshots/backups with their own retention. Document the RPO/RTO for checkpoint data separately from the ledger |

## 2. Security hardening backlog

- **The app repo ships no credentials.** Local runs generate a git-ignored
  Secret (`scripts/dev-secrets.sh`); the homelab applies its own from the
  private repo, SOPS-encrypted. The one committed key is the dev attestation
  seed, which is published by design and labelled `insecureDevOnly` everywhere.
- **Credential separation** is enforced at startup: `CAPABILITY_SECRET` must be
  present and must differ from `CONTROLLER_ADMIN_TOKEN`, and an empty admin token
  is a startup error rather than a 401 on the first request. The capability key
  derives session capabilities; the admin token authenticates to the controller.
  Sharing them meant a leaked capability key also authenticated to the
  controller, and rotating one silently invalidated the other.
- **HTTP receipt timeouts** bound slow clients: `HTTP_HEADERS_TIMEOUT_MS`
  (default 15 s) and `HTTP_REQUEST_TIMEOUT_MS` (default 60 s). Both stop once the
  request has been received, so a long-poll `exec` is unaffected. A
  per-connection concurrency cap is deliberately absent — the API is tailnet-only
  and the per-IP bucket plus these timers is proportionate for one operator; it
  becomes necessary if the API is ever exposed publicly or scaled out.
- **Client IP behind one reverse proxy**: `TRUST_PROXY_HOPS` (default 0) trusts
  a forwarded hop, so `req.ip` is the real client instead of the proxy pod. The
  homelab sets it to 1 *and* scopes `allow-api` to the tailscale namespace, so
  no workload can forge `X-Forwarded-For`; kind keeps it at 0.
- **Image scanning** runs in the release workflow: Trivy on both images, SARIF
  to the Security tab, and a failure on fixable CRITICAL/HIGH. Note that the
  image tags are pushed before the scan, so a failed scan blocks the GitHub
  Release but not the pullable tag; promotion-after-scan is tracked in #42.
- **API→controller mTLS**: the controller's 3004 listener requires a client
  certificate with `CN=api`; the API presents it and no longer sends the bearer
  token on that path. NetworkPolicy admits the API only on 3004.
- **Controller→relay mTLS**: the relay's 8444 control listener requires a client
  certificate signed by its client CA, and enforces `CN=controller` on the
  authenticated TLS socket before Express handles the request; registration,
  state, requests, responses, claim and purge all use it, and the shared relay
  admin token is no longer accepted there. The guest WebSocket stays on plaintext 8443
  with its per-session bearer token, and the relay→controller wake keeps the
  low-privilege token on 3001. NetworkPolicy admits the controller only on 8444.
  A cluster relay refuses to start without `RELAY_TLS_*`, and the controller
  refuses an `https://` `RELAY_URL` without `RELAY_CLIENT_TLS_*`. Residual:
  certificate rotation and private-key custody live in the infrastructure repo;
  the dev CA is generated locally and git-ignored.
- **Capability derivation**: capabilities are HMAC over the payment key *and* the
  client commitment. The paying wallet must sign
  `{paymentKey, clientPublicKey, clientNonce}`, and the commitment is part of the
  spec hash, so a leaked `PAYMENT-SIGNATURE` cannot recover a capability or bind
  the session to another client key. Residual: replaying a **complete** captured
  create request (payment header, body and wallet signature) still recovers the
  capability; a server-issued freshness nonce would close it (#47).
- **Evidence validity window** is lease + 5 min so a CLI can re-attach mid-lease.
  If you require very fresh evidence, store the verified guest key client-side and
  skip re-attestation after the first verification.
- **Relay authentication**: bind the guest token to a projected pod identity in
  addition to the bearer token.
- **Seccomp profile**: `RuntimeDefault`; ship a custom profile for the toolchain.
- **Egress allowlist by hostname** (`EGRESS_ALLOWED_HOST_SUFFIXES`) is available
  but disabled; enable it for abuse reduction.
- **Package installs**: document proxy-aware commands (`pip --proxy`,
  `npm config set proxy`, `git -c http.proxy=…`); consider a caching proxy.
- **Audit log** of payment → session → operation counts → outcome, hash-chained.
- **Rate limiting** is per-replica in memory; move to a shared limiter.
- **Workspace race**: path validation is TOCTOU-safe for the customer's own
  session only (single tenant). A second process could race the check; the
  workspace is single-customer, so the impact is self-inflicted.
- **Suspend/resume**: the capability is extended to `maxLifetimeSeconds`, so a
  leaked capability remains valid across suspends. The workspace PVC is a new
  at-rest data store and it is **plaintext**; treat it as such in backup,
  retention and incident-response policy ([ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md)).
  Do not add it to a backup corpus unless that corpus is itself encrypted and
  has its own retention.
- **Suspendable sessions bypass the warm pool**: first READY and resume are cold
  (~0.9–5.8 s on the local rig), so the pool does not hide the checkpoint cost.

## 3. Reliability / operations

- Controller HA beyond one node. Leader election, the writer guard and the
  measured failover are in place, and the store is Postgres with the same
  invariants under `READ COMMITTED`, proved by the store contract suite. The
  controller has no database volume any more, so a second replica no longer
  waits on a PVC. What is still single-node is the database itself: one primary
  StatefulSet, no streaming replica, no PITR ([ADR 0010](adr/0010-controller-ha-storage.md)).
  Remaining: move the store onto CloudNativePG or pgBackRest and record a
  failover with the Postgres backend.
- Persist relay state so a relay restart does not interrupt the operation in
  flight either. A restart no longer fails a paid session (the guest reconnects),
  and a guest that cannot reconnect ends it with `failure:relay_lost`, which is
  refunded in full.
- Metrics: sessions created/expired/failed, provisioning latency, operation
  latency, timeouts, cancelled operations, relay pending, proxy denials by reason,
  reaper actions, orphan pods, intent recovery count.
- Scrape contract: every role publishes on a private `METRICS_PORT` (9100),
  never on the service listener; `deploy/monitoring/` contains one scrape job
  and a Grafana dashboard, and `allow-metrics-scrape` admits only the
  monitoring namespace. HTTP route labels are templates, never session ids.
  Process/event-loop/GC families are included so application latency can be
  separated from runtime pauses. What ships here is the portable contract
  (`deploy/monitoring/contract/`): scrape list, SLO rules and dashboard. The
  runnable homelab stack — VictoriaMetrics single-node + Grafana + vmalert,
  14-day retention, version-pinned images, provisioned dashboards and rules —
  lives in the private homelab repo (`apps/sandbox-monitoring/`), so a cluster
  that already runs Prometheus can take the contract without inheriting
  VictoriaMetrics.
- Alerts: `deploy/monitoring/contract/rules/sandbox-slo.yaml` implements the
  issue #38
  set — create p95, provisioning timeout rate, queue wait, relay pending,
  reconcile p95, create-route 409s (the current proxy for
  `reconciliation_pending`), warm pool empty — plus target-down and
  blast-radius, and the ledger audit rules (divergence, stale sessions, audit
  freshness and audit read failures). `reconciliation_pending` is not yet a
  per-code counter, and the
  warm-pool rule is inactive while `WARM_POOL_SIZE=0`. Settlement-failure,
  PVC-full, orphan-pod and database alerts are still not implemented. The rule
  file carries no receiver and the homelab stack evaluates with
  `-notifier.blackhole`: alert state is visible, nothing is paged.
- Incident procedures: egress abuse, orphan Pod/PVC cleanup, relay compromise and
  secret rotation each have a runbook under `docs/runbooks/`, plus a
  [tabletop script](runbooks/tabletop.md). None has been rehearsed, and the
  detection steps lean on log lines because the matching alerts (egress volume,
  orphan objects, PVC-full) are still not implemented.
- Load test: 100+ concurrent sessions; measure reconcile p95, relay fan-out, API
  latency for 8 MiB uploads.
- **Clock discipline.** Leases, payment-intent staleness and the 8 h lifetime cap
  are wall-clock values, and the guest, the controller and Kubernetes each
  enforce the same deadline from their own clock, so every node must run NTP
  (`chronyd` or `systemd-timesyncd`), correcting by slew once the cluster is
  serving traffic. A step is logged as `clock_skew_detected` with both readings
  and the sessions it moved; it is not corrected in-process. See
  [lifecycle.md](lifecycle.md#clock-assumptions) for what a step does and does
  not affect. Alert on any `clock_skew_detected` line, because the sessions it
  names may have ended early.
- Backup/restore of the Postgres metadata (sessions are disposable; payment
  records are not). The controller does not back anything up: the database layer
  owns backups, PITR, encryption and retention, and the restore drill runs the
  store contract suite against the restored copy.
  See [backup-restore.md](backup-restore.md).

## 4. Session product policy

- **Maximum lease**: 30 minutes by default (hard ceiling 1 h). Longer leases
  increase the blast radius and idle cost; decide deliberately.
- **Idle expiry**: currently a session burns its lease even if unused. Consider
  reducing the tier price or adding a short grace window.
- **Operation concurrency**: one foreground operation per sandbox. If customers
  need parallelism, add a second slot with explicit filesystem semantics rather
  than silently interleaving.
- **Background processes** are killed at command end; document this
  (`nohup`/daemons do not survive).
- **Abuse**: arbitrary code execution requires a content/abuse policy, takedown
  process and per-payer controls. The capability model is anonymous by design;
  payment is the only identity.

## 5. Payments

- Testnet: `PAYMENT_MODE=testnet`, `EVM_PRIVATE_KEY`, official
  `https://x402.org/facilitator`, network `eip155:84532`. Verify with a funded
  wallet:

  ```bash
  EVM_PRIVATE_KEY=0x… ./cli/dist/index.js create --tier short \
    --payment-mode testnet --api-url https://api.example
  ```

- Before mainnet: production facilitator, pinned network id, settlement
  reconciliation, refunds for failed provisioning, and a documented incident
  path for double-charge disputes. Durable per-payer and global spend/create
  budgets are implemented (#48, schema v14); the numbers still need to be
  sized against real traffic.
- Facilitator: `FACILITATOR_URL` defaults to the public testnet facilitator and
  to the local mock facilitator in mock mode. CDP is supported with
  `FACILITATOR_API_KEY_ID` and `FACILITATOR_API_KEY_SECRET` (both or neither,
  https only), which mint a short-lived ES256 JWT per request. Every call has
  `FACILITATOR_TIMEOUT_MS` (default 20 s); `verify` and `supported` retry a
  bounded number of times, and `settle` never does, because the nonce makes it
  idempotent at the facilitator and a lost answer is resolved on chain.
- Mainnet: `PAYMENT_MODE=mainnet` plus an explicit `NETWORK` (`eip155:8453`),
  a real `PAY_TO`, an explicit `FACILITATOR_URL` and `PAYMENT_RPC_URL` for the
  on-chain settlement check. There is no mainnet default for any of them, and
  startup refuses if one is missing. The SDK and CLI only build testnet
  payments today, so a mainnet payer client is still outstanding.

## 6. Isolated target (Kata)

- Deploy on hosts with KVM enabled and a Kata runtime installed. On Talos use the
  `kata-containers` system extension with `deploy/talos`; elsewhere use
  `deploy/kata` and set the handler to whatever `kubectl get runtimeclass`
  reports.
- Re-run `make security-test` against that deployment and confirm: the guest
  kernel differs from the host, there is no hostPath or host namespace, and
  network isolation is unchanged.
- Budget the RuntimeClass overhead: 130Mi and 250m per sandbox.
- Do not advertise provider-blind execution. Kata gives VM isolation, not a
  hardware root of trust, and a malicious operator can still run a modified
  guest.
