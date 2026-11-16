# Operational readiness review

What this is: the document an on-call engineer reads at 2am to decide whether
to page, roll back, or ride it out. It describes the repository at `4d5e26c`,
on branch `docs/orr`, and it has not been through an incident: no page has ever
been delivered, no failover has been measured on the deployed store, and no
real money has moved. Where a claim depends on one of those, the text says so.

The verdict in one line: a trusted private beta is conditionally ready, and a
public beta that takes real money is blocked by five things. The security
evidence and the verdicts live in
[security-review/RELEASE_GATE.md](../security-review/RELEASE_GATE.md) and
[security-review/FINDINGS.md](../security-review/FINDINGS.md); this review does
not restate them, it turns them into operating instructions.

## 1. Service summary

A customer pays once through x402 and receives a leased Linux sandbox: a
temporary computer with a fixed duration (60 s to 1800 s for the published
tiers), hard CPU, memory and disk limits, a `/workspace`, and an arbitrary
command API. There are no accounts and no API keys; the payment is the only
identity. The control plane sees ciphertext and metadata, never command text,
file contents or output
([architecture.md](architecture.md),
[security-guarantees.md](security-guarantees.md)).

The components and the failure domain each one owns:

| Component | Replicas | Durable state | What its loss takes out |
| --- | --- | --- | --- |
| API (`api/`) | 1 Deployment | none | Every public read and write: create, status, exec, destroy. Live guests keep running. |
| Controller (`controller/src/`) | 1 Deployment, `Recreate`, one writer | Postgres | Reconciliation, provisioning, lease enforcement, refunds, ledger audit. Live guests keep running until their own watchdog and Kubernetes `activeDeadlineSeconds` end them. |
| Session relay (`controller/src/relay.ts`) | 2 shards, StatefulSet | in-memory registry | Operation traffic for the sessions on that shard. Guests reconnect (ADR 0012); one operation in flight is lost. |
| Egress proxy (`controller/src/egress-proxy.ts`) | 1 StatefulSet | none | Internet access for every guest. Sessions and relay links survive. |
| Postgres | 1 primary StatefulSet on one `ReadWriteOnce` volume | payments, ledger, intents, sessions | Everything durable above. Sessions keep running; nothing can be reconciled, extended or terminated by the control plane. |
| Guest supervisor (`guest/`, Go) | one per session | workspace (`emptyDir` or per-session PVC) | That one session. |
| cloudflared | 2 pods in the private deployment overlay | none | The public hostname. The operator path over Tailscale is separate. |

The important asymmetry: the API, controller, Postgres and cloudflared all run
on, or are pinned to, the control-plane node, so that node is a single failure
domain for the whole control plane. The sandbox workloads run on a tainted,
separate node ([architecture.md](architecture.md) §6).

## 2. Dependencies

Every external thing the service needs, and what happens when it is slow or
gone. "Closed" means the request is refused rather than admitted unaccounted.

