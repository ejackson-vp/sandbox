# Documentation

The [README](../README.md) is the pitch. This page is the map: pick a path, or
jump to the full index below.

## Choose a path

### "I have five minutes"

1. [quickstart.md](quickstart.md) — a paid session through the public SDK
2. [architecture.md](architecture.md) — components and the request path
3. [performance-cluster.md](performance-cluster.md) — the numbers, and what they
   do not mean

### "I am evaluating the security model"

- [security-guarantees.md](security-guarantees.md) — what is enforced, what is not
- [threat-model.md](threat-model.md) — STRIDE by component
- [networking.md](networking.md) — Cilium policies, relay and proxy paths
- [transfer-security.md](transfer-security.md) — transfer threat model
- [payment-ledger.md](payment-ledger.md) — intents, settlement, replay
- [admission-control.md](admission-control.md) — rate limits and capacity gates

### "I want to run it"

- [deploy/talos/README.md](../deploy/talos/README.md) — real cluster, Kata, Flux
- [control-plane-faults.md](control-plane-faults.md) — failure injection
- [backup-restore.md](backup-restore.md) — database backups, PITR and restore verification
- [capacity-model.md](capacity-model.md) — baseline vs peak accounting
- [warm-pool.md](warm-pool.md) — pre-booted guests and the claim path
- [production-readiness.md](production-readiness.md) — known gaps, ordered

### "Something is happening right now"

| Situation | Runbook |
| --- | --- |
| A session is abusing its egress | [runbooks/egress-abuse.md](runbooks/egress-abuse.md) |
| A Pod or PVC has no live session | [runbooks/orphan-storage.md](runbooks/orphan-storage.md) |
| The relay is suspect, or a guest token leaked | [runbooks/relay-compromise.md](runbooks/relay-compromise.md) |
| A capability, admin or mTLS key must be rotated | [runbooks/secret-rotation.md](runbooks/secret-rotation.md) |
| Rehearsing any of the above | [runbooks/tabletop.md](runbooks/tabletop.md) |

### "I want to change the code"

- [architecture-principles.md](architecture-principles.md) — the working rulebook
- [verification.md](verification.md) — bounded TLA+ model of lifecycle, payment, operations and capacity
- [release-process.md](release-process.md) — staged image release, scan gate and promotion
- [adr/](adr/) — why the load-bearing choices were made
- [workload-compatibility.md](workload-compatibility.md) — what runs in the guest
- [benchmark-methodology.md](benchmark-methodology.md) — how numbers are taken
- [CONTRIBUTING.md](../CONTRIBUTING.md) — build, test, review rules

### "I want to understand a specific mechanism"

| Topic | Document |
| --- | --- |
| Session lifecycle and state machine | [sessions.md](sessions.md) |
| Checkpoint, suspend, resume | [lifecycle.md](lifecycle.md) |
| Holds and reservations | [reservation-lifecycle.md](reservation-lifecycle.md) |
| Tiers, limits, process and output caps | [resource-model.md](resource-model.md) |
| HTTP, SSE and WebSocket workloads | [http.md](http.md) |
| Streaming transfer wire format | [transfer-protocol.md](transfer-protocol.md) |
| Pricing arithmetic | [cost-model.md](cost-model.md) |
| CLI and SDK surface | [cli.md](cli.md) |
| HTTP API reference | [api.md](api.md) |

### Measurement

- [engineering-notes.md](engineering-notes.md) — where the time goes, and why the
  create queue is the next target
- [performance-cluster.md](performance-cluster.md) — live two-node Kata numbers
- [performance-report.md](performance-report.md) — the kind/dev baseline
- [transfer-performance.md](transfer-performance.md) — transfer benchmarks
- [benchmark-methodology.md](benchmark-methodology.md) — method and caveats
- Measurement tooling and raw results: [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench)
