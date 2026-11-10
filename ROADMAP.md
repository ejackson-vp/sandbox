# Roadmap

Ordered by risk and by what unlocks the next step, not by novelty. The detailed,
file-level backlog is in issues; this page keeps the order. The gap analysis is
[`docs/production-readiness.md`](docs/production-readiness.md).

## Next

The issue tracker is the detailed, file-level backlog. This list keeps the order
of risk.

**Current gate: production-ready core (#117).** It closes the store, relay,
checkpoint, settlement, admission and latency gaps before Stage 2. The runtime
catalog does not start until that gate is met.

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
3. **Move the store behind an adapter tested against a second backend.**
   SQLite is the single writer and therefore the HA ceiling. Postgres or
   DynamoDB with conditional writes, preserving the unique payment key and
   guarded transitions. (#25)
4. **Relay state out of process.** One in-memory relay pod loses pending
   ciphertext on restart. Redis or NATS with per-session queues and TTLs,
   ciphertext only. (#24)
5. **One-shot run and a runtime catalog.** Stage 1 shipped: `run()` is a client
   composition and the public `runtime` noun is frozen to `base`. Stage 2 adds
   one common base image plus system-defined runtime profiles, selected at warm
   claim so the base image and warm pool stay shared. Arbitrary OCI images are
   not part of this step; start only after #117.

## Cross-cutting

- **Observability:** a scrape-ready contract on a private port (#37) and a
  lightweight metrics/alerting stack (#38). Log correlation is #28.
- **Verification:** the cluster fault matrix (#39), the lifecycle and payment
  state machines (#40), nightly model checks (#73) and protocol fuzzing (#41).
  The model must also cover the epoch fence (#75). Release isolation evidence
  is #44.

## Later

- **Memory snapshot and restore.** Suspend/resume is disk-only today, and a
  restored snapshot must reseed identity, entropy and network state. (#52, #53)
- **Encrypted checkpoint storage.** Checkpoint PVCs are plaintext today, which
  puts suspended session files in the node and storage trust domain. (#32)
- **Real settlement reconciliation and refunds.** Mock mode auto-refunds
  terminal-before-`READY` sessions. Testnet/mainnet need facilitator webhooks or
  an on-chain refund worker before money is real. (#31)
- **Admission control for images.** Digest pinning exists; Kyverno or sigstore
  policy would make a moved tag or a compromised node a second, independent
  failure rather than the only one. (#30)
- **HTTP/2 and gRPC workloads.** The guest supports HTTP/1.1, SSE and a polled
  WebSocket; gRPC and HTTP/2 are not available today. (#55)
- **Elastic warm pool.** Scale the pool from in-flight demand instead of a fixed
  size, with a min/max, rate cap and scale-to-zero grace. (#54)
- **Publish `@x402s/sdk` to npm.** The package is a workspace build today; a
  public release makes the SDK usable without cloning the repo. (#33)
- **Secret rotation.** Add key ids and dual-key verification so capabilities and
  controller tokens can rotate without draining live sessions. (#61)
- **Incident runbooks.** Egress abuse, orphan storage and relay compromise need
  detect/contain/recover procedures, not just alerts. (#60)
- **Docs site.** Only if it can be generated from `docs/` without becoming a
  second source of truth.

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