| Dependency | Used for | When slow | When absent | Fails |
| --- | --- | --- | --- | --- |
| x402 facilitator | `verify` and `settle` on the create path | Every call times out at `FACILITATOR_TIMEOUT_MS` (20 s default). `verify` retries a bounded number of times; `settle` never retries, because the nonce makes it idempotent and a lost answer is resolved on chain. Creates get slower up to 20 s each, then fail. | No create can settle, so no session is created. No money moves. Refunds do not use the facilitator; they use the operator webhook. | Closed |
| Chain RPC (`PAYMENT_RPC_URL`) | Proving the transfer behind a consumed nonce; settlement recovery | A create that needs the check (recovery and the first-attempt proof path) stalls on RPC latency inside the 12-call cap. | `not-found` and read errors are both `unavailable`, so entitlement is withheld and the intent stays `claimed` for the recovery worker. The API answers `409 reconciliation_pending`. With neither RPC nor a facilitator lookup, the debt is only visible to a human reconciling the chain. | Closed |
| Postgres | Every durable decision, including admission budgets | Creates slow down. Readiness removes the controller in roughly 17 s: a 2 s result cache, a 5 s probe period and `failureThreshold: 3`. | Controller reports not-ready and is removed from Service endpoints. The API answers `503 admission_unavailable` rather than admitting unaccounted work. Live sessions are unaffected until their lease ends. | Closed |
| Relay | Every operation, upload and download | `sandbox_relay_pending_requests` rises; clients see long `exec` calls. | The guest reconnects with bounded backoff. If it cannot, the session ends `failure:relay_lost` at `RELAY_LOSS_GRACE_MS` (90 s) or 1 s before the lease, whichever is first, and is refunded in full. In `RELAY_GUEST_ADDRESS=pod` mode there is no continuity at all. | Partly open: the session survives, the operation in flight does not |
| Kubernetes API | Pod and PVC lifecycle, Lease election | Provisioning slows; reconciles slow; queue wait rises. | No pod can be created or deleted. A session stays `PAID` and is failed by the queue timeout (120 s) or, once it got as far as a pod, by `PROVISIONING_TIMEOUT_MS` (90 s). A running session is not reconciled, and its pod survives until the in-pod watchdog and `activeDeadlineSeconds` end it. | Closed for creates |
| Cloudflare tunnel | The only public ingress to the API | Cloudflare answers `524` for a proxied request over 100 s, which is why `waitMs` is capped below it and long commands answer `202 pending`. | `502` at the public host. Nothing on the internet can create, poll or destroy. Existing sessions keep executing until their lease ends. The operator path over Tailscale still works. | Closed externally |
| Egress proxy | All guest internet access | Guest `CONNECT` calls hang or fail; workloads that need the network break. | Same. The session and the relay link survive; only egress is gone. | Open for the session, closed for the workload |
| Guest image registry | Pod image pulls | Cold starts get slower than the measured 2.69 s p50, which assumes the image is already on both nodes. | Cold provisioning fails; warm pool pods are unaffected. | Closed for cold starts |
| NTP | Every lease, staleness and lifetime deadline | A step over 5 s logs `clock_skew_detected` and is not corrected. Forward steps end sessions early; backward steps extend every deadline by the size of the step, bounded by `maxLifetimeSeconds`. | Deadlines disagree across guest, controller and Kubernetes; sessions end early or run long. | Open, and logged only |
| Refund webhook (`REFUND_WEBHOOK_URL`) | Sending real refunds | Ambiguous outcomes stay `REFUND_SENDING` and retry with the same idempotency key, indefinitely. | An empty URL disables the worker, so real refunds sit in `REFUND_PENDING` for a human. There is no implementation of this endpoint in this repository. | Closed (records the debt) |

## 3. SLIs and SLOs

Most of the 23 alert rules are thresholds over a signal that already exists, so
they double as SLI definitions. Where such a rule exists, the expression is used
here as the definition. Where no target exists, the target below is a proposal
and is marked as one. Nothing in this section has an error budget attached, and
no availability number has ever been computed from data.

| Signal | Definition (the rule that exists) | Target | Measured? |
| --- | --- | --- | --- |
| Create latency, server | `histogram_quantile(0.95, sandbox_session_create_duration_seconds_bucket{role="api"})` > 0.5 for 10m, `SandboxCreateP95High` | p95 < 500 ms | Yes, once: p50 127 ms, p95 286 ms warm on control 0.1.16; 292 to 354 ms server on 0.1.22 across two 50-sample runs ([performance-cluster.md](performance-cluster.md)) |
| Create latency, client | Not an alert. The SDK round trip, measured by the bench | Proposed: p95 < 1 s | Yes, once: p50 395 ms, p95 708 ms on 0.1.16; 548 to 595 ms client on 0.1.22 |
| Provisioning timeout rate | `sandbox_provision_failures_total{reason="provisioning_timeout"}` / `sandbox_sessions_created_total` > 1% for 10m, `SandboxProvisioningTimeoutRateHigh` | < 1% | No. Zero failures in the two runs that were done (25/25 and 60/60), which is not a rate |
| Provisioning queue wait | `histogram_quantile(0.95, sandbox_provisioning_wait_seconds_bucket)` > 5 s for 10m, `SandboxProvisioningQueueWaitP95High` | p95 < 5 s | Only on kind: 5.85 s p95 unlimited, 9.41 s with `MAX_CONCURRENT_PROVISIONING=4` at 25 creates ([admission-control.md](admission-control.md)) |
| Relay pending | `max(sandbox_relay_pending_requests{role="controller"}) > 0` for 5m, `SandboxRelayPendingRequests` | 0 | No. The rule cannot fire in the reference deployment: see below |
| Reconcile pass | `histogram_quantile(0.95, sandbox_reconcile_duration_seconds_bucket{role="controller"})` > 1 for 10m, `SandboxReconcileP95High` | p95 < 1 s | No. Never measured on the cluster, and the 0.1.16 numbers were taken while the controller still ran SQLite |
| Create conflicts | Any `409` on `POST /v1/sessions` for 10m, `SandboxReconciliationPending` | 0 sustained | Partly. The counter exists; the code is not broken out, so this mixes `reconciliation_pending`, `payment_in_progress`, `spec_mismatch`, `entitlement_missing` and non-retryable capacity conflicts |
| Operation latency | `sandbox_exec_duration_seconds`, exported but not alerted on | Proposed: p95 < 500 ms | Yes, once: p50 53 ms, p95 108 ms, p99 216 ms (n=50, existing session) |
| Ledger divergence | `max by (reason) (sandbox_ledger_divergence) > 0` for 1m, `SandboxLedgerDivergence` | 0, no tolerance | Never seen non-zero, because real settlement has never run. Freshness is one `LEDGER_AUDIT_INTERVAL_MS` (300 s default), so a page can lag the event by five minutes |
| Cleanup progress | `max by (phase) (sandbox_sessions_stale) >= 3` for 15m, `SandboxSessionsStale` | 0 | No |
| Warm pool health | `SandboxWarmPoolEmpty`, `...MissPressure`, `...SustainedMisses`, `...UnderTarget`, `...BudgetExhausted`, `...DrainThrash` | No sustained cold starts | No, and all six are inactive at the shipped default `WARM_POOL_SIZE=0` |
| Egress volume | `sum(increase(sandbox_egress_bytes_total{scope="global"}[1h]))` > 15 GiB, `SandboxEgressBytesNearCap` | 75% of the 20 GiB/h default | No |
| Egress refusals | `sum by (scope) (increase(sandbox_egress_limit_total[15m])) > 0`, `SandboxEgressLimitRejections` | 0 | No |
| Target health | `up{job="sandbox-control"} == 0` for 2m, `SandboxMetricsTargetDown` | 1 | Yes in the sense that the series exists; it has never fired in anger |
| Availability | None. There is no external prober and no success-ratio SLI for the public hostname | Proposed: 99.5% monthly on a synthetic create, 99.9% on `/healthz` through Cloudflare | No |

