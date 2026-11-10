# Engineering notes

Measurements and dead ends that do not fit in a reference doc. Numbers come from
the run data in [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench); the
method is in [benchmark-methodology.md](benchmark-methodology.md).

## The create path is the product, not the VM boot

The headline warm number — 127 ms server-side ready (p50) — is claim and
readiness of a running VM, not microVM boot. That distinction matters when
comparing against providers that quote cold boot: the honest comparison here is
the 2.69 s cold figure, and even that assumes the image is already on the node.

What the numbers do show is that the interesting cost is elsewhere. Warm client
ready is 395 ms against 127 ms server-side. Roughly 268 ms happens before the
client can use the VM: the paid create request and payment (~175 ms) plus
readiness polling and network. 0.1.16 removed the 402 challenge round trip from
repeat creates and one redundant capacity call; the VM is not the problem.

That gap is the product target. A user does not care that the pod was ready in
127 ms if they waited nearly 400 ms to run a command.

A 0.1.20 spot check landed at 287 ms server and 522 ms client (n = 50), with 70
of 71 creates hitting the warm pool. 0.1.22 removed the two relay probes that
looked like the cause, and the number barely moved: across two 50-sample runs,
292-354 ms server and 548-595 ms client. Per-session timings point elsewhere. On
a warm claim, the pick costs 13-169 ms (a Kubernetes list), registration 26-92 ms
(three fresh mTLS calls), the claim 9-68 ms, relabelling 17-65 ms (a Kubernetes
patch), and the guest takes 50-360 ms to reconnect and re-attest as the claimed
session. READY detection after the hello is 10-44 ms. The probes were not the
cost.

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
127 ms claim, and the reason pool size is a config knob rather than a default.

## Three experiments, in order

1. **Cut the paid create path.** Payment verify/settle is ~20 ms; the rest of the
   ~175 ms create is the paid request and the controller entitlement round trips.
   The post-create `getSession` is now folded into the completion response
   (0.1.20): the API no longer makes a separate `GET /internal/sessions/:id`
   after a successful completion, and the SDK builds its handle from the
   embedded view instead of issuing an immediate status request. The wire change
   is additive, so older clients and older controllers still work. This has not
   been re-run on the cluster; it is a described round-trip removal, not a
   p95 claim backed by measurement.
2. **Push readiness instead of polling.** Polling and network are ~90 ms of the
   remaining gap. A pushed `READY` event or long-poll removes the tick, but it is
   smaller than the create path now.
3. **Audit the claim path.** Pick/relabel is ~50 ms at p50 with a p95 tail. The
   reconciler tick is a candidate for an event-driven wakeup, at the cost of more
   moving parts.

Done in 0.1.16: the 402 challenge is cached per session spec, and the paid path
makes one capacity decision instead of two. It moved client p50 665 → 395 ms and
server p50 179 → 127 ms.

The provisional targets are met (server 100–150, client 400–500); the next pass
is p95 (286 / 708 ms). No correctness check gets removed for latency.

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
