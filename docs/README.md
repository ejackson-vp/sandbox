# Documentation

Start here:

- [quickstart.md](quickstart.md) — public SDK, first paid session
- [architecture.md](architecture.md) — components and the request path
- [architecture-principles.md](architecture-principles.md) — invariants we build against
- [api.md](api.md) — HTTP API reference
- [cli.md](cli.md) — `sandbox` CLI
- [http.md](http.md) — HTTP/SSE/WebSocket workloads

## Sessions

- [sessions.md](sessions.md) — lifecycle and state machine
- [lifecycle.md](lifecycle.md) — checkpoint, suspend, resume
- [resource-model.md](resource-model.md) — tiers, limits, process/file/output caps
- [warm-pool.md](warm-pool.md) — pre-booted guests and the claim path
- [capacity-model.md](capacity-model.md) — baseline vs peak accounting
- [reservation-lifecycle.md](reservation-lifecycle.md) — holds, release, faults
- [workload-compatibility.md](workload-compatibility.md) — what runs in the guest

## Payments

- [payment-ledger.md](payment-ledger.md) — intents, settlement, refunds
- [cost-model.md](cost-model.md) — pricing arithmetic
- [admission-control.md](admission-control.md) — rate limits and capacity gates

## Security

- [security-guarantees.md](security-guarantees.md) — what is and is not guaranteed
- [threat-model.md](threat-model.md) — STRIDE by component
- [networking.md](networking.md) — Cilium policies, relay and proxy paths
- [transfer-security.md](transfer-security.md) — transfer protocol threat model
- [transfer-protocol.md](transfer-protocol.md) — wire format

## Operations and measurement

- [production-readiness.md](production-readiness.md) — known gaps, ordered
- [control-plane-faults.md](control-plane-faults.md) — failure injection
- [benchmark-methodology.md](benchmark-methodology.md) — how measurements are taken
- [performance-cluster.md](performance-cluster.md) — live two-node Kata numbers
- [performance-report.md](performance-report.md) — the kind/dev baseline
- [transfer-performance.md](transfer-performance.md) — transfer benchmarks