Two of those definitions do not work as written. `SandboxRelayPendingRequests`
and `SandboxBlastRadius` both select `role="controller"`, but
`sandbox_relay_pending_requests` and `sandbox_relay_sessions` are exported by
the relay process, which the scrape config labels `role: relay`
(`controller/src/relay/metrics.ts`,
`deploy/monitoring/contract/prometheus-scrape.yaml`).
In the reference deployment the relay is a separate StatefulSet, so both
expressions match no series and neither alert can fire. The dashboard queries
the same families without a role selector and does show them. Until that is
fixed, treat relay health as visible but unpaged.

Do not read the 0.1.16 latency figures as current. The same 50-sample method on
0.1.22 measured 292 to 354 ms server and 548 to 595 ms client, so the baseline
in [performance-cluster.md](performance-cluster.md) is a floor, not a promise,
and the regression is tracked in #116. There is no p99 for create: n=10 cold is
effectively a maximum and no run recorded a p99 at all.

## 4. Capacity and headroom

All of this comes from two rigs and they are not interchangeable. The cluster
numbers are from the live Talos deployment: 2 nodes, 8 vCPU and about 13 GiB
allocatable each, Kata with Cloud Hypervisor, Cilium, control 0.1.16, 2026-11-09
([performance-cluster.md](performance-cluster.md)). The burst numbers are from
the local kind rig, a 14 vCPU Docker VM with a warm pool of 8
([admission-control.md](admission-control.md)). A number below names its rig.

What is measured:

- **Create path serialisation is about 1.3 creates/s.** A 25-create burst on
  the cluster returned 25/25 ready with 0 failures in 19.0 s wall. Provisioning
  itself stayed at p50 257 ms and p95 833 ms; each client waited about 17.6 s.
  The queue, not the VM boot, is the bottleneck.
- **60 concurrent held sessions, 60/60, 0 failures**, paced at 1.2 s and held
  for 8 s. That run was not pushed further. The doc reasons from requests at
  25% of limits that the admission bound is about 120 for that spec.
- **Warm start** is 127 ms p50 and 286 ms p95 server-side, 395 ms and 708 ms
  client-side, n=50, pool 20. **Cold start** is 2.69 s p50 and 3.33 s p95, n=10,
  with the image already on both nodes.
- **Idle memory** is 4.40 GiB across both nodes at pool 0 and 8.03 GiB at pool
  20, so about 182 MiB host-side per idle guest (VM and shim, not guest RSS).
- **Destroy** is 181 ms p50, 253 ms p95, 260 ms p99, n=30.

What is configured:

- `GLOBAL_CONCURRENT_SESSIONS=200`, `PAYER_CONCURRENT_SESSIONS=4`,
  `GLOBAL_CREATES_PER_WINDOW=2000` per one-hour window,
  `PAYER_CREATES_PER_WINDOW=60` (`deploy/kubernetes/03-config.yaml`).
- `WARM_POOL_SIZE=0` in the shipped config, so the warm pool is off by default
  and the six warm-pool alerts are inactive.
- `MAX_CONCURRENT_PROVISIONING=0`, which means unlimited.
- `WARM_POOL_TIER=short`, and the short tier is 0.5 vCPU and 512 MiB
  ([resource-model.md](resource-model.md)).

