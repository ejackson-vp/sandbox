# Roadmap

Ordered by risk and by what unlocks the next step, not by novelty. The detailed,
file-level backlog is in issues; this page keeps the order. The gap analysis is
[`docs/production-readiness.md`](docs/production-readiness.md).

## Next

The issue tracker is the detailed, file-level backlog. This list keeps the order
of risk.

**Current gate: production-ready core (#117).** It closes the store, relay,
checkpoint, settlement, admission and latency gaps.

1. **Keep the trust baseline current.** Operation and payment-intent fencing
   (#19/#20), the relay restart window (#17), the Kubernetes digest guard (#4),
   readiness checks (#50) and the nightly model run (#73) are merged. 0.1.21
   adds the relay-replacement, recovery-fence and resume-accounting fixes. The
   kind fault matrix is 8/8 and the cluster security suite runs clean; keep the
   live lifecycle/fault case and one real alert in each release checklist.
2. **Push readiness instead of polling.** #27 folded the post-create view into
   the completion response. #26 removes the remaining readiness poll tick.
   Measure the 0.1.20 warm p95 regression in #116 first; do not trade
   correctness checks for latency.
3. **Postgres is the only store.** Done: the SQLite adapter and its backup path
   are deleted, `DATABASE_URL` is required for the controller, the manifests run
   a Postgres StatefulSet, and the CI unit suite runs against Postgres. The
   remaining work is the HA proof (failover without a volume detach) and an
   external backup/restore drill (CloudNativePG or pgBackRest), tracked in #162.
4. **Relay state out of process.** One in-memory relay pod loses pending
   ciphertext on restart. Redis or NATS with per-session queues and TTLs,
   ciphertext only. (#24)
5. **One-shot run and a runtime catalog.** Shipped: `run()` is a client
   composition, and the public `runtime` noun is `base`, `python` or `node`,
   published from `guest/profiles/runtime-images.conf` by
   `release-profiles.yml`. Arbitrary OCI images are not part of this step.

## Cross-cutting

- **Observability:** the scrape contract (#37) and the SLO alert set (#38) are
  shipped; propagating `requestId` across API, controller and relay is #28.
- **Verification:** the cluster fault matrix (#39), the state-machine model and
  its nightly run (#40, #73), epoch fencing in the model (#75) and protocol
  fuzzing (#41) are shipped. Release isolation evidence is #44.

## Later

- **Encrypted checkpoint storage.** Checkpoint PVCs are plaintext today, which
  puts suspended session files in the node and storage trust domain. (#32)
- **Rehearse the incident runbooks.** Egress abuse, orphan Pod/PVC cleanup, relay
  compromise and secret rotation each have a runbook under `docs/runbooks/`, and
  none has been walked through against a live failure; the
  [tabletop script](docs/runbooks/tabletop.md) has never been run. (#60)
- **Docs site.** Only if it can be generated from `docs/` without becoming a
  second source of truth.

## Closed as not planned

Decided against on 2026-11-11: memory snapshot and restore (#52, #53), HTTP/2
and gRPC workloads (#55) and publishing `@x402s/sdk` to npm (#33). Each stays
listed as a limitation in `README.md` and `docs/`. The elastic warm pool (#54)
closed with them, but its useful half shipped: the pool sizes from observed
misses inside a fixed budget (`docs/warm-pool.md`), and only the predictive
autoscaler was dropped.

## Out of scope

Hardware attestation requires TEE hardware and an independent verifier; it is not
something this repository can honestly claim. Mainnet payments, accounts, managed
wallets, a hosted commercial service, feature parity with general-purpose sandbox
platforms, and application-specific integrations are deliberate non-goals — see
the README. Prepared runtimes and stateful sessions are in scope; a full IDE or
dev-platform is not.

## How items leave this list

Work lands as a PR with tests; close the issue and remove the item here and from
`production-readiness.md` in the same change. A roadmap entry that silently
disappears is worse than one that stays.
