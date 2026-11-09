# Engineering notes

Measurements and dead ends that do not fit in a reference doc. Numbers come from
`benchmarks/results/`; the method is in
[benchmark-methodology.md](benchmark-methodology.md).

## The create path is the product, not the VM boot

The headline warm number — 179 ms server-side ready (p50) — is claim and
readiness of a running VM, not microVM boot. That distinction matters when
comparing against providers that quote cold boot: the honest comparison here is
the 2.69 s cold figure, and even that assumes the image is already on the node.

What the numbers do show is that the interesting cost is elsewhere. Warm client
ready is 665 ms against 179 ms server-side. Roughly 486 ms happens in the client
path: payment, the 402 challenge round trip, SDK readiness polling at 250 ms, and
network. The VM is not the problem.

That gap is the product target. A user does not care that the pod was ready in
179 ms if they waited two-thirds of a second to run a command.

## Burst traffic queues; it does not thrash

25 simultaneous creates completed 25/25 with zero failures in 19.0 s. Server-side
provisioning stayed flat — p50 257 ms, p95 833 ms — but each client waited about
17.6 s.

The create path serialises at **~1.3 creates/s**. The queue, not the hypervisor,
is the bottleneck: 25 creates at 1.3/s is 19 s, which matches the wall time
almost exactly. Adding nodes would not help while the queue is the constraint.

This is a good failure mode. Latency grows linearly and predictably, nothing
fails, and the pool absorbs the burst once creates drain. It is also a clear
signal about what to optimise next.

## Held sessions are admission-bound, not memory-bound

60 concurrent held sessions ran with zero failures at 8 s hold, paced at 1.2 s.
Requests were 25% of the configured limits, which puts the admission bound around
120 sessions for the two-node spec. It was not pushed further on purpose: running
that many at full CPU would oversubscribe the nodes and measure contention rather
than capacity.

Idle memory is about 182 MiB of host-side cost per guest (VM plus shim, not guest
RSS). A pool of 20 costs roughly 3.6 GiB across two nodes — the price of the
179 ms claim, and the reason pool size is a config knob rather than a default.

## Three experiments, in order

1. **Remove the readiness poll.** The SDK polls every 250 ms. A pushed `READY`
   event or a long-poll should cut most of the client-side gap. Cheapest change
   with the largest effect.
2. **Collapse the x402 round trip.** Preflight and pre-sign repeat creates so the
   402 challenge is not on the critical path. Payment remains verifiable; it just
   stops costing a full round trip.
3. **Audit the claim path.** The reconciler ticks at 250 ms. That tick is a
   candidate for an event-driven wakeup, at the cost of more moving parts.

Provisional targets: warm server p50 100–150 ms, warm client p50 400–500 ms,
holding the same p95 discipline. No correctness check gets removed for latency.

## What we deliberately did not optimise

- **Cold start with a registry pull.** Real, and slow, but it is a provisioning
  problem with a known answer (pre-pull, node affinity) rather than a design
  question.
- **Larger frames.** The relay caps frames at 24 MiB and rejects more. Raising the
  cap would improve large-transfer throughput and widen the blast radius of a
  single request; the transfer protocol exists so that trade does not have to be
  made.
- **The 650-line module limit.** It occasionally forces an awkward split. It also
  keeps review tractable, and every attempt to special-case it has been worse
  than the split.