The gap between configured and demonstrated:

| Dimension | Configured | Demonstrated | Gap |
| --- | ---: | ---: | --- |
| Global concurrent sessions | 200 | 60 | The cap is 3.3x the largest tested figure. Nothing has run above 60 |
| Global creates per hour | 2 000 | about 4 680 (1.3/s) | The durable budget binds first, about 2.3x tighter than the measured path. That is a deliberate ceiling, not a capacity estimate |
| Warm pool | 0 by default, 20 measured | 20 (latency run), 8 (bursts) | No burst was run at pool 20, and the pool the alerts watch is off in the reference config |
| Provisioning concurrency | unlimited | 4 vs unlimited at a 50-create burst | Untuned. Unlimited gave 18.92 s p50; 4 gave 11.69 s p50 on kind |
| Controller replicas | 1 | takeover 0.25 s on release, 10.10 s on a stale lease | Both measured with SQLite, not the deployed Postgres path (ADR 0010) |
| Postgres | 1 primary, no replica | no failover measured | Failover time is unknown. The estimate for a volume detach and reattach is 30 s to 2 min, and that is an estimate, not a measurement |

The memory arithmetic does not support the configured cap. A short-tier pod is
512 MiB of limit plus the RuntimeClass overhead of 130Mi, so 642 MiB per pod.
Two hundred of those is 125.4 GiB. The fleet has about 26 GiB allocatable
across both nodes. The 200 cap is therefore about 4.8x what the memory allows
at the short tier; it is a policy bound that the scheduler and the capacity
preflight, not the budget, will refuse first. Even the 20-pod warm pool is
12.54 GiB of static limit if it all lands on one node, which is 96% of a 13 GiB
node. The measured idle delta is much smaller (182 MiB per guest), so the pool
fits in practice, but a pool that idles at 182 MiB and bursts to 642 MiB does
not leave 20 sessions of headroom on the same node.

Read that as: the concurrency number to plan against is the measured 60 plus
the admission estimate of about 120, not the configured 200, and the memory
ceiling is lower than both.

## 5. Monitoring and paging

What is scraped: one job, `sandbox-control`, every 15 s with a 10 s timeout, on
a private `METRICS_PORT` of 9100 that is never the service listener. Four
targets carry the role label: API, controller, both relay shards by stable pod
name, and the egress proxy by pod name
(`deploy/monitoring/contract/prometheus-scrape.yaml`). The
`allow-metrics-scrape` NetworkPolicy admits only the `monitoring` or
`observability` namespace on 9100.
Cardinality is bounded by the application: routes are Express templates and
failure reasons are closed enums, and no label carries a session id or a wallet
address.

What evaluates: 23 rules in
`deploy/monitoring/contract/rules/sandbox-slo.yaml`, listed with their `for:`
windows in `deploy/monitoring/README.md`. Three are critical
(`SandboxMetricsTargetDown`, `SandboxBlastRadius`, `SandboxLedgerDivergence`)
and the other twenty are warnings. The
runnable stack is VictoriaMetrics single-node, vmalert and Grafana, 14-day
retention, in the private deployment repository under
`apps/sandbox-monitoring/`.
There is no Alertmanager, no node-exporter and no kube-state-metrics.

Where it goes: nowhere. The rule file carries no receiver, the stack evaluates
with `-notifier.blackhole`, and the only visible effect of a firing rule is an
`ALERTS{alertstate="firing"}` series and the row it produces in the dashboard's
"Firing SLO alerts" table. Nothing pages. Until the rules and that panel
existed, an operator could not see the state at all without querying the store
by hand; now the state is visible to someone who is already looking at the
dashboard. That is the whole change. No alert has been delivered to a person,
and the path vmalert, to a receiver, to a phone has not been exercised end to
end. This is why the gate still records "Alerts reach a human" as FAIL, and why
"one alert delivered to a person" is an exit criterion rather than a task.

Two rules that will never fire in the reference deployment are covered in
section 3. Four families that a real incident needs are not implemented at all:
settlement failures as their own signal, PVC or disk full, orphan pods and PVCs,
and database health beyond the scrape target being up. The runbooks for egress
abuse and orphan storage therefore start from log lines and a manual comparison,
not from an alert ([production-readiness.md](production-readiness.md) §3).

## 6. Failure modes and mitigations

The realistic ones, what actually happens, and what is left over. "Refunded"
means the ledger policy in [payment-ledger.md](payment-ledger.md) applies.

