# Transfer pipelining feasibility probe

Status: measured on the local kind rig with the stock guest image. The probe
does **not** implement window>1; it measures the current window=1 cost and
reports what happens when chunk operations are issued concurrently.

Run:

```bash
make benchmark-pipeline-probe
```

Override `SIZE_MIB`, `CHUNKS`, `WINDOWS`, or `API_URL` as needed.

## Method

1. Upload a 32 MiB file with the public SDK at 512 KiB and 1 MiB chunks.
   Acknowledged-offset timestamps give steady-state per-chunk latency.
2. For each window in 1/2/4/8, initialise one upload transfer and launch that
   many `transfer.chunk` operations **before awaiting any of them**. Report
   accepted/busy/error outcomes and whether any accepted operations overlapped
   in time.
3. Fit `chunkMs = fixedMs + perKiBMs * KiB` from the two chunk sizes. Project
   window>1 as `fixedMs / window + perKiBMs * KiB`: fixed request/round-trip
   work can overlap, while per-byte work stays serialized at the guest lock and
   the single controller/relay event loops.

The projection is an upper bound for that overlap model, not a measured
pipelined implementation.

## Window=1 results

| Chunk | Upload | Mean chunk | p50 | p95 | Fixed/chunk | Per-byte ceiling | Projected window 8 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 512 KiB | 13.76–14.31 MiB/s | 34.4–35.8 ms | 26.6–28.1 ms | 63–78 ms | 10.4–16.0 ms | 20.2–24.1 MiB/s | 1.35–1.64× |
| 1 MiB | 16.06–17.85 MiB/s | 55.2–59.9 ms | 48.0–54.1 ms | 92–101 ms | 10.4–16.0 ms | 20.2–24.1 MiB/s | 1.18–1.33× |

Ranges cover three runs. The per-byte ceiling is the inverse of the fitted
per-KiB slope.

## Concurrent attempts

| Window | Accepted | Busy | Other | Accepted overlap |
|---:|---:|---:|---:|---|
| 1 | 1 | 0 | 0 | no |
| 2 | 1 | 1 | 0 | no |
| 4 | 1 | 3 | 0 | no |
| 8 | 0–2 | 5–6 | 1–3 (`out_of_order`) | no |

No run had two accepted chunks overlapping in time. In the one run with two
accepted chunks at window 8, the offsets were `0` and `524288` and their
intervals did not overlap: the gate was released after the first chunk and the
next request acquired it. The rest were rejected `session_busy` or, once the
gate moved, `out_of_order`.

This confirms the current serialization points:

- controller `claimOperation` allows one active request per session,
- guest supervisor has one operation slot,
- `transfer.chunk` requires the exact next offset.

## Interpretation

Pipelining only recovers the fixed per-chunk cost. At 1 MiB the measured
window=1 path already reaches ~80% of the fitted per-byte ceiling, so even an
ideal window of 8 projects only **1.18–1.33×**. At 512 KiB the projection is
larger (1.35–1.64×) but still lands near the same ~20–24 MiB/s ceiling.

The complexity is not small: controller operation admission, guest slot
management, an ordered out-of-order chunk buffer, SDK read-ahead, cancellation,
resume offsets and memory bounds all change together. That is hard to justify
for a ~1.2–1.3× gain at the default 1 MiB opt-in size.

## Recommendation

Do **not** implement window>1 now.

Better next levers, in order:

1. Keep 1 MiB chunks as the large-file opt-in; they already reach 16–18 MiB/s.
2. Reduce per-byte cost (base64/JSON framing, seal/open CPU, guest write path)
   before adding protocol concurrency.
3. If larger chunks are acceptable, evaluate 2 MiB chunks with a larger sealed
   envelope rather than a pipelined 1 MiB path.
4. Revisit pipelining if the fixed per-chunk cost grows (for example a remote
   relay RTT) or if the per-byte ceiling rises enough that overlap dominates.

## Limits

- Single-node kind, in-cluster loopback, mock payments, memory-backed
  workspace.
- The projection is a model; it is not a substitute for a real pipelined
  implementation.
- The probe leaves no sessions, Pods, or reservations behind.