| Failure | What happens | Mitigation in place | Residual |
| --- | --- | --- | --- |
| Relay restart | Every guest on that shard loses its socket. The in-flight operation becomes `outcome_unknown` and is never replayed. The guest reconnects to the stable ClusterIP and re-sends `hello`; the next operation starts after it reports idle. | ADR 0012, epoch fence (ADR 0008), two shards so one restart is half the fleet, `RELAY_LOSS_GRACE_MS` 90 s | One interrupted operation per session, and up to 90 s or the rest of a short lease with no operations. A guest that cannot reconnect ends `relay_lost` and is refunded. In `RELAY_GUEST_ADDRESS=pod` mode the session is lost and refunded. The egress proxy URL is still a pod IP, so a proxy replacement breaks egress for the rest of the session |
| Controller crash mid-settlement | The intent is `claimed` and the money may have moved. On the client's next attempt the API retries the same payment key, finds the claim, asks the chain and then the facilitator lookup, and completes the entitlement without charging again. | Outbox, claim fencing (ADR 0011), on-chain transfer proof (F-17), `SETTLEMENT_RECOVERY_GRACE_MS` 5 min | The controller's own recovery worker only uses the facilitator lookup, never the chain (F-19). With a facilitator that has no lookup endpoint, the row is written only if the client retries, so an absent client leaves a settled payment recorded nowhere |
| Postgres loss | The controller loses its writer, reports not-ready and leaves the Service endpoints. Creates answer `503 admission_unavailable`. Running guests keep executing until their lease and their own watchdog end them, but nothing can extend, terminate or refund them. | Postgres is the only store, readiness checks a real write probe, backups are daily | One primary on one `ReadWriteOnce` volume pinned to the control-plane node. Recovery waits for a reschedule and a volume reattach, estimated at 30 s to 2 min and never measured. No PITR, so the RPO is up to 24 h |
| Node loss | Sandbox pods on that node die with their sessions. A suspendable workspace is on a node-pinned local-path PVC, so resume fails fast with `409 resume_unavailable` rather than hanging. A control-plane node loss takes the API, controller, Postgres, cloudflared and the relay shards with it. | Warm pool absorbs a short gap while it lasts; cancellation of the pod is bounded by the kubelet | No session survives its node. There is no drain procedure for the sandbox node and no PodDisruptionBudget, so a drain is an outage for every session on it. Checkpoints cannot move nodes at all |
| Facilitator outage | `verify` fails, or `settle` returns an ambiguous answer. A plain refusal fails the intent and releases the capacity hold; a timeout or `settlement_pending` leaves it `claimed`. | `FACILITATOR_TIMEOUT_MS` 20 s, bounded retries on `verify` only, idempotent settle by nonce | Creates fail closed while the outage lasts. Ambiguous settlements need the chain check or a lookup to resolve; without either they sit claimed until the API's retry path or a human |
| Chain RPC outage | The settlement proof cannot be read. A `not-found` is deliberately `unavailable`, not `unsettled`, so entitlement is withheld and the intent stays claimed. | The scan is bounded (90 000 blocks, 10 000 per call, 12 calls) and the verdict is read from raw log topics | Recovery is delayed until the RPC is back. If the RPC and the facilitator lookup are both unavailable, the API answers `409 reconciliation_pending` and a human has to reconcile on chain |
| Egress abuse | A session uses the proxy as an exit node, scans, or moves a large file. The byte budget destroys the tunnel mid-stream rather than throttling it. | 16 tunnels per session, 512 global, 1 GiB per session, 20 GiB per hour global, private and metadata ranges denied, `CONNECT` on 443 only | The hostname allowlist (`EGRESS_ALLOWED_HOST_SUFFIXES`) ships disabled, so there is no control on where a session goes, only how much. Detection is a metric on the process total; no metric carries a session id, so naming the tenant is a log question |
| Disk full | A full Postgres volume fails writes, which fails readiness and turns creates into `503`. A full node evicts pods under disk pressure, which kills sessions in the same way a node loss does. A full workspace PVC fails the workload inside that one session. | Kubernetes eviction and the PVC request bound the blast radius | No disk or PVC alert exists. A full database volume is discovered by failing creates. There is no capacity headroom number to page on |
| Certificate expiry | The API to controller hop (3004, `CN=api`) and the controller to relay hop (8444, `CN=controller`) both fail. The controller reports not-ready; a cluster relay refuses to start without `RELAY_TLS_*`. | Startup refuses the unsafe configuration rather than falling back to plaintext; rotation is a runbook with an overlap window | No expiry monitoring and no cert metric. The CA and private key custody live in the infrastructure repository, so an expiry is found when a handshake fails, not before. [runbooks/secret-rotation.md](runbooks/secret-rotation.md) covers rotation, not expiry |

## 7. Rollback and drain

A rollback is an image change, and each component has a different effect on the
sessions that are live when it happens.

| Rolled back | Effect on live sessions | Effect on new work |
| --- | --- | --- |
| API | None. It holds no durable state and the guest never talks to it. Clients that are mid-request get a connection reset. | Creates fail for the length of the rollout. Nothing else. |
| Controller | It is `Recreate`, so the writer stops before the new pod starts. Sessions survive in Postgres and the relay; nothing is reconciled, enforced or refunded for the duration of the rollout. Leases are still enforced in the guest and by `activeDeadlineSeconds`. | Creates stall in `PAID` until the reconcile loop runs again. |
| Relay | Every registration is in memory, so the new pod starts empty. Guests reconnect, each loses the operation in flight, and a guest that cannot reconnect inside 90 s is ended `relay_lost` and refunded. | Recoverable, same as a restart. |
| Postgres image or schema | A rollback to an older build against a newer schema is refused: `migratePostgres` throws `refusing to downgrade` and the controller does not start. There is no down migration. | Blocked until the newer build is restored or the dump is restored into a fresh database. |

Two things a rollback does that are easy to miss. A capability minted by the
newer build stops verifying under the older one, because the derivation is
versioned (F-08), so a rollback silently 401s clients holding a live capability
until their session ends. And the ledger is additive, so a rollback does not
lose settled rows; the `source` column defaults to `x402` for anything written
by an older build.

There is no kill switch. The emergency stop is scaling the API to zero, and
that stops reads as well as writes: `GET /v1/sessions/{id}`, `exec` and
`DELETE` all go through the API, so a client cannot poll, run anything or
destroy its session. A guest that is already running keeps executing until its
lease ends, so the API going away does not itself interrupt anyone. The refunds
start if you also stop the controller or delete pods, because a session that
never reaches READY is a refund under the ledger policy and a session that does
is not. `launch.md` tells you to expect refunds from this stop; budget for them
and reconcile by hand, because nothing here will do it for you. This is why the
gate lists "Emergency stop" as FAIL, and a durable flag that refuses creates
without touching live leases is a change, not a runbook step
([launch.md](launch.md) "Rollback").

Draining a node is the same problem one level down. There is no drain
procedure, no PodDisruptionBudget and no eviction ordering, so `kubectl drain`
on the sandbox node deletes every sandbox pod on it. Those sessions are gone,
and a suspendable session's workspace is on a node-pinned volume, so it cannot
resume elsewhere. Drain the sandbox node only when you have decided to end the
sessions on it.

## 8. Data protection

The ledger and the checkpoints are two separate data stores with two separate
answers. Do not merge them into one RPO.

**The ledger and control-plane database.** The whole database is backed up:
payments, `payment_ledger`, `payment_intents`, sessions, operations and
`challenge_nonces` ([backup-restore.md](backup-restore.md)). The reference
deployment runs a nightly `pg_dump` CronJob, encrypted with the cluster backup
key, verified by restoring it into a scratch database, and keeps seven days.
There is no WAL archiving and no PITR, and the dump sits on a PVC on the same
node as the primary.

| Property | Value | Status |
| --- | --- | --- |
| RPO | Up to 24 hours. A day of settled payments can be lost with the node | The schedule is daily; the loss window has never been exercised |
| RTO | Unknown. No drill has run against production data (#162) | Not measured |
| Restore verification | `make test-restore-dump` restores, fingerprints every money and session table, then runs the store contract against the copy | Exists and is unit-tested; it is not in CI (no runner holds the PVC or the key) and the quarterly drill has not been recorded |
| Off-node copy | None. The dump is on the same node as the primary | Not disaster recovery |
| PITR | None | Not implemented |

A restore brings back the session record, not the session. Running pods are not
restored, and the API will not know about a session that was created after the
dump. The operator endpoint `GET /internal/payments` is the way to see what the
ledger thinks happened after a restore.

**Checkpoints.** A suspendable session's `/workspace` is a per-session PVC on
`local-path`, and that PVC is the checkpoint. It is plaintext, it is node
pinned, and it is not in any backup.

| Property | Value | Status |
| --- | --- | --- |
| RPO | No recovery point exists. There is no backup, snapshot or replica, so the loss window is the whole life of the volume | Not measured, by design |
| RTO | Not applicable. Restore is impossible; resume returns `409 resume_unavailable` with `checkpoint_missing` | Not measured |
| Encryption at rest | None. The node and storage administrator can read it | Decided in [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) |
| Retention | Deleted on terminate, on suspended expiry (8 h default) and on max lifetime (8 h); an unowned PVC is reaped after `ORPHAN_PVC_GRACE_MS` (1 h) | Implemented, but only while the controller runs |
| Backup corpus | Excluded deliberately. Do not add it to a corpus that is not itself encrypted | Documented |

If the product sells suspendable sessions, say both of those out loud: a
suspended workspace survives a controller restart, and it does not survive the
node. Deleting a PVC or corrupting it makes the session unrecoverable, and no
support action brings it back.

## 9. Security posture

Short version: the control plane never sees plaintext, Cilium isolation is
packet-tested on every pull request, and the VM boundary has never been run on
KVM hardware. That is the whole shape of the risk. Read
[security-review/RELEASE_GATE.md](../security-review/RELEASE_GATE.md) for the
per-control evidence and
[security-review/FINDINGS.md](../security-review/FINDINGS.md) for the findings;
neither is repeated here.

The accepted risks, listed once so they are not rediscovered one at a time:

- **A complete captured create request, replayed before the legitimate one, is
  equivalent to the client** (F-07 residual). The challenge nonce stops it being
  a permanent replay; it does not stop a race.
- **A capability is a bearer token for its TTL.** There is no per-request proof
  of possession, and for a suspendable session the TTL runs to
  `maxLifetimeSeconds`.
- **Capabilities minted before an upgrade stop verifying after it** (F-08), and
  the same is true in reverse on a rollback.
- **The payer rate-limit key comes from the unverified `from` field** (F-09).
  Only the per-IP bucket bounds key rotation.
- **The runtime-class guard only runs when `EXECUTION_MODE=kata`** (F-18). A
  dev-mode cluster skips it, and the signal is the `executionMode` field in the
  evidence.
- **An allowlisted wallet is a free tier on the public create path** (F-20).
  The key is long-lived on a host running model-written code; the entry's
  `max_tier` and `max_concurrent` are the bound, and disabling the row is the
  response.
- **Checkpoints are plaintext and readable by the node administrator** (ADR
  0007). No at-rest encryption is claimed anywhere.
- **There is no hardware root of trust.** Dev attestation is signed by a
  published key, and a malicious operator could run a different guest.
- **Kata guest to host isolation is unverified** (#44). Cilium isolation is not.
- **Key custody is a Kubernetes Secret.** Rotation by key id is implemented;
  there is no KMS or HSM.
- **The egress hostname allowlist is off**, so a session can reach any public
  host on 443 within its byte budget.
- **`TRUST_PROXY_HOPS=1` is only safe while cloudflared is the single hop.**
  Add a proxy without raising it and the per-IP buckets collapse into one; raise
  it without a proxy you control and `X-Forwarded-For` is forgeable.
- **CodeQL `go/request-forgery` (F-13) and `js/resource-exhaustion` (F-14) are
  bounded residuals** under the deployment assumption, not clean results.

## 10. Launch checklist

The same order as [launch.md](launch.md), written from the operator's side: what
you do, and the evidence that proves it happened. A step is done when its
evidence exists, not when the command exits zero.

| # | Step | Evidence required |
| --- | --- | --- |
| 0 | Preconditions: a KVM-capable host, a CDP key pair, a funded Base wallet, the `throwbox.dev` registration, the addresses to allowlist | The domain resolves in RDAP (it currently returns 404), the wallet holds enough USDC for one `short` session, and the CDP key can mint a JWT |
| 1 | Isolation evidence on real hardware: Talos with the `kata-containers` extension, the node labelled `x402.io/sandbox-pool=true`, a runner labelled `sandbox-isolation`, a tag cut from clean `main` | The `isolation` job is green, the release body has no "suites were not run" banner, and `tested-images.json` names the same control and guest digests that `promote` tagged. Without all three, the gate did not run |
| 2 | One real settle and one real refund on mainnet-equivalent settings | A `settled` ledger row with `source=x402` and an amount that matches the price table, its transaction hash, then a forced provisioning failure that produces `REFUND_PENDING` and a `REFUNDED` row with the provider's transaction. Both transactions visible on chain |
| 3 | The tunnel, applied before the controller is rolled | `curl /healthz` returns 200 through the public host, `/v1/pricing` lists the tiers, and `X-Forwarded-For` is absent from the edge response. `TRUST_PROXY_HOPS=1` is only correct while cloudflared is the only hop |
| 4 | The site last, after everything above is true | The published copy still says real USDC on Base, one region, one control-plane node and unverified isolation, and `llms.txt` points at the hosted API rather than `localhost:8080` |
| 5 | Free access, if it is being enabled | `sandbox admin allowlist list` shows the entries, one create moves `sandbox_sessions_total{source="allowlist"}` by exactly one, and the paid path is unchanged for a wallet that is not listed |
| 6 | Paging, before any paid traffic | One alert delivered to a person through the configured receiver, and the runbook step it triggered written down. This step is not in `launch.md`; it is the gate's exit criterion, and it is the operator's precondition rather than an engineering task |
| 7 | A kill-switch decision recorded | Either a durable flag that refuses creates while live leases continue, demonstrated with a `503` on create and a running `exec`, or a written decision that scaling the API to zero is the accepted stop and that interrupted leases will be refunded by hand |

Steps 1, 2 and 6 are the three that block the paid public beta. Steps 3 to 5
are reversible; steps 1 and 2 are not, because they are evidence about hardware
and money rather than configuration.

## 11. Known gaps with owners

The repository has one maintainer, so the owner column names the role that has
to act rather than a person. "Maintainer, infra" means the fix lands in the
deployment or infrastructure repository, not here. "Blocks" means it blocks a
paid public beta: anonymous internet users, real settlement, money moving
automatically. A gap that does not block still has an operator consequence,
which is what the impact column is for.

| Gap | Impact | Owner | Blocks | Reference |
| --- | --- | --- | --- | --- |
| Kata guest to host isolation has never run on KVM hardware | The isolation claim rests on unit tests and construction. A beta running hostile code cannot make it | Maintainer, infra | Yes | #44, [RELEASE_GATE.md](../security-review/RELEASE_GATE.md) |
| No real settle and no real refund has executed | The refund worker and the webhook contract are mock-tested only. Copy that says money moves is untested | Maintainer | Yes | #31, [payment-ledger.md](payment-ledger.md) |
| No alert is delivered to a person | A payment incident is found by a customer. Two relay rules cannot fire at all (section 3) | Maintainer, infra | Yes | Gate FAIL, #38 for the rules |
| Incident procedures have never been rehearsed | Four runbooks and a tabletop script exist; detection leans on log lines because the matching alerts are missing | Maintainer, on call | Yes | #60, [runbooks/tabletop.md](runbooks/tabletop.md) |
| No kill switch | The only stop is scaling the API to zero, which also stops reads for live sessions | Maintainer | Yes | [launch.md](launch.md) "Rollback" |
| Ledger RPO is up to 24 h, with no PITR and no production restore drill | A node loss can drop a day of settled payments. RTO is unknown | Maintainer, infra | Yes, unless the loss window is accepted in writing | #162, [backup-restore.md](backup-restore.md) |
| Controller-side settlement recovery uses the facilitator lookup only | A settled-but-unentitled payment is recorded only if the client retries | Maintainer | Yes for unattended money | F-19, [FINDINGS.md](../security-review/FINDINGS.md) |
| Relay state is in process memory | A restart costs one interrupted operation per session and up to 90 s of no operations | Maintainer | No | #24, [ADR 0012](adr/0012-guest-reconnects-after-relay-loss.md) |
| Checkpoints are plaintext and node pinned | A node loss makes a suspended session unrecoverable, and the node admin can read it | Maintainer | No for a lease product; yes if suspend and resume are sold as durable | #32, [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) |
| No database failover has been measured on the Postgres path | Recovery time is an estimate of 30 s to 2 min for a volume reattach | Maintainer, infra | No, but the outage budget is unknown | [ADR 0010](adr/0010-controller-ha-storage.md) |
| No PVC-full, orphan-object, settlement-failure or database alert | Disk exhaustion and orphan storage are found by failing creates or by a manual comparison | Maintainer | No | [production-readiness.md](production-readiness.md) §3 |
| Rate limiting is per replica in memory | A second API replica would each allow a full burst; the durable budget still caps the aggregate | Maintainer | No | [production-readiness.md](production-readiness.md) §2 |
| Egress hostname allowlist is disabled | A session can reach any public host on 443 within 1 GiB and 16 tunnels | Maintainer | No | [runbooks/egress-abuse.md](runbooks/egress-abuse.md) |
| Suspend and resume are free in the mock model and unpriced | A production price has to decide active time, resumes or storage before charging for them | Maintainer | No, while payments are mock | [lifecycle.md](lifecycle.md), #117 |
| Create latency regressed after 0.1.16 | 0.1.22 measured 292 to 354 ms server against 127 ms on 0.1.16, so the quoted baseline is stale | Maintainer | No | #116, [performance-cluster.md](performance-cluster.md) |

One row is known to lag its code. The F-19 row follows the gate and FINDINGS at
the revision in the header, and a fix that proves settlement in the controller
landed on `main` after that revision (ADR 0014). Check FINDINGS before treating
the row as current fact; if the gate has caught up, delete the row.

## What to do with this document

At 2am, read section 6 for the failure in front of you, then section 7 before
touching a deployment, then section 8 before promising anyone their data is
safe. Section 5 tells you why nobody was paged, and section 11 tells you whether
the thing that broke was already known. If the answer you need is not in one of
those, the honest answer is that it has not been measured, and the gap list is
where that belongs.
